import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatTokenCount } from "../../lib/claude";
import type { StatusMessage } from "../../lib/settingsSchema";
import type { CliKind } from "../../types/session";
import { Dropdown } from "../Dropdown/Dropdown";
import "./PluginsPane.css";

// ── Types ────────────────────────────────────────────────────────────────

type PluginsMap = Record<string, boolean>;

interface InstalledPlugin {
  id: string;
  version?: string;
  scope?: string;
  enabled: boolean;
  installPath?: string;
  installedAt?: string;
  lastUpdated?: string;
}

interface AvailablePlugin {
  pluginId: string;
  name: string;
  description?: string;
  marketplaceName?: string;
  version?: string;
  installCount?: number;
}

interface PluginListResult {
  installed?: InstalledPlugin[];
  available?: AvailablePlugin[];
}

interface PluginsTabProps {
  visible: boolean;
  projectDir: string;
  cli: CliKind;
  onStatus: (msg: StatusMessage | null) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Normalize enabledPlugins from either array or object format to Record<string, boolean>. */
export function normalizePlugins(raw: unknown): PluginsMap {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const map: PluginsMap = {};
    for (const name of raw) {
      if (typeof name === "string") map[name] = true;
    }
    return map;
  }
  if (typeof raw === "object") {
    const map: PluginsMap = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      map[k] = v === true;
    }
    return map;
  }
  return {};
}

function formatInstallCount(n: number | undefined): string {
  if (!n) return "";
  return formatTokenCount(n);
}

/** Color class for install count popularity tier. */
function installsClass(n: number | undefined): string {
  if (!n || n <= 0) return "";
  if (n >= 10_000) return "plugin-installs-hot";
  if (n >= 1_000) return "plugin-installs-warm";
  return "plugin-installs-cool";
}

type SortBy = "downloads" | "name";

function sortPlugins<T extends { pluginId?: string; name?: string; id?: string; installCount?: number }>(
  list: T[],
  sortBy: SortBy,
): T[] {
  const sorted = [...list];
  if (sortBy === "name") {
    sorted.sort((a, b) => {
      const an = (a.name || a.pluginId || a.id || "").toLowerCase();
      const bn = (b.name || b.pluginId || b.id || "").toLowerCase();
      return an.localeCompare(bn);
    });
  } else {
    // downloads desc
    sorted.sort((a, b) => (b.installCount ?? 0) - (a.installCount ?? 0));
  }
  return sorted;
}

// [CM-16] CLI-driven plugin manager: single-pane, installed cards with toggle, marketplace grid

export function PluginsTab({ visible, projectDir, cli, onStatus }: PluginsTabProps) {
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [available, setAvailable] = useState<AvailablePlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingOp, setPendingOp] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState("");
  const [scopeFilter, setScopeFilter] = useState<"all" | "user" | "project">("all");
  const [sortBy, setSortBy] = useState<SortBy>("downloads");

  // Lookup map: available plugin data by pluginId (for enriching installed tiles)
  const availableLookup = useMemo(() => {
    const map = new Map<string, AvailablePlugin>();
    for (const p of available) map.set(p.pluginId, p);
    return map;
  }, [available]);

  const loadPlugins = useCallback(async () => {
    try {
      if (cli === "codex") {
        const result = await invoke<InstalledPlugin[]>("read_codex_plugins", { workingDir: projectDir });
        setInstalled(result || []);
        setAvailable([]);
        setError(null);
        setLoading(false);
        return;
      }

      const raw = await invoke<string>("plugin_list");
      let result: PluginListResult;
      try {
        result = raw ? JSON.parse(raw) : {};
      } catch (parseErr) {
        console.error("[plugin_list] JSON.parse failed", {
          bytes: raw?.length ?? 0,
          head: raw?.slice(0, 200),
          tail: raw?.slice(-200),
          error: String(parseErr),
        });
        throw parseErr;
      }
      setInstalled(result.installed || []);
      setAvailable(result.available || []);
      setError(null);
    } catch (err) {
      const msg = String(err);
      if (msg.includes("Failed to run") || msg.includes("plugin list failed")) {
        setError("Plugin management requires a newer Claude CLI version.");
      } else {
        setError(msg);
      }
    }
    setLoading(false);
  }, [cli, projectDir]);

  useEffect(() => {
    loadPlugins();
  }, [loadPlugins]);

  // Re-fetch when tab becomes visible (prevents stale data in keep-alive mount)
  const prevVisibleRef = useRef(visible);
  useEffect(() => {
    if (visible && !prevVisibleRef.current) {
      loadPlugins();
    }
    prevVisibleRef.current = visible;
  }, [visible, loadPlugins]);

  const doPluginOp = useCallback(async (
    opName: string,
    pluginId: string,
    op: () => Promise<unknown>,
  ) => {
    setPendingOp(pluginId);
    try {
      await op();
      onStatus({ text: `${opName} successful`, type: "success" });
      setTimeout(() => onStatus(null), 2000);
      await loadPlugins();
    } catch (err) {
      onStatus({ text: `${opName} failed: ${err}`, type: "error" });
    }
    setPendingOp(null);
  }, [loadPlugins, onStatus]);

  const handleInstall = useCallback((name: string) => {
    if (cli === "codex") return;
    const scope = scopeFilter === "all" ? "user" : scopeFilter;
    doPluginOp("Install", name, () => invoke<string>("plugin_install", { name, scope }));
  }, [cli, doPluginOp, scopeFilter]);

  const handleUninstall = useCallback((plugin: InstalledPlugin) => {
    if (cli === "codex") {
      const scope = plugin.scope || "user";
      doPluginOp("Remove", plugin.id, () => invoke("remove_codex_plugin_config", {
        id: plugin.id,
        scope,
        workingDir: scope === "project" ? projectDir : "",
      }));
      return;
    }
    doPluginOp("Uninstall", plugin.id, () => invoke<string>("plugin_uninstall", { name: plugin.id }));
  }, [cli, doPluginOp, projectDir]);

  const handleEnable = useCallback((plugin: InstalledPlugin) => {
    if (cli === "codex") {
      const scope = plugin.scope || "user";
      doPluginOp("Enable", plugin.id, () => invoke("set_codex_plugin_enabled", {
        id: plugin.id,
        scope,
        workingDir: scope === "project" ? projectDir : "",
        enabled: true,
      }));
      return;
    }
    doPluginOp("Enable", plugin.id, () => invoke<string>("plugin_enable", { name: plugin.id }));
  }, [cli, doPluginOp, projectDir]);

  const handleDisable = useCallback((plugin: InstalledPlugin) => {
    if (cli === "codex") {
      const scope = plugin.scope || "user";
      doPluginOp("Disable", plugin.id, () => invoke("set_codex_plugin_enabled", {
        id: plugin.id,
        scope,
        workingDir: scope === "project" ? projectDir : "",
        enabled: false,
      }));
      return;
    }
    doPluginOp("Disable", plugin.id, () => invoke<string>("plugin_disable", { name: plugin.id }));
  }, [cli, doPluginOp, projectDir]);

  // Filter by scope, then sort: enabled first, then alphabetical
  const sortedInstalled = useMemo(() => {
    const filtered = scopeFilter === "all"
      ? [...installed]
      : installed.filter((p) => p.scope === scopeFilter);
    filtered.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.id.toLowerCase().localeCompare(b.id.toLowerCase());
    });
    return filtered;
  }, [installed, scopeFilter]);

  // Filter & sort marketplace plugins (exclude already-installed)
  const installedIds = useMemo(() => new Set(installed.map((p) => p.id)), [installed]);
  const filteredAvailable = useMemo(() => {
    const filtered = available.filter((p) => {
      if (installedIds.has(p.pluginId)) return false;
      if (!searchFilter) return true;
      const q = searchFilter.toLowerCase();
      return (
        p.name.toLowerCase().includes(q) ||
        p.pluginId.toLowerCase().includes(q) ||
        (p.description || "").toLowerCase().includes(q)
      );
    });
    return sortPlugins(filtered, sortBy);
  }, [available, installedIds, searchFilter, sortBy]);

  if (loading) {
    return <div className="plugins-tab" style={{ display: visible ? undefined : "none" }}><div className="pane-hint">Loading plugins...</div></div>;
  }

  return (
    <div className="plugins-tab" style={{ display: visible ? undefined : "none" }}>
      {/* Error banner */}
      {error && (
        <div className="plugins-error">{error}</div>
      )}

      {/* Scope filter */}
      {!error && (
        <div className="plugins-marketplace-controls">
          <Dropdown
            className="config-select"
            value={scopeFilter}
            onChange={(v) => setScopeFilter(v as "all" | "user" | "project")}
            ariaLabel="Plugin scope"
            options={[
              { value: "all", label: "All scopes" },
              { value: "user", label: "User scope" },
              { value: "project", label: "Project scope" },
            ]}
          />
        </div>
      )}

      {/* Installed Plugins */}
      {!error && (
        <div className="plugins-section">
          <div className="plugins-section-title">
            Installed Plugins{scopeFilter !== "all" && ` (${scopeFilter})`}
          </div>
          {sortedInstalled.length > 0 ? (
            <div className="plugins-grid">
              {sortedInstalled.map((plugin) => {
                const isPending = pendingOp === plugin.id;
                const info = availableLookup.get(plugin.id);
                const count = info?.installCount;
                const cls = installsClass(count);
                return (
                  <div key={plugin.id} className={`plugin-tile${isPending ? " plugin-tile-pending" : ""}${!plugin.enabled ? " plugin-tile-disabled" : ""}`}>
                    <div className="plugin-tile-header">
                      <span className="plugin-tile-name">{plugin.id}</span>
                      {count != null && count > 0 && (
                        <span className={`plugin-tile-installs${cls ? ` ${cls}` : ""}`}>
                          {formatInstallCount(count)}
                        </span>
                      )}
                    </div>
                    {info?.description && (
                      <div className="plugin-tile-desc">{info.description}</div>
                    )}
                    <div className="plugin-tile-footer">
                      <div className="plugin-tile-meta">
                        {plugin.version && <span className="plugin-tile-version">v{plugin.version}</span>}
                        {plugin.scope && (
                          <span className={`plugin-scope-badge plugin-scope-${plugin.scope}`}>
                            {plugin.scope}
                          </span>
                        )}
                      </div>
                      <div className="plugin-tile-actions">
                        <button
                          className={`plugin-toggle-track${plugin.enabled ? " plugin-toggle-on" : ""}`}
                          onClick={() => plugin.enabled ? handleDisable(plugin) : handleEnable(plugin)}
                          disabled={!!pendingOp}
                          title={plugin.enabled ? "Disable" : "Enable"}
                        >
                          <span className="plugin-toggle-thumb" />
                        </button>
                        <button
                          className="hook-card-btn hook-card-btn-delete"
                          onClick={() => handleUninstall(plugin)}
                          disabled={!!pendingOp}
                        >
                          Del
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="pane-hint">{scopeFilter === "all" ? "No plugins installed" : `No ${scopeFilter}-scope plugins installed`}</div>
          )}
        </div>
      )}

      {/* Marketplace */}
      {!error && cli === "claude" && (
        <div className="plugins-section">
          <div className="plugins-section-title">
            Marketplace
            {available.length > 0 && (
              <span className="plugins-marketplace-count">{available.length} available</span>
            )}
          </div>

          <div className="plugins-marketplace-controls">
            <input
              className="marketplace-search"
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder="Filter plugins..."
            />
            <Dropdown
              className="config-select"
              value={sortBy}
              onChange={(v) => setSortBy(v as SortBy)}
              ariaLabel="Sort plugins by"
              options={[
                { value: "downloads", label: "Most popular" },
                { value: "name", label: "A-Z" },
              ]}
            />
          </div>

          {filteredAvailable.length > 0 ? (
            <div className="plugins-grid">
              {filteredAvailable.map((plugin) => {
                const isPending = pendingOp === plugin.pluginId;
                const count = plugin.installCount;
                const cls = installsClass(count);
                return (
                  <div key={plugin.pluginId} className={`plugin-tile${isPending ? " plugin-tile-pending" : ""}`}>
                    <div className="plugin-tile-header">
                      <span className="plugin-tile-name">{plugin.name || plugin.pluginId}</span>
                      {count != null && count > 0 && (
                        <span className={`plugin-tile-installs${cls ? ` ${cls}` : ""}`}>
                          {formatInstallCount(count)}
                        </span>
                      )}
                    </div>
                    {plugin.description && (
                      <div className="plugin-tile-desc">{plugin.description}</div>
                    )}
                    <div className="plugin-tile-footer">
                      <div className="plugin-tile-meta">
                        {plugin.version && <span className="plugin-tile-version">v{plugin.version}</span>}
                      </div>
                      <button
                        className="plugin-install-btn"
                        onClick={() => handleInstall(plugin.pluginId)}
                        disabled={!!pendingOp}
                      >
                        Install
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="pane-hint">
              {searchFilter ? "No matching plugins" : "No additional plugins available"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

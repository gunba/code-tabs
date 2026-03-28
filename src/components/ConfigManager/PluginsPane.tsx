import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatTokenCount } from "../../lib/claude";
import type { StatusMessage } from "../../lib/settingsSchema";

// ── Types ────────────────────────────────────────────────────────────────

interface McpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

type PluginsMap = Record<string, boolean>;

interface InstalledPlugin {
  id: string;
  version?: string;
  scope?: string;
  enabled: boolean;
  installPath?: string;
  installedAt?: string;
  lastUpdated?: string;
  mcpServers?: Record<string, unknown>;
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

// ── Component ────────────────────────────────────────────────────────────

export function PluginsTab({ visible, projectDir: _projectDir, onStatus }: PluginsTabProps) {
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [available, setAvailable] = useState<AvailablePlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingOp, setPendingOp] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState("");
  const [installScope, setInstallScope] = useState<"user" | "project">("user");
  const [sortBy, setSortBy] = useState<SortBy>("downloads");

  // MCP Servers from settings.json (manual config, not CLI-managed)
  const [mcpServers, setMcpServers] = useState<Record<string, McpServer>>({});
  const [mcpDirty, setMcpDirty] = useState(false);

  // Lookup map: available plugin data by pluginId (for enriching installed tiles)
  const availableLookup = useMemo(() => {
    const map = new Map<string, AvailablePlugin>();
    for (const p of available) map.set(p.pluginId, p);
    return map;
  }, [available]);

  const loadPlugins = useCallback(async () => {
    try {
      const raw = await invoke<string>("plugin_list");
      const result: PluginListResult = raw ? JSON.parse(raw) : {};
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
  }, []);

  const loadMcpServers = useCallback(async () => {
    try {
      const result = await invoke<string>("read_config_file", {
        scope: "user",
        workingDir: "",
        fileType: "settings",
      });
      const parsed = result ? JSON.parse(result) : {};
      setMcpServers((parsed.mcpServers as Record<string, McpServer>) || {});
    } catch {
      // Fine — no settings file
    }
  }, []);

  useEffect(() => {
    loadPlugins();
    loadMcpServers();
  }, [loadPlugins, loadMcpServers]);

  // Re-fetch when tab becomes visible (prevents stale data in keep-alive mount)
  const prevVisibleRef = useRef(visible);
  useEffect(() => {
    if (visible && !prevVisibleRef.current) {
      loadPlugins();
      loadMcpServers();
    }
    prevVisibleRef.current = visible;
  }, [visible, loadPlugins, loadMcpServers]);

  const doPluginOp = useCallback(async (
    opName: string,
    pluginId: string,
    op: () => Promise<string>,
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
    doPluginOp("Install", name, () => invoke<string>("plugin_install", { name, scope: installScope }));
  }, [doPluginOp, installScope]);

  const handleUninstall = useCallback((name: string) => {
    doPluginOp("Uninstall", name, () => invoke<string>("plugin_uninstall", { name }));
  }, [doPluginOp]);

  const handleEnable = useCallback((name: string) => {
    doPluginOp("Enable", name, () => invoke<string>("plugin_enable", { name }));
  }, [doPluginOp]);

  const handleDisable = useCallback((name: string) => {
    doPluginOp("Disable", name, () => invoke<string>("plugin_disable", { name }));
  }, [doPluginOp]);

  const removeMcpServer = useCallback(async (name: string) => {
    const updated = { ...mcpServers };
    delete updated[name];
    setMcpServers(updated);
    setMcpDirty(true);
  }, [mcpServers]);

  const saveMcpServers = useCallback(async () => {
    try {
      const workingDir = "";
      let current: Record<string, unknown> = {};
      try {
        const raw = await invoke<string>("read_config_file", { scope: "user", workingDir, fileType: "settings" });
        if (raw) current = JSON.parse(raw);
      } catch { /* empty file */ }

      if (Object.keys(mcpServers).length > 0) {
        current.mcpServers = mcpServers;
      } else {
        delete current.mcpServers;
      }

      await invoke("write_config_file", {
        scope: "user",
        workingDir,
        fileType: "settings",
        content: JSON.stringify(current, null, 2),
      });
      setMcpDirty(false);
      onStatus({ text: "MCP servers saved", type: "success" });
      setTimeout(() => onStatus(null), 2000);
    } catch (err) {
      onStatus({ text: `Save failed: ${err}`, type: "error" });
    }
  }, [mcpServers, onStatus]);

  // Sort installed plugins: enabled first, then alphabetical
  const sortedInstalled = useMemo(() => {
    const sorted = [...installed];
    sorted.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.id.toLowerCase().localeCompare(b.id.toLowerCase());
    });
    return sorted;
  }, [installed]);

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

      {/* Installed Plugins */}
      {!error && (
        <div className="plugins-section">
          <div className="plugins-section-title">Installed Plugins</div>
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
                          onClick={() => plugin.enabled ? handleDisable(plugin.id) : handleEnable(plugin.id)}
                          disabled={!!pendingOp}
                          title={plugin.enabled ? "Disable" : "Enable"}
                        >
                          <span className="plugin-toggle-thumb" />
                        </button>
                        <button
                          className="hook-card-btn hook-card-btn-delete"
                          onClick={() => handleUninstall(plugin.id)}
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
            <div className="pane-hint">No plugins installed</div>
          )}
        </div>
      )}

      {/* Marketplace */}
      {!error && (
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
            <select
              className="config-select"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortBy)}
            >
              <option value="downloads">Most popular</option>
              <option value="name">A-Z</option>
            </select>
            <select
              className="config-select"
              value={installScope}
              onChange={(e) => setInstallScope(e.target.value as "user" | "project")}
            >
              <option value="user">User scope</option>
              <option value="project">Project scope</option>
            </select>
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

      {/* MCP Servers (manual, from settings.json) */}
      <div className="plugins-section">
        <div className="plugins-section-title">MCP Servers</div>
        {Object.keys(mcpServers).length > 0 ? (
          Object.entries(mcpServers).map(([name, server]) => (
            <div key={name} className="mcp-card">
              <div className="mcp-card-header">
                <span className="mcp-card-name">{name}</span>
                <button className="hook-card-btn hook-card-btn-delete" onClick={() => removeMcpServer(name)}>Del</button>
              </div>
              <div className="hook-detail">
                <span className="hook-detail-label">Cmd:</span>
                <span className="hook-detail-value">{server.command} {server.args?.join(" ") || ""}</span>
              </div>
              {server.env && Object.keys(server.env).length > 0 && (
                <div className="hook-detail">
                  <span className="hook-detail-label">Env:</span>
                  <span className="hook-detail-value">{Object.keys(server.env).join(", ")}</span>
                </div>
              )}
            </div>
          ))
        ) : (
          <div className="pane-hint">None configured</div>
        )}
        {mcpDirty && (
          <div className="pane-footer">
            <button className="pane-save-btn" onClick={saveMcpServers}>Save MCP</button>
          </div>
        )}
      </div>
    </div>
  );
}

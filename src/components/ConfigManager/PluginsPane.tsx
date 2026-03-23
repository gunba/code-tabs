import { useState, useEffect, useCallback } from "react";
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

// ── Component ────────────────────────────────────────────────────────────

export function PluginsTab({ projectDir: _projectDir, onStatus }: PluginsTabProps) {
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [available, setAvailable] = useState<AvailablePlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingOp, setPendingOp] = useState<string | null>(null); // plugin id being operated on
  const [searchFilter, setSearchFilter] = useState("");
  const [installScope, setInstallScope] = useState<"user" | "project">("user");
  const [marketplaceOpen, setMarketplaceOpen] = useState(true);

  // MCP Servers from settings.json (manual config, not CLI-managed)
  const [mcpServers, setMcpServers] = useState<Record<string, McpServer>>({});
  const [mcpDirty, setMcpDirty] = useState(false);

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

  // Filter marketplace plugins (exclude already-installed)
  const installedIds = new Set(installed.map((p) => p.id));
  const filteredAvailable = available.filter((p) => {
    if (installedIds.has(p.pluginId)) return false;
    if (!searchFilter) return true;
    const q = searchFilter.toLowerCase();
    return (
      p.name.toLowerCase().includes(q) ||
      p.pluginId.toLowerCase().includes(q) ||
      (p.description || "").toLowerCase().includes(q)
    );
  });

  if (loading) {
    return <div className="plugins-tab"><div className="pane-hint">Loading plugins...</div></div>;
  }

  return (
    <div className="plugins-tab">
      {/* Error banner */}
      {error && (
        <div className="plugins-error">{error}</div>
      )}

      {/* Installed Plugins */}
      {!error && (
        <div className="plugins-section">
          <div className="plugins-section-title">Installed Plugins</div>
          {installed.length > 0 ? (
            <div className="plugins-installed-list">
              {installed.map((plugin) => {
                const isPending = pendingOp === plugin.id;
                return (
                  <div key={plugin.id} className={`plugin-card${isPending ? " plugin-card-pending" : ""}`}>
                    <div className="plugin-card-header">
                      <div className="plugin-card-info">
                        <span className="plugin-card-name">{plugin.id}</span>
                        {plugin.version && <span className="plugin-card-version">v{plugin.version}</span>}
                        {plugin.scope && (
                          <span className={`plugin-scope-badge plugin-scope-${plugin.scope}`}>
                            {plugin.scope}
                          </span>
                        )}
                      </div>
                      <div className="plugin-card-actions">
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
          <button
            className="plugins-marketplace-toggle"
            onClick={() => setMarketplaceOpen(!marketplaceOpen)}
          >
            <span className="plugins-marketplace-arrow">{marketplaceOpen ? "\u25BC" : "\u25B6"}</span>
            Marketplace
            {available.length > 0 && (
              <span className="plugins-marketplace-count">{available.length} available</span>
            )}
          </button>

          {marketplaceOpen && (
            <>
              <div className="plugins-marketplace-controls">
                <input
                  className="marketplace-search"
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                  placeholder="Filter plugins..."
                />
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
                <div className="marketplace-grid">
                  {filteredAvailable.map((plugin) => {
                    const isPending = pendingOp === plugin.pluginId;
                    return (
                      <div key={plugin.pluginId} className={`marketplace-card${isPending ? " plugin-card-pending" : ""}`}>
                        <div className="marketplace-card-header">
                          <span className="marketplace-card-name">{plugin.name || plugin.pluginId}</span>
                          {plugin.installCount != null && plugin.installCount > 0 && (
                            <span className="marketplace-card-installs">{formatInstallCount(plugin.installCount)} installs</span>
                          )}
                        </div>
                        {plugin.description && (
                          <div className="marketplace-card-desc">{plugin.description}</div>
                        )}
                        <div className="marketplace-card-footer">
                          {plugin.version && <span className="plugin-card-version">v{plugin.version}</span>}
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
            </>
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

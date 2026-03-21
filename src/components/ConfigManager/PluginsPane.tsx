import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PaneComponentProps } from "./ThreePaneEditor";

interface McpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export function PluginsPane({ scope, projectDir, onStatus }: PaneComponentProps) {
  const [json, setJson] = useState<Record<string, unknown>>({});
  const [saved, setSaved] = useState<string>("{}");
  const [loading, setLoading] = useState(true);
  const [newPlugin, setNewPlugin] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await invoke<string>("read_config_file", {
        scope,
        workingDir: scope === "user" ? "" : projectDir,
        fileType: "settings",
      });
      const parsed = result ? JSON.parse(result) : {};
      setJson(parsed);
      setSaved(JSON.stringify(parsed, null, 2));
    } catch {
      setJson({});
      setSaved("{}");
    }
    setLoading(false);
  }, [scope, projectDir]);

  useEffect(() => { load(); }, [load]);

  const handleSave = useCallback(async () => {
    try {
      // Re-read current settings to avoid clobbering SettingsPane edits
      const workingDir = scope === "user" ? "" : projectDir;
      let current: Record<string, unknown> = {};
      try {
        const raw = await invoke<string>("read_config_file", { scope, workingDir, fileType: "settings" });
        if (raw) current = JSON.parse(raw);
      } catch { /* empty file is fine */ }

      // Merge only plugin keys into the fresh base
      const merged = { ...current };
      if (json.enabledPlugins) merged.enabledPlugins = json.enabledPlugins;
      else delete merged.enabledPlugins;
      if (json.mcpServers) merged.mcpServers = json.mcpServers;
      else delete merged.mcpServers;

      await invoke("write_config_file", {
        scope,
        workingDir,
        fileType: "settings",
        content: JSON.stringify(merged, null, 2),
      });
      setJson(merged);
      setSaved(JSON.stringify(merged, null, 2));
      onStatus({ text: "Plugins saved", type: "success" });
      setTimeout(() => onStatus(null), 2000);
    } catch (err) {
      onStatus({ text: `Save failed: ${err}`, type: "error" });
    }
  }, [json, scope, projectDir, onStatus]);

  const enabledPlugins = (json.enabledPlugins as string[] | undefined) || [];
  const mcpServers = (json.mcpServers as Record<string, McpServer> | undefined) || {};
  const dirty = JSON.stringify(json, null, 2) !== saved;

  const addPlugin = () => {
    const trimmed = newPlugin.trim();
    if (!trimmed || enabledPlugins.includes(trimmed)) return;
    setJson((prev) => ({ ...prev, enabledPlugins: [...enabledPlugins, trimmed] }));
    setNewPlugin("");
  };

  const removePlugin = (idx: number) => {
    const next = enabledPlugins.filter((_, i) => i !== idx);
    setJson((prev) => {
      const updated = { ...prev };
      if (next.length > 0) updated.enabledPlugins = next;
      else delete updated.enabledPlugins;
      return updated;
    });
  };

  const removeMcpServer = (name: string) => {
    setJson((prev) => {
      const updated = { ...prev };
      const servers = { ...(updated.mcpServers as Record<string, McpServer> || {}) };
      delete servers[name];
      if (Object.keys(servers).length > 0) updated.mcpServers = servers;
      else delete updated.mcpServers;
      return updated;
    });
  };

  if (loading) return <div className="pane-hint">Loading...</div>;

  return (
    <div className="plugins-pane">
      {/* Enabled Plugins */}
      <div className="plugins-section">
        <div className="plugins-section-title">Enabled Plugins</div>
        {enabledPlugins.length > 0 ? (
          <div className="plugins-tags">
            {enabledPlugins.map((p, i) => (
              <span key={i} className="plugins-tag">
                {p}
                <button className="plugins-tag-remove" onClick={() => removePlugin(i)}>x</button>
              </span>
            ))}
          </div>
        ) : (
          <div className="pane-hint">None</div>
        )}
        <div className="plugins-add-row">
          <input
            className="plugins-add-input"
            value={newPlugin}
            onChange={(e) => setNewPlugin(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addPlugin(); }}
            placeholder="plugin-name"
          />
          <button className="plugins-add-btn" onClick={addPlugin}>+</button>
        </div>
      </div>

      {/* MCP Servers */}
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
      </div>

      <div className="pane-footer">
        <button className="pane-save-btn" onClick={handleSave} disabled={!dirty}>
          {dirty ? "Save" : "Saved"}
        </button>
      </div>
    </div>
  );
}

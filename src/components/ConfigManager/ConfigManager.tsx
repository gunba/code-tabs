import { useState, useEffect, useMemo } from "react";
import { useSessionStore } from "../../store/sessions";
import { useSettingsStore } from "../../store/settings";
import { ModalOverlay } from "../ModalOverlay/ModalOverlay";
import { ThreePaneEditor } from "./ThreePaneEditor";
import { SettingsPane } from "./SettingsPane";
import { MarkdownPane } from "./MarkdownPane";
import { HooksPane } from "./HooksPane";
import { PluginsPane } from "./PluginsPane";
import { AgentEditor } from "./AgentEditor";
import type { StatusMessage } from "../../lib/settingsSchema";
import "./ConfigManager.css";

type Tab = "settings" | "claudemd" | "hooks" | "plugins" | "agents";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "settings", label: "Settings", icon: "⚙" },
  { id: "claudemd", label: "CLAUDE.md", icon: "📄" },
  { id: "hooks", label: "Hooks", icon: "⚓" },
  { id: "plugins", label: "Plugins", icon: "🧩" },
  { id: "agents", label: "Agents", icon: "🤖" },
];

export function ConfigManager() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const showConfigManager = useSettingsStore((s) => s.showConfigManager);
  const setShowConfigManager = useSettingsStore((s) => s.setShowConfigManager);
  const [tab, setTab] = useState<Tab>((showConfigManager || "settings") as Tab);
  const [projectDir, setProjectDir] = useState("");
  const [statusMsg, setStatusMsg] = useState<StatusMessage | null>(null);

  // Sync tab from store when opened with a specific tab
  useEffect(() => {
    if (showConfigManager && showConfigManager !== tab) {
      const valid = TABS.some((t) => t.id === showConfigManager);
      if (valid) setTab(showConfigManager as Tab);
    }
  }, [showConfigManager]); // eslint-disable-line react-hooks/exhaustive-deps

  // Unique project dirs from sessions
  const projectDirs = useMemo(() => Array.from(
    new Set(
      sessions
        .filter((s) => !s.isMetaAgent && s.config.workingDir)
        .map((s) => s.config.workingDir)
    )
  ), [sessions]);

  // Default to active session's working dir
  useEffect(() => {
    if (!projectDir) {
      const activeSession = sessions.find((s) => s.id === activeTabId);
      const activeDir = activeSession?.config.workingDir;
      if (activeDir) setProjectDir(activeDir);
      else if (projectDirs.length > 0) setProjectDir(projectDirs[0]);
    }
  }, [projectDir, activeTabId, sessions, projectDirs]);

  const onClose = () => setShowConfigManager(false);

  return (
    <ModalOverlay onClose={onClose} className="config-modal">
      {/* Header with tabs */}
      <div className="config-header">
        <div className="config-header-left">
          <span className="config-title">Config</span>
          <div className="config-tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`config-tab${tab === t.id ? " config-tab-active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                <span className="config-tab-icon">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="config-header-right">
          {/* Project dir selector — only when multiple dirs exist */}
          {projectDirs.length > 1 && (
            <select
              className="config-select config-project-select"
              value={projectDir}
              onChange={(e) => setProjectDir(e.target.value)}
            >
              {projectDirs.map((dir) => (
                <option key={dir} value={dir}>{dir}</option>
              ))}
            </select>
          )}
          <button className="config-close" onClick={onClose} title="Close (Esc)">
            ×
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="config-content">
        {tab === "settings" && (
          <ThreePaneEditor component={SettingsPane} projectDir={projectDir} onStatus={setStatusMsg} />
        )}
        {tab === "claudemd" && (
          <ThreePaneEditor component={MarkdownPane} projectDir={projectDir} onStatus={setStatusMsg} />
        )}
        {tab === "hooks" && (
          <ThreePaneEditor component={HooksPane} projectDir={projectDir} onStatus={setStatusMsg} />
        )}
        {tab === "plugins" && (
          <ThreePaneEditor component={PluginsPane} projectDir={projectDir} onStatus={setStatusMsg} />
        )}
        {tab === "agents" && (
          <AgentEditor projectDir={projectDir} onStatus={setStatusMsg} />
        )}
      </div>

      {/* Footer */}
      {statusMsg && (
        <div className="config-footer">
          <span className={`config-status config-status-${statusMsg.type}`}>
            {statusMsg.text}
          </span>
        </div>
      )}
    </ModalOverlay>
  );
}

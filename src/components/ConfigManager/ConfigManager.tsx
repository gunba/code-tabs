import { useState, useEffect, useMemo } from "react";
import { useSessionStore } from "../../store/sessions";
import { useSettingsStore } from "../../store/settings";
import { ModalOverlay } from "../ModalOverlay/ModalOverlay";
import { ThreePaneEditor } from "./ThreePaneEditor";
import { SettingsTab } from "./SettingsTab";
import { MarkdownPane } from "./MarkdownPane";
import { HooksPane } from "./HooksPane";
import { PluginsTab } from "./PluginsPane";
import { AgentEditor } from "./AgentEditor";
import { PromptsTab } from "./PromptsTab";
import { SkillsEditor } from "./SkillsEditor";
import { IconGear, IconDocument, IconHook, IconPuzzle, IconBot, IconSkill, IconClose } from "../Icons/Icons";
import type { StatusMessage } from "../../lib/settingsSchema";
import "./ConfigManager.css";

type Tab = "settings" | "claudemd" | "hooks" | "plugins" | "agents" | "prompts" | "skills";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "settings", label: "Settings", icon: <IconGear size={11} /> },
  { id: "claudemd", label: "Claude", icon: <IconDocument size={11} /> },
  { id: "hooks", label: "Hooks", icon: <IconHook size={11} /> },
  { id: "plugins", label: "Plugins", icon: <IconPuzzle size={11} /> },
  { id: "agents", label: "Agents", icon: <IconBot size={11} /> },
  { id: "prompts", label: "Prompts", icon: <IconDocument size={11} /> },
  { id: "skills", label: "Skills", icon: <IconSkill size={11} /> },
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
            <IconClose size={14} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="config-content">
        {tab === "settings" && (
          <SettingsTab projectDir={projectDir} onStatus={setStatusMsg} />
        )}
        {tab === "claudemd" && (
          <ThreePaneEditor component={MarkdownPane} projectDir={projectDir} onStatus={setStatusMsg} tabId="claudemd" />
        )}
        {tab === "hooks" && (
          <ThreePaneEditor component={HooksPane} projectDir={projectDir} onStatus={setStatusMsg} tabId="hooks" />
        )}
        <PluginsTab visible={tab === "plugins"} projectDir={projectDir} onStatus={setStatusMsg} />
        {tab === "agents" && (
          <ThreePaneEditor component={AgentEditor} projectDir={projectDir} onStatus={setStatusMsg} tabId="agents" />
        )}
        {tab === "prompts" && (
          <PromptsTab onStatus={setStatusMsg} />
        )}
        {tab === "skills" && (
          <ThreePaneEditor component={SkillsEditor} projectDir={projectDir} onStatus={setStatusMsg} tabId="skills" />
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

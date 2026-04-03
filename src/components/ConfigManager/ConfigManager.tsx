import { useState, useEffect, useMemo } from "react";
import { useSessionStore } from "../../store/sessions";
import { useSettingsStore } from "../../store/settings";
import { ModalOverlay } from "../ModalOverlay/ModalOverlay";
import { ThreePaneEditor } from "./ThreePaneEditor";
import { SettingsTab } from "./SettingsTab";
import { EnvVarsTab } from "./EnvVarsTab";
import { MarkdownPane } from "./MarkdownPane";
import { HooksPane } from "./HooksPane";
import { PluginsTab } from "./PluginsPane";
import { AgentEditor } from "./AgentEditor";
import { PromptsTab } from "./PromptsTab";
import { SkillsEditor } from "./SkillsEditor";
import { ProvidersPane } from "./ProvidersPane";
import { IconGear, IconDocument, IconHook, IconPuzzle, IconBot, IconSkill, IconLightning, IconBraces, IconClose, IconCircleFilled } from "../Icons/Icons";
import { RecordingPane } from "./RecordingPane";
import { parseWorktreePath } from "../../lib/paths";
import type { StatusMessage } from "../../lib/settingsSchema";
import "./ConfigManager.css";

type Tab = "settings" | "envvars" | "claudemd" | "hooks" | "plugins" | "agents" | "prompts" | "skills" | "providers" | "recording";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "settings", label: "Settings", icon: <IconGear size={11} /> },
  { id: "envvars", label: "Env Vars", icon: <IconBraces size={11} /> },
  { id: "claudemd", label: "Claude", icon: <IconDocument size={11} /> },
  { id: "hooks", label: "Hooks", icon: <IconHook size={11} /> },
  { id: "plugins", label: "Plugins", icon: <IconPuzzle size={11} /> },
  { id: "agents", label: "Agents", icon: <IconBot size={11} /> },
  { id: "prompts", label: "Prompts", icon: <IconDocument size={11} /> },
  { id: "skills", label: "Skills", icon: <IconSkill size={11} /> },
  { id: "providers", label: "Providers", icon: <IconLightning size={11} /> },
  { id: "recording", label: "Recording", icon: <IconCircleFilled size={11} /> },
];

// [CM-11] 9-tab config modal (84vw, max 1500px, 78vh), store-controlled active tab
// [CM-05] Tab routing: ThreePaneEditor (2 or 3 col), dedicated single-pane, or keep-alive
// [CM-18] Inline SVG icons per tab — monochrome, cross-platform
// [CM-20] Tab label "Claude" (not "CLAUDE.md")
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

  // Unique project dirs from sessions — resolve worktrees to their project root
  const projectDirs = useMemo(() => Array.from(
    new Set(
      sessions
        .filter((s) => !s.isMetaAgent && s.config.workingDir)
        .map((s) => {
          const wt = parseWorktreePath(s.config.workingDir);
          return wt ? wt.projectRoot : s.config.workingDir;
        })
    )
  ), [sessions]);

  // Default to active session's working dir (resolve worktrees to project root)
  useEffect(() => {
    if (!projectDir) {
      const activeSession = sessions.find((s) => s.id === activeTabId);
      const rawDir = activeSession?.config.workingDir;
      if (rawDir) {
        const wt = parseWorktreePath(rawDir);
        setProjectDir(wt ? wt.projectRoot : rawDir);
      } else if (projectDirs.length > 0) {
        setProjectDir(projectDirs[0]);
      }
    }
  }, [projectDir, activeTabId, sessions, projectDirs]);

  const onClose = () => setShowConfigManager(false);

  return (
    <ModalOverlay onClose={onClose} className="config-modal">
      {/* [CM-04] [CM-09] keystroke isolation + Escape/overlay close */}
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
        {tab === "envvars" && (
          <EnvVarsTab projectDir={projectDir} onStatus={setStatusMsg} />
        )}
        {tab === "claudemd" && (
          <ThreePaneEditor component={MarkdownPane} projectDir={projectDir} onStatus={setStatusMsg} tabId="claudemd" />
        )}
        {tab === "hooks" && (
          <ThreePaneEditor component={HooksPane} projectDir={projectDir} onStatus={setStatusMsg} tabId="hooks" />
        )}
        <PluginsTab visible={tab === "plugins"} projectDir={projectDir} onStatus={setStatusMsg} />
        {tab === "agents" && (
          <ThreePaneEditor component={AgentEditor} projectDir={projectDir} onStatus={setStatusMsg} tabId="agents" scopes={["user", "project"]} />
        )}
        {tab === "prompts" && (
          <PromptsTab onStatus={setStatusMsg} />
        )}
        {tab === "skills" && (
          <ThreePaneEditor component={SkillsEditor} projectDir={projectDir} onStatus={setStatusMsg} tabId="skills" scopes={["user", "project"]} />
        )}
        <ProvidersPane visible={tab === "providers"} onStatus={setStatusMsg} />
        {tab === "recording" && (
          <RecordingPane onStatus={setStatusMsg} />
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

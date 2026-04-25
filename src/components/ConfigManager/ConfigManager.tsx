import { useState, useEffect, useMemo, useRef } from "react";
import { useSessionStore } from "../../store/sessions";
import { useSettingsStore } from "../../store/settings";
import { ModalOverlay } from "../ModalOverlay/ModalOverlay";
import { ThreePaneEditor } from "./ThreePaneEditor";
import { SettingsTab } from "./SettingsTab";
import { EnvVarsTab } from "./EnvVarsTab";
import { MarkdownPane } from "./MarkdownPane";
import { HooksPane } from "./HooksPane";
import { PluginsTab } from "./PluginsPane";
import { McpPane } from "./McpPane";
import { AgentEditor } from "./AgentEditor";
import { PromptsTab } from "./PromptsTab";
import { SkillsEditor } from "./SkillsEditor";
import { Dropdown } from "../Dropdown/Dropdown";
import { IconGear, IconDocument, IconHook, IconPuzzle, IconBot, IconSkill, IconBraces, IconClose, IconCircleFilled, IconServer } from "../Icons/Icons";
import { RecordingPane } from "./RecordingPane";
import { parseWorktreePath } from "../../lib/paths";
import type { StatusMessage } from "../../lib/settingsSchema";
import { useRuntimeStore } from "../../store/runtime";
import type { CliKind } from "../../types/session";
import "./ConfigManager.css";

type Tab = "settings" | "envvars" | "claudemd" | "hooks" | "plugins" | "mcp" | "agents" | "prompts" | "skills" | "recording";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "settings", label: "Settings", icon: <IconGear size={11} /> },
  { id: "envvars", label: "Env Vars", icon: <IconBraces size={11} /> },
  { id: "claudemd", label: "Instructions", icon: <IconDocument size={11} /> },
  { id: "hooks", label: "Hooks", icon: <IconHook size={11} /> },
  { id: "plugins", label: "Plugins", icon: <IconPuzzle size={11} /> },
  { id: "mcp", label: "MCP", icon: <IconServer size={11} /> },
  { id: "agents", label: "Agents", icon: <IconBot size={11} /> },
  { id: "prompts", label: "Prompts", icon: <IconDocument size={11} /> },
  { id: "skills", label: "Skills & Commands", icon: <IconSkill size={11} /> },
  { id: "recording", label: "Observability", icon: <IconCircleFilled size={11} /> },
];

// [DL-01] ConfigManager Claude/Codex switch (only when both installed); visibleTabs filtered per CLI (Codex hides envvars/Claude file-agents); shared panes own their copy/import actions; ThreePaneEditor + PaneComponentProps thread cli; SettingsPane TOML-aware for Codex; SettingsTab hides project-local for Codex; HooksPane CODEX_HOOK_EVENTS + remaps project-local->project on save
// [CM-11] 11-tab config modal (84vw, max 1500px, 78vh), store-controlled active tab
// [CM-05] Tab routing: editor tabs plus dedicated Plugins/Prompts/Providers/Recording panes; MCP/Agents/Skills use 2-col ThreePaneEditor
// [CM-18] Inline SVG icons per tab — monochrome, cross-platform
export function ConfigManager() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const claudePath = useSessionStore((s) => s.claudePath);
  const codexPath = useSessionStore((s) => s.codexPath);
  const showConfigManager = useSettingsStore((s) => s.showConfigManager);
  const setShowConfigManager = useSettingsStore((s) => s.setShowConfigManager);
  const debugBuild = useRuntimeStore((s) => s.observabilityInfo.debugBuild);
  const [tab, setTab] = useState<Tab>((showConfigManager || "settings") as Tab);
  const [configCli, setConfigCli] = useState<CliKind>(() => {
    const active = sessions.find((s) => s.id === activeTabId)?.config.cli;
    return active ?? (codexPath && !claudePath ? "codex" : "claude");
  });
  const [projectDir, setProjectDir] = useState("");
  const [statusMsg, setStatusMsg] = useState<StatusMessage | null>(null);
  const prevRequestedTabRef = useRef<typeof showConfigManager>(showConfigManager);
  const availableCliKinds = useMemo(() => {
    const kinds: CliKind[] = [];
    if (claudePath) kinds.push("claude");
    if (codexPath) kinds.push("codex");
    return kinds;
  }, [claudePath, codexPath]);

  useEffect(() => {
    if (availableCliKinds.length === 0) return;
    if (!availableCliKinds.includes(configCli)) {
      setConfigCli(availableCliKinds[0]);
    }
  }, [availableCliKinds, configCli]);

  const visibleTabs = useMemo(
    () => TABS.filter((t) => {
      if (!debugBuild && t.id === "recording") return false;
      if (configCli === "codex") {
        return !["envvars", "agents"].includes(t.id);
      }
      return true;
    }),
    [debugBuild, configCli],
  );

  // Sync tab from store when opened with a specific tab
  useEffect(() => {
    const requestedTabChanged = prevRequestedTabRef.current !== showConfigManager;
    prevRequestedTabRef.current = showConfigManager;

    if (showConfigManager && requestedTabChanged) {
      const valid = visibleTabs.some((t) => t.id === showConfigManager);
      if (valid) setTab(showConfigManager as Tab);
      else if (showConfigManager === "port") setTab("skills");
      else if (showConfigManager === "recording") setTab("settings");
    }
  }, [showConfigManager, visibleTabs]);

  // If the active tab becomes unavailable (release build hides observability), fall back.
  useEffect(() => {
    if (!visibleTabs.some((t) => t.id === tab)) {
      setTab("settings");
    }
  }, [tab, visibleTabs]);

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
  const codexTwoScopes = configCli === "codex" ? ["user", "project"] as Array<"user" | "project"> : undefined;

  return (
    <ModalOverlay onClose={onClose} className="config-modal" closeOnBackdropClick={false}>
      {/* [CM-04] [CM-09] keystroke isolation + Escape/X/Ctrl+, close */}
      {/* Header with tabs */}
      <div className="config-header">
        <div className="config-title-group">
          <span className="config-title">Config</span>
          {availableCliKinds.length > 1 ? (
            <div className="config-cli-switch" role="tablist" aria-label="Configuration target">
              <button
                className={`config-cli-switch-btn config-cli-switch-btn-claude${configCli === "claude" ? " active" : ""}`}
                onClick={() => setConfigCli("claude")}
                type="button"
              >
                Claude
              </button>
              <button
                className={`config-cli-switch-btn config-cli-switch-btn-codex${configCli === "codex" ? " active" : ""}`}
                onClick={() => setConfigCli("codex")}
                type="button"
              >
                Codex
              </button>
            </div>
          ) : (
            <span className={`config-cli-label config-cli-label-${configCli}`}>{configCli === "codex" ? "Codex" : "Claude"}</span>
          )}
        </div>
        <div className="config-tabs">
          {visibleTabs.map((t) => (
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
            <Dropdown
              className="config-select config-project-select"
              value={projectDir}
              onChange={setProjectDir}
              ariaLabel="Project directory"
              options={projectDirs.map((dir) => ({ value: dir, label: dir }))}
            />
          )}
          <button className="config-close" onClick={onClose} title="Close (Esc)">
            <IconClose size={14} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="config-content">
        {tab === "settings" && (
          <SettingsTab projectDir={projectDir} cli={configCli} onStatus={setStatusMsg} />
        )}
        {configCli === "claude" && tab === "envvars" && (
          <EnvVarsTab projectDir={projectDir} onStatus={setStatusMsg} />
        )}
        {tab === "claudemd" && (
          <ThreePaneEditor component={MarkdownPane} projectDir={projectDir} cli={configCli} onStatus={setStatusMsg} tabId="claudemd" />
        )}
        {tab === "hooks" && (
          <ThreePaneEditor component={HooksPane} projectDir={projectDir} cli={configCli} onStatus={setStatusMsg} tabId="hooks" scopes={codexTwoScopes} />
        )}
        {tab === "plugins" && (
          <PluginsTab visible projectDir={projectDir} cli={configCli} onStatus={setStatusMsg} />
        )}
        {tab === "mcp" && (
          <ThreePaneEditor component={McpPane} projectDir={projectDir} cli={configCli} onStatus={setStatusMsg} tabId="mcp" scopes={["user", "project"]} />
        )}
        {configCli === "claude" && tab === "agents" && (
          <ThreePaneEditor component={AgentEditor} projectDir={projectDir} cli={configCli} onStatus={setStatusMsg} tabId="agents" scopes={["user", "project"]} />
        )}
        {tab === "prompts" && (
          <PromptsTab cli={configCli} onStatus={setStatusMsg} />
        )}
        {tab === "skills" && (
          <ThreePaneEditor component={SkillsEditor} projectDir={projectDir} cli={configCli} onStatus={setStatusMsg} tabId="skills" scopes={["user", "project"]} />
        )}
        {debugBuild && tab === "recording" && (
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

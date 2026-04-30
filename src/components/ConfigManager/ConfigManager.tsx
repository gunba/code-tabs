import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
import { ProviderLogo } from "../ProviderLogo/ProviderLogo";
import { RecordingPane } from "./RecordingPane";
import { parseWorktreePath } from "../../lib/paths";
import type { StatusMessage } from "../../lib/settingsSchema";
import type { CliKind } from "../../types/session";
import { diffLines } from "../../lib/promptDiff";
import type { DiffLine } from "../../lib/promptDiff";
import {
  UnsavedTextEditorProvider,
  useUnsavedTextEditorRegistry,
  type UnsavedTextEditorChange,
} from "./UnsavedTextEditors";
import { CONFIG_MANAGER_CLOSE_REQUEST_EVENT } from "./events";
import { visibleConfigTabs, type ConfigManagerTab } from "./configTabs";
import "./ConfigManager.css";

type Tab = ConfigManagerTab;

type DiffPreviewLine = DiffLine | { type: "skip"; skipped: number; truncated?: boolean };

const DIFF_CONTEXT_LINES = 2;
const MAX_DIFF_PREVIEW_ROWS = 140;

function buildDiffPreview(before: string, after: string): DiffPreviewLine[] {
  const diff = diffLines(before, after);
  const changedIndexes = diff
    .map((line, index) => line.type === "same" ? -1 : index)
    .filter((index) => index >= 0);
  if (changedIndexes.length === 0) return [];

  const keep = new Set<number>();
  for (const index of changedIndexes) {
    for (let i = Math.max(0, index - DIFF_CONTEXT_LINES); i <= Math.min(diff.length - 1, index + DIFF_CONTEXT_LINES); i++) {
      keep.add(i);
    }
  }

  const rows: DiffPreviewLine[] = [];
  let skipped = 0;
  for (let i = 0; i < diff.length; i++) {
    if (!keep.has(i)) {
      skipped += 1;
      continue;
    }
    if (skipped > 0) {
      rows.push({ type: "skip", skipped });
      skipped = 0;
    }
    rows.push(diff[i]);
  }
  if (skipped > 0) rows.push({ type: "skip", skipped });

  if (rows.length <= MAX_DIFF_PREVIEW_ROWS) return rows;
  const limited = rows.slice(0, MAX_DIFF_PREVIEW_ROWS);
  limited.push({ type: "skip", skipped: rows.length - MAX_DIFF_PREVIEW_ROWS, truncated: true });
  return limited;
}

function DiscardChangesDialog({
  changes,
  onCancel,
  onDiscard,
}: {
  changes: UnsavedTextEditorChange[];
  onCancel: () => void;
  onDiscard: () => void;
}) {
  const [activeId, setActiveId] = useState(changes[0]?.id ?? "");

  useEffect(() => {
    if (!changes.some((change) => change.id === activeId)) {
      setActiveId(changes[0]?.id ?? "");
    }
  }, [activeId, changes]);

  const activeChange = changes.find((change) => change.id === activeId) ?? changes[0];
  const previewRows = useMemo(
    () => activeChange ? buildDiffPreview(activeChange.before, activeChange.after) : [],
    [activeChange],
  );

  return (
    <div className="config-discard-layer" role="presentation" onMouseDown={(e) => e.stopPropagation()}>
      <div className="config-discard-dialog" role="dialog" aria-modal="true" aria-labelledby="config-discard-title">
        <div className="config-discard-header">
          <div>
            <div id="config-discard-title" className="config-discard-title">Discard unsaved changes?</div>
            <div className="config-discard-subtitle">
              {changes.length === 1
                ? "This editor has changes that have not been saved."
                : `${changes.length} editors have changes that have not been saved.`}
            </div>
          </div>
          <button className="config-close" onClick={onCancel} title="Keep editing">
            <IconClose size={14} />
          </button>
        </div>

        <div className="config-discard-body">
          <div className="config-discard-change-list" aria-label="Unsaved editors">
            {changes.map((change) => (
              <button
                key={change.id}
                type="button"
                className={`config-discard-change${change.id === activeChange?.id ? " active" : ""}`}
                onClick={() => setActiveId(change.id)}
              >
                <span className="config-discard-change-title">{change.title}</span>
                <span className="config-discard-change-meta">
                  {change.after.length.toLocaleString()} chars
                </span>
              </button>
            ))}
          </div>

          <div className="config-discard-preview" aria-label="Unsaved change diff">
            <div className="config-discard-preview-title">
              {activeChange?.title ?? "Unsaved changes"}
            </div>
            <div className="config-discard-diff">
              {previewRows.length === 0 ? (
                <div className="config-discard-diff-empty">Only whitespace or metadata changed.</div>
              ) : (
                previewRows.map((line, index) => {
                  if (line.type === "skip") {
                    return (
                      <div key={`skip-${index}`} className="config-discard-diff-skip">
                        {line.truncated
                          ? `... ${line.skipped} more diff row${line.skipped === 1 ? "" : "s"} hidden`
                          : `... ${line.skipped} unchanged line${line.skipped === 1 ? "" : "s"}`}
                      </div>
                    );
                  }
                  const marker = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
                  return (
                    <div key={`${line.type}-${index}`} className={`config-discard-diff-line config-discard-diff-${line.type}`}>
                      <span className="config-discard-diff-marker">{marker}</span>
                      <span className="config-discard-diff-text">{line.text || " "}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        <div className="config-discard-actions">
          <button type="button" className="config-discard-keep" onClick={onCancel} autoFocus>
            Keep editing
          </button>
          <button type="button" className="config-discard-confirm" onClick={onDiscard}>
            Discard changes
          </button>
        </div>
      </div>
    </div>
  );
}

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "settings", label: "Settings", icon: <IconGear size={11} /> },
  { id: "envvars", label: "Env Vars", icon: <IconBraces size={11} /> },
  { id: "claudemd", label: "Instructions", icon: <IconDocument size={11} /> }, // [CM-20]
  { id: "hooks", label: "Hooks", icon: <IconHook size={11} /> },
  { id: "plugins", label: "Plugins", icon: <IconPuzzle size={11} /> },
  { id: "mcp", label: "MCP", icon: <IconServer size={11} /> },
  { id: "agents", label: "Agents", icon: <IconBot size={11} /> },
  { id: "prompts", label: "Prompts", icon: <IconDocument size={11} /> },
  { id: "skills", label: "Skills & Commands", icon: <IconSkill size={11} /> },
  { id: "recording", label: "Observability", icon: <IconCircleFilled size={11} /> },
];

// [DL-01] ConfigManager Claude/Codex switch (only when both installed); visibleTabs filtered per CLI (Codex hides envvars/Claude file-agents); shared panes own their copy/import actions; ThreePaneEditor + PaneComponentProps thread cli; SettingsPane TOML-aware for Codex; SettingsTab hides project-local for Codex; HooksPane CODEX_HOOK_EVENTS + remaps project-local->project on save
// [CM-11] Config modal (84vw, max 1500px, 78vh), store-controlled active tab; Observability tab is always available (toggles inside it gate logging and DevTools at runtime).
// [CM-05] Tab routing: editor tabs plus dedicated Plugins/Prompts/Providers/Recording panes; MCP/Agents/Skills use 2-col ThreePaneEditor
// [CM-18] Inline SVG icons per tab — monochrome, cross-platform
export function ConfigManager() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const claudePath = useSessionStore((s) => s.claudePath);
  const codexPath = useSessionStore((s) => s.codexPath);
  const showConfigManager = useSettingsStore((s) => s.showConfigManager);
  const setShowConfigManager = useSettingsStore((s) => s.setShowConfigManager);
  const [tab, setTab] = useState<Tab>((showConfigManager || "settings") as Tab);
  const [configCli, setConfigCli] = useState<CliKind>(() => {
    const active = sessions.find((s) => s.id === activeTabId)?.config.cli;
    return active ?? (codexPath && !claudePath ? "codex" : "claude");
  });
  const [projectDir, setProjectDir] = useState("");
  const [statusMsg, setStatusMsg] = useState<StatusMessage | null>(null);
  const [pendingDiscardChanges, setPendingDiscardChanges] = useState<UnsavedTextEditorChange[] | null>(null);
  const prevRequestedTabRef = useRef<typeof showConfigManager>(showConfigManager);
  const pendingDiscardActionRef = useRef<(() => void) | null>(null);
  const allowWindowCloseRef = useRef(false);
  const unsavedTextEditorRegistry = useUnsavedTextEditorRegistry();
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
    () => visibleConfigTabs(TABS, { configCli }),
    [configCli],
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

  // If the active tab becomes unavailable for the selected CLI, fall back.
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

  const closeConfig = useCallback(() => setShowConfigManager(false), [setShowConfigManager]);
  const cancelDiscard = useCallback(() => {
    pendingDiscardActionRef.current = null;
    setPendingDiscardChanges(null);
  }, []);
  const runWithUnsavedEditorGuard = useCallback((afterDiscard: () => void = closeConfig) => {
    const changes = unsavedTextEditorRegistry.getChanges();
    if (changes.length > 0) {
      pendingDiscardActionRef.current = afterDiscard;
      setPendingDiscardChanges(changes);
      return;
    }
    afterDiscard();
  }, [closeConfig, unsavedTextEditorRegistry]);
  const confirmDiscard = useCallback(() => {
    const action = pendingDiscardActionRef.current ?? closeConfig;
    pendingDiscardActionRef.current = null;
    setPendingDiscardChanges(null);
    action();
  }, [closeConfig]);
  const onClose = useCallback(() => runWithUnsavedEditorGuard(closeConfig), [runWithUnsavedEditorGuard, closeConfig]);
  const codexTwoScopes = configCli === "codex" ? ["user", "project"] as Array<"user" | "project"> : undefined;

  useEffect(() => {
    const handler = () => {
      if (pendingDiscardChanges) {
        cancelDiscard();
        return;
      }
      runWithUnsavedEditorGuard(closeConfig);
    };
    window.addEventListener(CONFIG_MANAGER_CLOSE_REQUEST_EVENT, handler);
    return () => window.removeEventListener(CONFIG_MANAGER_CLOSE_REQUEST_EVENT, handler);
  }, [cancelDiscard, closeConfig, pendingDiscardChanges, runWithUnsavedEditorGuard]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    getCurrentWindow().onCloseRequested((event) => {
      if (allowWindowCloseRef.current) return;
      const changes = unsavedTextEditorRegistry.getChanges();
      if (changes.length === 0) return;
      event.preventDefault();
      pendingDiscardActionRef.current = () => {
        allowWindowCloseRef.current = true;
        getCurrentWindow().close().catch(() => {
          allowWindowCloseRef.current = false;
        });
      };
      setPendingDiscardChanges(changes);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [unsavedTextEditorRegistry]);

  return (
    <ModalOverlay onClose={onClose} className={`config-modal config-modal-cli-${configCli}`} closeOnBackdropClick={false}>
      <UnsavedTextEditorProvider registry={unsavedTextEditorRegistry}>
        {/* [CM-04] [CM-09] keystroke isolation + Escape/X/Ctrl+, close */}
        {/* Header with tabs */}
        <div className="config-header">
          <div className="config-title-group">
            <span className="config-title">Config</span>
            {availableCliKinds.length > 1 ? (
              <div className="config-cli-switch" role="tablist" aria-label="Configuration target">
                <button
                  className={`config-cli-switch-btn config-cli-switch-btn-claude${configCli === "claude" ? " active" : ""}`}
                  onClick={() => {
                    if (configCli !== "claude") runWithUnsavedEditorGuard(() => setConfigCli("claude"));
                  }}
                  type="button"
                  title="Claude"
                >
                  <ProviderLogo cli="claude" size={16} />
                </button>
                <button
                  className={`config-cli-switch-btn config-cli-switch-btn-codex${configCli === "codex" ? " active" : ""}`}
                  onClick={() => {
                    if (configCli !== "codex") runWithUnsavedEditorGuard(() => setConfigCli("codex"));
                  }}
                  type="button"
                  title="Codex"
                >
                  <ProviderLogo cli="codex" size={16} />
                </button>
              </div>
            ) : (
              <span className={`config-cli-label config-cli-label-${configCli}`} title={configCli === "codex" ? "Codex" : "Claude"}>
                <ProviderLogo cli={configCli} size={16} />
              </span>
            )}
          </div>
          <div className="config-tabs">
            {visibleTabs.map((t) => (
              <button
                key={t.id}
                className={`config-tab${tab === t.id ? " config-tab-active" : ""}`}
                onClick={() => {
                  if (tab !== t.id) runWithUnsavedEditorGuard(() => setTab(t.id));
                }}
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
                onChange={(dir) => runWithUnsavedEditorGuard(() => setProjectDir(dir))}
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
          {tab === "envvars" && (
            <EnvVarsTab projectDir={projectDir} cli={configCli} onStatus={setStatusMsg} />
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
          {tab === "recording" && (
            <RecordingPane cli={configCli} onStatus={setStatusMsg} />
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

        {pendingDiscardChanges && (
          <DiscardChangesDialog
            changes={pendingDiscardChanges}
            onCancel={cancelDiscard}
            onDiscard={confirmDiscard}
          />
        )}
      </UnsavedTextEditorProvider>
    </ModalOverlay>
  );
}

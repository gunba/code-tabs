import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "./store/sessions";
import { useSettingsStore } from "./store/settings";
import { dirToTabName, effectiveModel, formatTokenCount, getResumeId, modelLabel, modelColor } from "./lib/claude";
import { TerminalPanel } from "./components/Terminal/TerminalPanel";
import { SubagentInspector } from "./components/SubagentInspector/SubagentInspector";

import { SessionLauncher } from "./components/SessionLauncher/SessionLauncher";
import { ResumePicker } from "./components/ResumePicker/ResumePicker";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { CommandBar } from "./components/CommandBar/CommandBar";
import { CommandPalette } from "./components/CommandPalette/CommandPalette";
import { ConfigManager } from "./components/ConfigManager/ConfigManager";
import { DebugPanel } from "./components/DebugPanel/DebugPanel";
import { ModalOverlay } from "./components/ModalOverlay/ModalOverlay";

import { useCliWatcher } from "./hooks/useCliWatcher";
import { useNotifications } from "./hooks/useNotifications";
import { useCommandDiscovery } from "./hooks/useCommandDiscovery";
import { useCtrlKey } from "./hooks/useCtrlKey";
import { useUiConfigStore } from "./lib/uiConfig";
import { writeToPty } from "./lib/ptyRegistry";
import { killAllActivePtys } from "./lib/ptyProcess";
import { getInspectorPort, disconnectInspectorForSession, reconnectInspectorForSession } from "./lib/inspectorPort";
import { startTestHarness } from "./lib/testHarness";
import { IconPencil, IconStop, IconClose, IconReturn, IconGear, IconArrowRight } from "./components/Icons/Icons";
import { groupSessionsByDir, swapWithinGroup, parseWorktreePath, worktreeAcronym } from "./lib/paths";
import type { Subagent } from "./types/session";
import "./App.css";

export default function App() {
  const init = useSessionStore((s) => s.init);
  const sessions = useSessionStore((s) => s.sessions);
  const initialized = useSessionStore((s) => s.initialized);
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const setActiveTab = useSessionStore((s) => s.setActiveTab);
  const closeSession = useSessionStore((s) => s.closeSession);
  const createSession = useSessionStore((s) => s.createSession);
  const persist = useSessionStore((s) => s.persist);
  const updateSubagent = useSessionStore((s) => s.updateSubagent);
  const reorderTabs = useSessionStore((s) => s.reorderTabs);
  const renameSession = useSessionStore((s) => s.renameSession);
  const requestKill = useSessionStore((s) => s.requestKill);
  const inspectorOffSessions = useSessionStore((s) => s.inspectorOffSessions);
  const setInspectorOff = useSessionStore((s) => s.setInspectorOff);
  const showLauncher = useSettingsStore((s) => s.showLauncher);
  const setShowLauncher = useSettingsStore((s) => s.setShowLauncher);
  const setLastConfig = useSettingsStore((s) => s.setLastConfig);
  const showConfigManager = useSettingsStore((s) => s.showConfigManager);
  const setShowConfigManager = useSettingsStore((s) => s.setShowConfigManager);
  const [showPalette, setShowPalette] = useState(false);
  const [showResumePicker, setShowResumePicker] = useState(false);
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [inspectedSubagent, setInspectedSubagent] = useState<{ sessionId: string; subagentId: string } | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabName, setEditingTabName] = useState("");
  const [flashingTabs, setFlashingTabs] = useState<Set<string>>(new Set());
  const ctrlHeld = useCtrlKey();
  const prevStatesRef = useRef<Map<string, string>>(new Map());
  const flashTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const dragTabRef = useRef<string | null>(null);
  const editDoneRef = useRef(false);
  const initRef = useRef(false);
  const [pruneConfirm, setPruneConfirm] = useState<{
    sessionId: string; worktreePath: string; worktreeName: string; projectRoot: string;
    error?: string; forcing?: boolean;
  } | null>(null);

  useCliWatcher();
  useNotifications();
  useCommandDiscovery();

  // Track state transitions — flash tabs that become idle from an active state (5s, dismiss on hover)
  useEffect(() => {
    const prev = prevStatesRef.current;
    const timers = flashTimersRef.current;
    for (const s of sessions) {
      const prevState = prev.get(s.id);
      if (prevState && prevState !== "idle" && prevState !== "dead" && prevState !== "starting" && s.state === "idle") {
        // Clear existing timer before setting new one
        const existing = timers.get(s.id);
        if (existing) clearTimeout(existing);
        setFlashingTabs((f) => new Set(f).add(s.id));
        const timer = setTimeout(() => {
          setFlashingTabs((f) => { const n = new Set(f); n.delete(s.id); return n; });
          timers.delete(s.id);
        }, 5000);
        timers.set(s.id, timer);
      }
      prev.set(s.id, s.state);
    }
    // Clean up timers for sessions that were removed (closed)
    const sessionIds = new Set(sessions.map((s) => s.id));
    for (const id of timers.keys()) {
      if (!sessionIds.has(id)) {
        clearTimeout(timers.get(id)!);
        timers.delete(id);
      }
    }
  }, [sessions]);

  const dismissFlash = useCallback((sessionId: string) => {
    const timers = flashTimersRef.current;
    const timer = timers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    timers.delete(sessionId);
    setFlashingTabs((f) => { const n = new Set(f); n.delete(sessionId); return n; });
  }, []);

  // Initialize once
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    init();
    useUiConfigStore.getState().loadConfig();
    useSettingsStore.getState().loadPastSessions();
    startTestHarness();
  }, [init]);

  // Quick launch with saved defaults (Ctrl+Click "+" or Ctrl+Shift+T)
  const quickLaunch = useCallback(async () => {
    const { savedDefaults, lastConfig } = useSettingsStore.getState();
    const defaults = (savedDefaults && savedDefaults.workingDir.trim()) ? savedDefaults : lastConfig;
    if (!defaults || !defaults.workingDir.trim()) {
      setShowLauncher(true);
      return;
    }
    const cleanConfig = { ...defaults, resumeSession: null, continueSession: false, sessionId: null, runMode: false };
    const name = dirToTabName(cleanConfig.workingDir);
    useSettingsStore.getState().addRecentDir(cleanConfig.workingDir);
    useSettingsStore.getState().setLastConfig(cleanConfig);
    try {
      await createSession(name, cleanConfig);
    } catch {
      // Fall back to modal on failure
      setShowLauncher(true);
    }
  }, [createSession, setShowLauncher]);

  // Auto-persist sessions on changes (debounced)
  useEffect(() => {
    if (sessions.length > 0) {
      const timer = setTimeout(() => persist(), 2000);
      return () => clearTimeout(timer);
    }
  }, [sessions, persist]);

  // Kill active PTY processes and persist on window close
  useEffect(() => {
    const handler = () => {
      killAllActivePtys();
      persist();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [persist]);

  // Activate tab — dead tabs just switch to them (overlay provides actions)
  const handleTabActivate = useCallback(
    (id: string) => {
      setInspectedSubagent(null);
      dismissFlash(id);
      if (id !== activeTabId) {
        setActiveTab(id);
      }
    },
    [activeTabId, dismissFlash, setActiveTab]
  );

  // Close session, prompting for worktree prune on manual single-tab close
  const handleCloseSession = useCallback((id: string) => {
    const session = sessions.find((s) => s.id === id);
    if (session) {
      const wt = parseWorktreePath(session.config.workingDir);
      if (wt) {
        setPruneConfirm({
          sessionId: id, worktreePath: session.config.workingDir,
          worktreeName: wt.worktreeName, projectRoot: wt.projectRoot,
        });
        return;
      }
    }
    closeSession(id);
  }, [sessions, closeSession]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "t") {
        e.preventDefault();
        if (e.shiftKey) {
          quickLaunch();
        } else {
          // Clear resume/continue flags so the launcher opens fresh
          const lc = useSettingsStore.getState().lastConfig;
          if (lc.resumeSession || lc.continueSession) {
            setLastConfig({ ...lc, resumeSession: null, continueSession: false });
          }
          setShowLauncher(true);
        }
      }

      if (e.ctrlKey && e.key === "w") {
        e.preventDefault();
        if (activeTabId) handleCloseSession(activeTabId);
      }

      if (e.ctrlKey && e.key === "k") {
        e.preventDefault();
        setShowPalette((v) => !v);
      }

      if (e.ctrlKey && e.shiftKey && e.key === "R") {
        e.preventDefault();
        setShowResumePicker(true);
      }

      if (e.ctrlKey && e.key === ",") {
        e.preventDefault();
        setShowConfigManager(showConfigManager ? false : "settings");
      }

      if (e.ctrlKey && e.shiftKey && e.key === "D") {
        e.preventDefault();
        setShowDebugPanel((v) => !v);
      }

      if (e.key === "Escape") {
        if (tabContextMenu) { setTabContextMenu(null); return; }
        if (showPalette) return;
        if (showDebugPanel) { setShowDebugPanel(false); return; }
        if (showConfigManager) { setShowConfigManager(false); return; }
        if (showResumePicker) { setShowResumePicker(false); return; }
        if (showLauncher) { setShowLauncher(false); return; }
        if (inspectedSubagent) { e.preventDefault(); setInspectedSubagent(null); return; }
      }

      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        const nonMeta = sessions.filter((s) => !s.isMetaAgent);
        const idx = nonMeta.findIndex((s) => s.id === activeTabId);
        if (nonMeta.length > 0) {
          const next = e.shiftKey
            ? (idx - 1 + nonMeta.length) % nonMeta.length
            : (idx + 1) % nonMeta.length;
          setActiveTab(nonMeta[next].id);
        }
      }

      if (e.ctrlKey && e.shiftKey && e.key === "X") {
        e.preventDefault();
        if (activeTabId) writeToPty(activeTabId, "\x15".repeat(20));
      }

      if (e.ctrlKey && e.key === "e") {
        e.preventDefault();
        if (activeTabId) {
          const s = sessions.find(s => s.id === activeTabId);
          if (s) {
            setEditingTabId(s.id);
            setEditingTabName(s.name || dirToTabName(s.config.workingDir));
          }
        }
      }

      if (e.altKey && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const nonMeta = sessions.filter((s) => !s.isMetaAgent);
        const idx = parseInt(e.key) - 1;
        if (idx < nonMeta.length) setActiveTab(nonMeta[idx].id);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTabId, sessions, setActiveTab, closeSession, handleCloseSession, setShowLauncher, showPalette, showLauncher, showResumePicker, showConfigManager, setShowConfigManager, showDebugPanel, inspectedSubagent, tabContextMenu, quickLaunch]);

  const regularSessions = useMemo(() => sessions.filter((s) => !s.isMetaAgent), [sessions]);
  const groups = useMemo(() => groupSessionsByDir(regularSessions), [regularSessions]);
  const subagentMap = useSessionStore((s) => s.subagents);
  const activeSubagent: Subagent | null = inspectedSubagent
    ? (subagentMap.get(inspectedSubagent.sessionId) || []).find(
        (s) => s.id === inspectedSubagent.subagentId
      ) ?? null
    : null;

  // Active session's subagents — show all non-dead ones while any exist
  const activeSession = sessions.find((s) => s.id === activeTabId);
  const allSubs = activeTabId ? (subagentMap.get(activeTabId) || []) : [];
  const activeSubs = allSubs.filter((s) => s.state !== "dead");

  return (
    <div className={`app${ctrlHeld ? " ctrl-held" : ""}`}>
      {/* Tab bar */}
      <div className="tab-bar">
          <div className="tab-bar-scroll">
            {groups.flatMap((group, gi) => [
              ...(gi > 0 ? [<div key={`sep-${group.key}`} className="tab-group-separator" title={group.fullPath}>
                <span className="tab-group-pip" />
              </div>] : []),
              ...group.sessions.map((session, si) => {
              const isActive = session.id === activeTabId;
              const fullName = session.name || dirToTabName(session.config.workingDir);
              const isDead = session.state === "dead";
              const summary = session.metadata.nodeSummary ?? session.metadata.currentAction;

              // Meta row: model | effort | agents (each colored)
              const m = effectiveModel(session);
              const wt = parseWorktreePath(session.config.workingDir);
              const metaSpans: { text: string; color: string; title?: string }[] = [];
              if (m) {
                const vMatch = m.match(/(\d+)[.-](\d+)/);
                const ver = vMatch ? ` ${vMatch[1]}.${vMatch[2]}` : "";
                metaSpans.push({ text: modelLabel(m) + ver, color: modelColor(m) });
              }
              if (session.config.effort) metaSpans.push({ text: session.config.effort.charAt(0).toUpperCase() + session.config.effort.slice(1), color: "var(--accent)" });
              const totalTokens = session.metadata.inputTokens + session.metadata.outputTokens;
              const subs = subagentMap.get(session.id) || [];
              const liveAgents = subs.filter((s) => s.state !== "dead" && s.state !== "idle").length;
              if (liveAgents > 0) metaSpans.push({ text: `${liveAgents} agent${liveAgents > 1 ? "s" : ""}`, color: "var(--text-secondary)" });
              if (wt) metaSpans.push({ text: worktreeAcronym(wt.worktreeName), color: "var(--accent-secondary)", title: wt.worktreeName });

              return (
                <div
                  key={session.id}
                  className={`tab${isActive ? " tab-active" : ""}${isDead ? " tab-dead" : ""}${session.config.runMode ? " tab-run" : ""}${dragOverTabId === session.id ? " tab-drag-over" : ""}${session.state === "waitingPermission" && isActive ? " tab-permission" : ""}${session.state === "actionNeeded" && isActive ? " tab-actionNeeded" : ""}${(session.state === "waitingPermission" || session.state === "actionNeeded") ? " tab-attention" : ""}${flashingTabs.has(session.id) ? " tab-flash" : ""}`}
                  role="button"
                  tabIndex={0}
                  draggable
                  onDragStart={(e) => {
                    dragTabRef.current = session.id;
                    const ghost = document.createElement("div");
                    ghost.textContent = fullName;
                    ghost.style.cssText = "position:absolute;top:-999px;padding:4px 8px;background:var(--bg-surface);color:var(--text-primary);font-size:11px;border-radius:4px;white-space:nowrap;";
                    document.body.appendChild(ghost);
                    e.dataTransfer.setDragImage(ghost, 0, 0);
                    setTimeout(() => document.body.removeChild(ghost), 0);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (dragTabRef.current && dragTabRef.current !== session.id) {
                      if (group.sessions.some((s) => s.id === dragTabRef.current)) {
                        setDragOverTabId(session.id);
                      }
                    }
                  }}
                  onDragLeave={() => {
                    if (dragOverTabId === session.id) setDragOverTabId(null);
                  }}
                  onDrop={() => {
                    setDragOverTabId(null);
                    const from = dragTabRef.current;
                    if (from && from !== session.id && group.sessions.some((s) => s.id === from)) {
                      const order = regularSessions.map((s) => s.id);
                      const fromIdx = order.indexOf(from);
                      const toIdx = order.indexOf(session.id);
                      if (fromIdx >= 0 && toIdx >= 0) {
                        order.splice(fromIdx, 1);
                        order.splice(toIdx, 0, from);
                        reorderTabs(order);
                      }
                    }
                    dragTabRef.current = null;
                  }}
                  onDragEnd={() => { dragTabRef.current = null; setDragOverTabId(null); }}
                  onClick={(e) => {
                    if (e.ctrlKey) {
                      setLastConfig({
                        ...session.config,
                        resumeSession: getResumeId(session),
                        continueSession: false,
                      });
                      useSettingsStore.getState().setReplaceSessionId(session.id);
                      setShowLauncher(true);
                    } else {
                      handleTabActivate(session.id);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (editingTabId === session.id) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleTabActivate(session.id);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setTabContextMenu({ x: e.clientX, y: e.clientY, sessionId: session.id });
                  }}
                  onMouseEnter={() => dismissFlash(session.id)}
                  title={ctrlHeld ? `Ctrl+Click: Relaunch ${fullName}` : `${fullName} — ${session.state}\n${session.config.workingDir}${wt ? `\nWorktree: ${wt.worktreeName}` : ""}`}
                >
                  <span className={`tab-dot state-${session.state}${inspectorOffSessions.has(session.id) ? " inspector-off" : ""}`} />
                  <span className="tab-label">
                    {editingTabId === session.id ? (
                      <input
                        className="tab-name-input"
                        value={editingTabName}
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) => setEditingTabName(e.target.value)}
                        onBlur={() => {
                          if (!editDoneRef.current && editingTabName.trim()) {
                            renameSession(session.id, editingTabName.trim());
                            useSettingsStore.getState().setSessionName(getResumeId(session), editingTabName.trim());
                          }
                          editDoneRef.current = false;
                          setEditingTabId(null);
                        }}
                        onKeyDown={(e) => {
                          const focusTerminal = () => requestAnimationFrame(() => {
                            document.querySelector<HTMLElement>('.terminal-panel[style*="display: flex"] textarea')?.focus();
                          });
                          if (e.key === "Enter") {
                            editDoneRef.current = true;
                            if (editingTabName.trim()) {
                              renameSession(session.id, editingTabName.trim());
                              useSettingsStore.getState().setSessionName(getResumeId(session), editingTabName.trim());
                            }
                            setEditingTabId(null);
                            focusTerminal();
                          } else if (e.key === "Escape") {
                            editDoneRef.current = true;
                            setEditingTabId(null);
                            focusTerminal();
                          }
                          e.stopPropagation();
                        }}
                        onClick={(e) => e.stopPropagation()}
                        autoFocus
                      />
                    ) : (
                      <span className="tab-name">{fullName}</span>
                    )}
                    {summary && <span className="tab-summary">{summary}</span>}
                    {metaSpans.length > 0 && (
                      <span className="tab-meta">
                        {metaSpans.map((s, i) => (
                          <span key={i}>
                            {i > 0 && <span style={{ color: "var(--text-muted)", opacity: 0.5 }}> &middot; </span>}
                            <span style={{ color: s.color }} title={s.title}>{s.text}</span>
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                  {group.sessions.length > 1 && (
                    <span className="tab-reorder-arrows">
                      {si > 0 ? (
                        <button className="tab-arrow" onClick={(e) => {
                          e.stopPropagation();
                          const order = swapWithinGroup(regularSessions.map(s => s.id), session.id, "left", groups);
                          if (order) reorderTabs(order);
                        }} title="Move left" aria-label="Move tab left">&#x2039;</button>
                      ) : <span />}
                      {si < group.sessions.length - 1 ? (
                        <button className="tab-arrow" onClick={(e) => {
                          e.stopPropagation();
                          const order = swapWithinGroup(regularSessions.map(s => s.id), session.id, "right", groups);
                          if (order) reorderTabs(order);
                        }} title="Move right" aria-label="Move tab right">&#x203a;</button>
                      ) : <span />}
                    </span>
                  )}
                  <span className="tab-actions">
                    <button
                      className="tab-edit"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingTabId(session.id);
                        setEditingTabName(fullName);
                      }}
                      title="Rename"
                    >
                      <IconPencil size={11} />
                    </button>
                    {session.state !== "dead" && (
                      <button
                        className="tab-kill"
                        onClick={(e) => { e.stopPropagation(); requestKill(session.id); }}
                        title="Kill agent (keep tab)"
                      >
                        <IconStop size={9} />
                      </button>
                    )}
                    <button
                      className="tab-close"
                      onClick={(e) => { e.stopPropagation(); handleCloseSession(session.id); }}
                      title="Close"
                    >
                      <IconClose size={12} />
                    </button>
                  </span>
                  {session.state !== "dead" && totalTokens > 0 && (
                    <span className="tab-tokens" title={`Input: ${formatTokenCount(session.metadata.inputTokens)}\nOutput: ${formatTokenCount(session.metadata.outputTokens)}`}>
                      {formatTokenCount(totalTokens)}
                    </span>
                  )}
                </div>
              );
              }),
            ])}
          </div>
          <button
            className="tab-resume"
            onClick={() => setShowResumePicker(true)}
            title="Resume session (Ctrl+Shift+R)"
          >
            <IconReturn size={16} />
          </button>
          <button
            className="tab-config"
            onClick={() => setShowConfigManager("settings")}
            title="Config Manager (Ctrl+,)"
          >
            <IconGear size={16} />
          </button>
          <button
            className="tab-add"
            onClick={(e) => e.ctrlKey ? quickLaunch() : setShowLauncher(true)}
            title={ctrlHeld ? "Quick launch with saved defaults (Ctrl+Shift+T)" : "New session (Ctrl+T)"}
          >
            +
          </button>
        </div>

      {/* Subagent row — conditional, only for active session */}
      {activeSubs.length > 0 && (
        <div className="subagent-bar">
          {activeSubs.map((sub) => {
            const isActive = sub.state === "thinking" || sub.state === "toolUse" || sub.state === "starting";
            const isIdle = sub.state === "idle";
            const isSelected = inspectedSubagent?.subagentId === sub.id && inspectedSubagent?.sessionId === activeTabId;
            const lastMsg = sub.messages.length > 0
              ? sub.messages[sub.messages.length - 1].text.slice(0, 200)
              : null;
            return (
              <button
                key={sub.id}
                className={`subagent-card${isActive ? " subagent-active" : ""}${isIdle ? " subagent-idle" : ""}${isSelected ? " subagent-selected" : ""}`}
                onClick={() => activeTabId && setInspectedSubagent({ sessionId: activeTabId, subagentId: sub.id })}
                title={sub.description}
              >
                <span className="subagent-icon"><IconArrowRight size={10} /></span>
                <span className="subagent-label">
                  <span className="subagent-name">{sub.description}</span>
                  <span className="subagent-last-msg">
                    {isActive && sub.currentAction ? sub.currentAction : lastMsg || sub.state}
                  </span>
                </span>
                {sub.tokenCount > 0 && (
                  <span className="subagent-tokens">{formatTokenCount(sub.tokenCount)}</span>
                )}
                {!isActive && (
                  <span
                    className="subagent-close"
                    onClick={(e) => { e.stopPropagation(); activeTabId && updateSubagent(activeTabId, sub.id, { state: "dead" }); }}
                    title="Dismiss"
                  ><IconClose size={12} /></span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Main area: terminals */}
      <div className="app-main">
        <div className="terminal-area">
          {/* Terminal panels — always mounted, hidden via CSS (including dead ones so errors remain visible) */}
          {regularSessions.map((session) => (
            <TerminalPanel
              key={session.id}
              session={session}
              visible={session.id === activeTabId}
            />
          ))}

          {/* Subagent inspector overlay */}
          {activeSubagent && (
            <SubagentInspector
              subagent={activeSubagent}
              onClose={() => setInspectedSubagent(null)}
            />
          )}

          {/* Empty state — no active terminal visible */}
          {initialized && !regularSessions.some((s) => s.id === activeTabId) && (
            <div className="empty-state">
              <kbd>Ctrl+T</kbd> new session &middot; <kbd>Ctrl+Shift+R</kbd> resume from history
            </div>
          )}
        </div>
        {showDebugPanel && (
          <DebugPanel onClose={() => setShowDebugPanel(false)} />
        )}
      </div>

      <CommandBar
        sessionId={activeTabId}
        sessionState={activeSession?.state ?? "dead"}
        ctrlHeld={ctrlHeld}
      />

      <StatusBar />

      {showLauncher && <SessionLauncher />}
      {showResumePicker && <ResumePicker onClose={() => setShowResumePicker(false)} />}
      {showPalette && <CommandPalette onClose={() => setShowPalette(false)} />}
      {showConfigManager && <ConfigManager />}

      {/* Worktree prune confirmation */}
      {pruneConfirm && (
        <ModalOverlay onClose={() => setPruneConfirm(null)}>
          <div className="prune-dialog">
            <div className="prune-title">Close worktree session</div>
            <div className="prune-body">
              Prune worktree <strong>{pruneConfirm.worktreeName}</strong>?
            </div>
            {pruneConfirm.error && (
              <div className="prune-error">{pruneConfirm.error}</div>
            )}
            <div className="prune-actions">
              <button onClick={() => {
                closeSession(pruneConfirm.sessionId);
                setPruneConfirm(null);
              }}>Keep worktree</button>
              <button className="prune-actions-danger" disabled={pruneConfirm.forcing} onClick={async () => {
                const force = !!pruneConfirm.error;
                if (force) setPruneConfirm((p) => p ? { ...p, forcing: true, error: undefined } : p);
                try {
                  await invoke("prune_worktree", {
                    worktreePath: pruneConfirm.worktreePath,
                    projectRoot: pruneConfirm.projectRoot,
                    force,
                  });
                } catch (err) {
                  setPruneConfirm((p) => p ? { ...p, forcing: false, error: String(err) } : p);
                  return;
                }
                closeSession(pruneConfirm.sessionId);
                setPruneConfirm(null);
              }}>{pruneConfirm.error ? "Force prune" : "Prune worktree"}</button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* Tab context menu portal */}
      {tabContextMenu && createPortal(
        <div
          style={{ position: "fixed", inset: 0, zIndex: 199 }}
          onClick={() => setTabContextMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setTabContextMenu(null); }}
        >
          <div
            className="tab-context-menu"
            style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {(() => {
              const ctxSession = sessions.find((s) => s.id === tabContextMenu.sessionId);
              if (!ctxSession) return null;
              const isDead = ctxSession.state === "dead";
              const inspectorPort = !isDead ? getInspectorPort(ctxSession.id) : null;
              const inspectorUrl = inspectorPort ? `https://debug.bun.sh/#127.0.0.1:${inspectorPort}/0` : null;
              return (
                <>
                  <button
                    className="tab-context-menu-item"
                    onClick={() => {
                      const ctxName = ctxSession.name || dirToTabName(ctxSession.config.workingDir);
                      setEditingTabId(ctxSession.id);
                      setEditingTabName(ctxName);
                      setTabContextMenu(null);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    className="tab-context-menu-item"
                    onClick={() => {
                      const sid = ctxSession.config.sessionId || ctxSession.id;
                      navigator.clipboard.writeText(sid);
                      setTabContextMenu(null);
                    }}
                  >
                    Copy Session ID
                  </button>
                  <button
                    className="tab-context-menu-item"
                    onClick={() => {
                      navigator.clipboard.writeText(ctxSession.config.workingDir);
                      setTabContextMenu(null);
                    }}
                  >
                    Copy Working Directory
                  </button>
                  <button
                    className="tab-context-menu-item"
                    onClick={() => {
                      invoke("shell_open", { path: ctxSession.config.workingDir });
                      setTabContextMenu(null);
                    }}
                  >
                    Open in Explorer
                  </button>
                  {inspectorUrl && (
                    <>
                      <button
                        className="tab-context-menu-item"
                        onClick={() => {
                          invoke("shell_open", { path: inspectorUrl });
                          disconnectInspectorForSession(ctxSession.id);
                          setInspectorOff(ctxSession.id, true);
                          setTabContextMenu(null);
                        }}
                      >
                        Open Inspector
                      </button>
                      <button
                        className="tab-context-menu-item"
                        onClick={() => {
                          navigator.clipboard.writeText(inspectorUrl);
                          setTabContextMenu(null);
                        }}
                      >
                        Copy Inspector URL
                      </button>
                      {inspectorOffSessions.has(ctxSession.id) && (
                        <button
                          className="tab-context-menu-item"
                          onClick={() => {
                            reconnectInspectorForSession(ctxSession.id);
                            setInspectorOff(ctxSession.id, false);
                            setTabContextMenu(null);
                          }}
                        >
                          Reconnect Inspector
                        </button>
                      )}
                    </>
                  )}
                  {isDead && (
                    <button
                      className="tab-context-menu-item"
                      onClick={() => {
                        setLastConfig({
                          ...ctxSession.config,
                          resumeSession: getResumeId(ctxSession),
                        });
                        setTabContextMenu(null);
                        setShowLauncher(true);
                      }}
                    >
                      Revive with Options
                    </button>
                  )}
                  {!isDead && (
                    <button
                      className="tab-context-menu-item"
                      onClick={() => {
                        handleCloseSession(ctxSession.id);
                        setTabContextMenu(null);
                      }}
                    >
                      Close
                    </button>
                  )}
                  <div className="tab-context-menu-divider" />
                  <button
                    className="tab-context-menu-item tab-context-menu-item-danger"
                    onClick={() => {
                      const group = groups.find((g) => g.sessions.some((s) => s.id === ctxSession.id));
                      if (group) {
                        for (const s of group.sessions) closeSession(s.id);
                      }
                      setTabContextMenu(null);
                    }}
                  >
                    Close Group ({(() => {
                      const group = groups.find((g) => g.sessions.some((s) => s.id === ctxSession.id));
                      return group ? group.sessions.length : 0;
                    })()})
                  </button>
                </>
              );
            })()}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "./store/sessions";
import { useSettingsStore } from "./store/settings";
import { dirToTabName, effectiveModel, getResumeId, modelLabel, modelColor, canResumeSession, stripWorktreeFlags, formatTokenCount, toolCategoryColor, getActivityText } from "./lib/claude";
import { TerminalPanel } from "./components/Terminal/TerminalPanel";
import { SubagentInspector } from "./components/SubagentInspector/SubagentInspector";

import { SessionLauncher } from "./components/SessionLauncher/SessionLauncher";
import { ResumePicker } from "./components/ResumePicker/ResumePicker";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { CommandBar } from "./components/CommandBar/CommandBar";
import { CommandPalette } from "./components/CommandPalette/CommandPalette";
import { ConfigManager } from "./components/ConfigManager/ConfigManager";
import { DebugPanel } from "./components/DebugPanel/DebugPanel";
import { DiffPanel } from "./components/DiffPanel/DiffPanel";
import { SearchPanel } from "./components/SearchPanel/SearchPanel";
import { ModalOverlay } from "./components/ModalOverlay/ModalOverlay";

import { useCliWatcher } from "./hooks/useCliWatcher";
import { useNotifications } from "./hooks/useNotifications";
import { useCommandDiscovery } from "./hooks/useCommandDiscovery";
import { useCtrlKey } from "./hooks/useCtrlKey";
import { useUiConfigStore } from "./lib/uiConfig";
import { killAllActivePtys } from "./lib/ptyProcess";
import { killPty } from "./lib/ptyRegistry";
import { getInspectorPort, disconnectInspectorForSession, reconnectInspectorForSession } from "./lib/inspectorPort";
import { dlog } from "./lib/debugLog";
import { IconStop, IconClose, IconReturn, IconGear } from "./components/Icons/Icons";
import { groupSessionsByDir, swapWithinGroup, parseWorktreePath, worktreeAcronym } from "./lib/paths";
import type { Subagent, SessionState } from "./types/session";
import { isSessionIdle, isSubagentActive } from "./types/session";
import { getEffectiveState } from "./lib/claude";
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
  const requestKill = useSessionStore((s) => s.requestKill);
  const inspectorOffSessions = useSessionStore((s) => s.inspectorOffSessions);
  const setInspectorOff = useSessionStore((s) => s.setInspectorOff);
  const tapCategories = useSessionStore((s) => s.tapCategories);
  const startAllTaps = useSessionStore((s) => s.startAllTaps);
  const stopAllTaps = useSessionStore((s) => s.stopAllTaps);
  const showLauncher = useSettingsStore((s) => s.showLauncher);
  const launcherGeneration = useSettingsStore((s) => s.launcherGeneration);
  const setShowLauncher = useSettingsStore((s) => s.setShowLauncher);
  const setLastConfig = useSettingsStore((s) => s.setLastConfig);
  const showConfigManager = useSettingsStore((s) => s.showConfigManager);
  const setShowConfigManager = useSettingsStore((s) => s.setShowConfigManager);
  const sidePanel = useSettingsStore((s) => s.sidePanel);
  const setSidePanel = useSettingsStore((s) => s.setSidePanel);
  const [showPalette, setShowPalette] = useState(false);
  const [showResumePicker, setShowResumePicker] = useState(false);
  const [inspectedSubagent, setInspectedSubagent] = useState<{ sessionId: string; subagentId: string } | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const [flashingTabs, setFlashingTabs] = useState<Set<string>>(new Set());
  const ctrlHeld = useCtrlKey();
  const prevStatesRef = useRef<Map<string, string>>(new Map());
  const flashTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pendingFlashRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const dragTabRef = useRef<string | null>(null);
  const initRef = useRef(false);
  const [pruneConfirm, setPruneConfirm] = useState<{
    sessionId: string; worktreePath: string; worktreeName: string; projectRoot: string;
  } | null>(null);
  useCliWatcher();
  useNotifications();
  useCommandDiscovery();

  // Track state transitions — flash tabs that become idle from an active state (5s, dismiss on hover)
  // Uses effective state (accounts for subagents) so flash only fires when all work is truly done.
  const subagentMap = useSessionStore((s) => s.subagents);
  useEffect(() => {
    const prev = prevStatesRef.current;
    const timers = flashTimersRef.current;
    const pending = pendingFlashRef.current;
    const subagents = useSessionStore.getState().subagents;
    for (const s of sessions) {
      const effState = getEffectiveState(s.state, subagents.get(s.id) || []);
      const prevState = prev.get(s.id);
      if (prevState && !isSessionIdle(prevState as SessionState) && prevState !== "dead" && prevState !== "starting" && isSessionIdle(effState)) {
        // [SI-24] Active -> idle: start 2s debounce before flashing
        const existingPending = pending.get(s.id);
        if (existingPending) clearTimeout(existingPending);
        const sid = s.id;
        const debounce = setTimeout(() => {
          pending.delete(sid);
          dlog("session", sid, "flash: idle confirmed after 2s debounce");
          const existingFlash = timers.get(sid);
          if (existingFlash) clearTimeout(existingFlash);
          setFlashingTabs((f) => new Set(f).add(sid));
          const dismiss = setTimeout(() => {
            setFlashingTabs((f) => { const n = new Set(f); n.delete(sid); return n; });
            timers.delete(sid);
          }, 5000);
          timers.set(sid, dismiss);
        }, 2000);
        pending.set(s.id, debounce);
      } else if (prevState && isSessionIdle(prevState as SessionState) && !isSessionIdle(effState)) {
        // Idle → non-idle: cancel pending flash (transient idle)
        const existingPending = pending.get(s.id);
        if (existingPending) {
          clearTimeout(existingPending);
          pending.delete(s.id);
          dlog("session", s.id, "flash: idle cancelled (transient)", "DEBUG");
        }
      }
      prev.set(s.id, effState);
    }
    // Clean up timers for sessions that were removed (closed)
    const sessionIds = new Set(sessions.map((s) => s.id));
    for (const id of new Set([...pending.keys(), ...timers.keys()])) {
      if (!sessionIds.has(id)) {
        if (pending.has(id)) { clearTimeout(pending.get(id)!); pending.delete(id); }
        if (timers.has(id)) { clearTimeout(timers.get(id)!); timers.delete(id); }
      }
    }
  }, [sessions, subagentMap]);

  const dismissFlash = useCallback((sessionId: string) => {
    const pending = pendingFlashRef.current;
    const pendingTimer = pending.get(sessionId);
    if (pendingTimer) { clearTimeout(pendingTimer); pending.delete(sessionId); }
    const timers = flashTimersRef.current;
    const timer = timers.get(sessionId);
    if (timer) { clearTimeout(timer); timers.delete(sessionId); }
    setFlashingTabs((f) => { const n = new Set(f); n.delete(sessionId); return n; });
  }, []);

  // Initialize once
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    init();
    useUiConfigStore.getState().loadConfig();
    useSettingsStore.getState().loadPastSessions();
    invoke("cleanup_tap_logs", { maxAgeHours: 48 }).catch(() => {});
  }, [init]);

  // [SL-02] Quick launch: Ctrl+Click "+" or Ctrl+Shift+T, uses saved defaults or last config
  const quickLaunch = useCallback(async () => {
    const { savedDefaults, lastConfig } = useSettingsStore.getState();
    const defaults = (savedDefaults && savedDefaults.workingDir.trim()) ? savedDefaults : lastConfig;
    if (!defaults || !defaults.workingDir.trim()) {
      setShowLauncher(true);
      return;
    }
    // [RS-04] One-shot flags cleared: resumeSession, continueSession never persist in lastConfig
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

  // [PS-03] Debounced auto-persist every 2s on session array changes
  useEffect(() => {
    if (sessions.length > 0) {
      const timer = setTimeout(() => persist(), 2000);
      return () => clearTimeout(timer);
    }
  }, [sessions, persist]);

  // [PS-02] [PS-04] beforeunload: kill all active PTY trees + flush persist
  useEffect(() => {
    const handler = () => {
      killAllActivePtys();
      persist();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [persist]);

  // Activate tab — clicking a dead tab auto-resumes it
  const handleTabActivate = useCallback(
    (id: string) => {
      setInspectedSubagent(null);
      dismissFlash(id);
      if (id !== activeTabId) {
        setActiveTab(id);
      } else {
        // [DS-11] Clicking already-active dead tab triggers respawn via requestRespawn
        const session = useSessionStore.getState().sessions.find((s) => s.id === id);
        if (session?.state === "dead" && canResumeSession(session)) {
          useSessionStore.getState().requestRespawn(id, {
            ...session.config,
            resumeSession: getResumeId(session),
            continueSession: false,
            extraFlags: stripWorktreeFlags(session.config.extraFlags),
          });
        }
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

  // Global keyboard shortcuts [KB-01] through [KB-11]
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "t") {
        e.preventDefault();
        if (e.shiftKey) {
          // [SL-02] Ctrl+Shift+T: quick launch without modal
          quickLaunch();
        } else {
          // [KB-01] [SL-01] Ctrl+T: open new session (clears resume/continue)
          const lc = useSettingsStore.getState().lastConfig;
          if (lc.resumeSession || lc.continueSession) {
            setLastConfig({ ...lc, resumeSession: null, continueSession: false });
          }
          setShowLauncher(true);
        }
      }

      // [KB-02] Ctrl+W: close active tab
      if (e.ctrlKey && e.key === "w") {
        e.preventDefault();
        if (activeTabId) handleCloseSession(activeTabId);
      }

      // [KB-06] Ctrl+K: command palette
      if (e.ctrlKey && e.key === "k") {
        e.preventDefault();
        setShowPalette((v) => !v);
      }

      // [KB-03] Ctrl+Shift+R: resume picker
      if (e.ctrlKey && e.shiftKey && e.key === "R") {
        e.preventDefault();
        setShowResumePicker(true);
      }

      // [KB-07] Ctrl+,: config manager
      if (e.ctrlKey && e.key === ",") {
        e.preventDefault();
        setShowConfigManager(showConfigManager ? false : "settings");
      }

      // [DP-02] Ctrl+Shift+D: toggle debug panel
      if (e.ctrlKey && e.shiftKey && e.key === "D") {
        e.preventDefault();
        setSidePanel(sidePanel === "debug" ? null : "debug");
      }

      if (e.ctrlKey && e.shiftKey && e.key === "G") {
        e.preventDefault();
        setSidePanel(sidePanel === "diff" ? null : "diff");
      }

      // [KB-11] Ctrl+Shift+F: cross-session terminal search panel
      if (e.ctrlKey && e.shiftKey && e.key === "F") {
        e.preventDefault();
        setSidePanel(sidePanel === "search" ? null : "search");
      }

      // [KB-09] Escape dismissal chain: contextMenu -> palette -> sidePanel -> config -> resume -> launcher -> inspector
      if (e.key === "Escape") {
        if (tabContextMenu) { setTabContextMenu(null); return; }
        if (showPalette) return;
        if (sidePanel) { setSidePanel(null); return; }
        if (showConfigManager) { setShowConfigManager(false); return; }
        if (showResumePicker) { setShowResumePicker(false); return; }
        if (showLauncher) { setShowLauncher(false); return; }
        if (inspectedSubagent) { e.preventDefault(); setInspectedSubagent(null); return; }
        const el = document.activeElement as HTMLElement;
        if (el && !el.closest('.xterm')) el.blur();
      }

      // [KB-04] Ctrl+Tab/Ctrl+Shift+Tab: cycle tabs
      // [DS-10] Ctrl+Tab skips dead tabs (filters to non-dead pool, fallback to full)
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        const nonMeta = sessions.filter((s) => !s.isMetaAgent);
        const live = nonMeta.filter((s) => s.state !== "dead");
        const pool = live.length > 0 ? live : nonMeta;
        const idx = pool.findIndex((s) => s.id === activeTabId);
        if (pool.length > 0) {
          const next = e.shiftKey
            ? (idx - 1 + pool.length) % pool.length
            : (idx + 1) % pool.length;
          setActiveTab(pool[next].id);
        }
      }

      // [KB-05] Alt+1-9: jump to tab N
      if (e.altKey && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const nonMeta = sessions.filter((s) => !s.isMetaAgent);
        const idx = parseInt(e.key) - 1;
        if (idx < nonMeta.length) setActiveTab(nonMeta[idx].id);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTabId, sessions, setActiveTab, closeSession, handleCloseSession, setShowLauncher, showPalette, showLauncher, showResumePicker, showConfigManager, setShowConfigManager, sidePanel, inspectedSubagent, tabContextMenu, quickLaunch]);

  const regularSessions = useMemo(() => sessions.filter((s) => !s.isMetaAgent), [sessions]);
  const groups = useMemo(() => groupSessionsByDir(regularSessions), [regularSessions]);
  const activeSubagent: Subagent | null = inspectedSubagent
    ? (subagentMap.get(inspectedSubagent.sessionId) || []).find(
        (s) => s.id === inspectedSubagent.subagentId
      ) ?? null
    : null;

  // Active session's subagents + skill invocations — unified bar items
  const activeSession = sessions.find((s) => s.id === activeTabId);
  const allSubs = activeTabId ? (subagentMap.get(activeTabId) || []) : [];
  const activeSubs = allSubs.filter((s) => s.state !== "dead");
  // Build agent bar items sorted by timestamp (newest first) � subagents only
  // Skills are shown in CommandBar (they are slash-command results)
  type BarItem = { type: "subagent"; subagent: Subagent; ts: number };
  const barItems = useMemo<BarItem[]>(() => {
    const items: BarItem[] = [];
    for (const sub of activeSubs) items.push({ type: "subagent", subagent: sub, ts: sub.createdAt || 0 });
    items.sort((a, b) => b.ts - a.ts);
    return items;
  }, [subagentMap, activeTabId]); // eslint-disable-line react-hooks/exhaustive-deps

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
              // [TA-01] Tab activity: current tool name from TAP, colored by category
              const activity = getActivityText(session.metadata.currentToolName);
              const activityColor = activity ? toolCategoryColor(session.metadata.currentToolName!) : undefined;

              // Meta row: model | effort | agents (each colored)
              const m = effectiveModel(session);
              const wt = parseWorktreePath(session.config.workingDir);
              const metaSpans: { text: string; color: string; title?: string }[] = [];
              if (m) {
                const vMatch = m.match(/(\d+)[.-](\d+)/);
                const ver = vMatch ? ` ${vMatch[1]}.${vMatch[2]}` : "";
                metaSpans.push({ text: modelLabel(m) + ver, color: modelColor(m) });
              }
              const effort = session.metadata.effortLevel ?? session.config.effort;
              if (effort) metaSpans.push({ text: effort.charAt(0).toUpperCase() + effort.slice(1), color: "var(--accent)" });
              const subs = subagentMap.get(session.id) || [];
              const liveAgents = subs.filter((s) => isSubagentActive(s.state)).length;
              if (liveAgents > 0) metaSpans.push({ text: `${liveAgents} agent${liveAgents > 1 ? "s" : ""}`, color: "var(--text-secondary)" });
              if (wt) metaSpans.push({ text: worktreeAcronym(wt.worktreeName), color: "var(--accent-tertiary)", title: wt.worktreeName });

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
                  title={ctrlHeld ? `Ctrl+Click: Relaunch ${fullName}` : `${fullName} — ${getEffectiveState(session.state, subs)}\n${session.config.workingDir}${wt ? `\nWorktree: ${wt.worktreeName}` : ""}`}
                >
                  <span className={`tab-dot state-${getEffectiveState(session.state, subs)}${inspectorOffSessions.has(session.id) ? " inspector-off" : ""}`} />
                  <span className="tab-label">
                    <span className="tab-name">{fullName}</span>
                    {activity && (
                      <span className="tab-activity" style={{ color: activityColor }}>
                        {activity}
                      </span>
                    )}
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

      {/* Subagent + skill bar — unified livelog, conditional */}
      {barItems.length > 0 && (
        <div className="subagent-bar">
          {barItems.map((item) => {
            if (item.type === "subagent") {
              const sub = item.subagent;
              const isActive = isSubagentActive(sub.state);
              const isIdle = sub.state === "idle";
              const isInterrupted = sub.state === "interrupted";
              const isSelected = inspectedSubagent?.subagentId === sub.id && inspectedSubagent?.sessionId === activeTabId;
              const lastMsg = sub.messages.length > 0
                ? sub.messages[sub.messages.length - 1].text.slice(0, 200)
                : null;
              const metaParts: string[] = [];
              if (sub.agentType) metaParts.push(sub.agentType);
              if (sub.model) metaParts.push(sub.model.replace(/^claude-/, "").split("-")[0]);
              if (sub.totalToolUses != null) metaParts.push(`${sub.totalToolUses} tools`);
              if (sub.durationMs != null) metaParts.push(`${Math.round(sub.durationMs / 1000)}s`);
              // [TR-11] Subagent card with selected highlight when inspector is open
              return (
                <button
                  key={sub.id}
                  className={`subagent-card${isActive ? " subagent-active" : ""}${isIdle ? " subagent-idle" : ""}${isInterrupted ? " subagent-interrupted" : ""}${isSelected ? " subagent-selected" : ""}`}
                  onClick={() => activeTabId && setInspectedSubagent({ sessionId: activeTabId, subagentId: sub.id })}
                  title={sub.description}
                >
                  <span className={`tab-dot state-${sub.state}`} />
                  <span className="subagent-label">
                    <span className="subagent-name">{sub.description}</span>
                    <span className="subagent-summary">
                      {isActive && sub.currentAction ? sub.currentAction : lastMsg || ""}
                    </span>
                    {metaParts.length > 0 && (
                      <span className="subagent-meta">{metaParts.join(" · ")}</span>
                    )}
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
            }
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
        {sidePanel === "debug" && (
          <DebugPanel onClose={() => setSidePanel(null)} />
        )}
        {sidePanel === "diff" && (
          <DiffPanel onClose={() => setSidePanel(null)} />
        )}
        {sidePanel === "search" && (
          <SearchPanel onClose={() => setSidePanel(null)} />
        )}
      </div>

      <CommandBar
        sessionId={activeTabId}
        sessionState={activeSession?.state ?? "dead"}
        ctrlHeld={ctrlHeld}
      />

      <StatusBar />

      {showLauncher && <SessionLauncher key={launcherGeneration} />}
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
            <div className="prune-actions">
              <button onClick={() => {
                closeSession(pruneConfirm.sessionId);
                setPruneConfirm(null);
              }}>Keep worktree</button>
              <button className="prune-actions-danger" onClick={() => {
                const { sessionId, worktreePath, projectRoot } = pruneConfirm;
                setPruneConfirm(null);
                closeSession(sessionId);
                void (async () => {
                  // Kill PTY with timeout — ConPTY cleanup can hang on Windows
                  try {
                    await Promise.race([
                      killPty(sessionId),
                      new Promise<void>(r => setTimeout(r, 8000)), // ConPTY kill can hang on Windows; timeout prevents UI freeze during tab close
                    ]);
                  } catch (err) { dlog("session", sessionId, `prune: killPty failed: ${err}`, "ERR"); }
                  try { await invoke("prune_worktree", { worktreePath, projectRoot }); }
                  catch (err) { dlog("session", sessionId, `prune: git worktree remove failed: ${err}`, "ERR"); }
                })();
              }}>Prune worktree</button>
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
                  {(() => {
                    const cats = tapCategories.get(ctxSession.id);
                    const hasTaps = cats && cats.size > 0;
                    return (
                      <>
                        <div className="tab-context-menu-label">Recording</div>
                        <button
                          className="tab-context-menu-item"
                          onClick={() => {
                            if (hasTaps) {
                              stopAllTaps(ctxSession.id);
                            } else {
                              startAllTaps(ctxSession.id);
                            }
                            setTabContextMenu(null);
                          }}
                        >
                          {hasTaps ? "■ Stop Taps" : "▶ Start Taps"}
                        </button>
                        {hasTaps && (
                          <button
                            className="tab-context-menu-item"
                            onClick={() => {
                              invoke("open_tap_log", { sessionId: ctxSession.id });
                              setTabContextMenu(null);
                            }}
                          >
                            Open Tap Log
                          </button>
                        )}
                      </>
                    );
                  })()}
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

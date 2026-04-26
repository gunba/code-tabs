import { lazy, Suspense, useEffect, useState, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "./store/sessions";
import { useSettingsStore } from "./store/settings";
import { dirToTabName, effectiveModel, getResumeId, getLaunchWorkingDir, modelLabel, modelColor, effortColor, canResumeSession, stripWorktreeFlags, formatTokenCount, eventKindColor, getActivityText } from "./lib/claude";
import { TerminalPanel } from "./components/Terminal/TerminalPanel";

import { SessionLauncher } from "./components/SessionLauncher/SessionLauncher";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { CommandBar } from "./components/CommandBar/CommandBar";
import { CONFIG_MANAGER_CLOSE_REQUEST_EVENT } from "./components/ConfigManager/events";
import { RightPanel } from "./components/RightPanel/RightPanel";
import { ModalOverlay } from "./components/ModalOverlay/ModalOverlay";

import { useCliWatcher } from "./hooks/useCliWatcher";
import { useNotifications } from "./hooks/useNotifications";
import { useCommandDiscovery } from "./hooks/useCommandDiscovery";
import { useProcessMetrics } from "./hooks/useProcessMetrics";
import { useCtrlKey } from "./hooks/useCtrlKey";
import { useUiConfigStore } from "./lib/uiConfig";
import { useVersionStore } from "./store/version";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { killAllActivePtys } from "./lib/ptyProcess";
import { killPty, writeToPty } from "./lib/ptyRegistry";
import { getInspectorPort, disconnectInspectorForSession, reconnectInspectorForSession } from "./lib/inspectorPort";
import { focusTerminal } from "./lib/terminalRegistry";
import { dlog, flushDebugLog } from "./lib/debugLog";
import { IconStop, IconClose, IconReturn, IconGear } from "./components/Icons/Icons";
import { Header } from "./components/Header/Header";
import { groupSessionsByDir, swapWithinGroup, parseWorktreePath, worktreeAcronym, IS_LINUX } from "./lib/paths";
import type { CliKind, Session, Subagent } from "./types/session";
import { isSubagentActive } from "./types/session";
import { getEffectiveState } from "./lib/claude";
import { settledStateManager, type SettledKind } from "./lib/settledState";
import { useRuntimeStore } from "./store/runtime";
import { isCliVersionIncrease, type ChangelogRequest } from "./lib/changelog";
import "./App.css";

const ChangelogModal = lazy(() => import("./components/ChangelogModal/ChangelogModal").then((m) => ({ default: m.ChangelogModal })));
const CommandPalette = lazy(() => import("./components/CommandPalette/CommandPalette").then((m) => ({ default: m.CommandPalette })));
const ConfigManager = lazy(() => import("./components/ConfigManager/ConfigManager").then((m) => ({ default: m.ConfigManager })));
const ContextViewer = lazy(() => import("./components/ContextViewer/ContextViewer").then((m) => ({ default: m.ContextViewer })));
const ResumePicker = lazy(() => import("./components/ResumePicker/ResumePicker").then((m) => ({ default: m.ResumePicker })));
const SubagentInspector = lazy(() => import("./components/SubagentInspector/SubagentInspector").then((m) => ({ default: m.SubagentInspector })));

// [DF-04] React re-renders from Zustand store: tab state dots, status bar, subagent cards
export default function App() {
  const init = useSessionStore((s) => s.init);
  const loadRuntimeInfo = useRuntimeStore((s) => s.loadRuntimeInfo);
  const devtoolsAvailable = useRuntimeStore((s) => s.observabilityInfo.devtoolsAvailable);
  const debugBuild = useRuntimeStore((s) => s.observabilityInfo.debugBuild);
  const openMainDevtools = useRuntimeStore((s) => s.openMainDevtools);
  const sessions = useSessionStore((s) => s.sessions);
  const initialized = useSessionStore((s) => s.initialized);
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const setActiveTab = useSessionStore((s) => s.setActiveTab);
  const closeSession = useSessionStore((s) => s.closeSession);
  const createSession = useSessionStore((s) => s.createSession);
  const persist = useSessionStore((s) => s.persist);
  const reorderTabs = useSessionStore((s) => s.reorderTabs);
  const requestKill = useSessionStore((s) => s.requestKill);
  const inspectorOffSessions = useSessionStore((s) => s.inspectorOffSessions);
  const setInspectorOff = useSessionStore((s) => s.setInspectorOff);
  const showLauncher = useSettingsStore((s) => s.showLauncher);
  const launcherGeneration = useSettingsStore((s) => s.launcherGeneration);
  const setShowLauncher = useSettingsStore((s) => s.setShowLauncher);
  const setLastConfig = useSettingsStore((s) => s.setLastConfig);
  const showConfigManager = useSettingsStore((s) => s.showConfigManager);
  const setShowConfigManager = useSettingsStore((s) => s.setShowConfigManager);
  const [showPalette, setShowPalette] = useState(false);
  const [showResumePicker, setShowResumePicker] = useState(false);
  const [showContextViewer, setShowContextViewer] = useState(false);
  const [changelogRequest, setChangelogRequest] = useState<ChangelogRequest | null>(null);
  const [inspectedSubagent, setInspectedSubagent] = useState<{ sessionId: string; subagentId: string } | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const [settledTabs, setSettledTabs] = useState<Map<string, SettledKind>>(new Map());
  const ctrlHeld = useCtrlKey();
  const dragTabRef = useRef<string | null>(null);
  const initRef = useRef(false);
  const handledCliVersionRef = useRef<Partial<Record<CliKind, string>>>({});
  const [pruneConfirm, setPruneConfirm] = useState<{
    sessionId: string; worktreePath: string; worktreeName: string; projectRoot: string;
  } | null>(null);
  useCliWatcher();
  useNotifications();
  useCommandDiscovery();
  useProcessMetrics();

  // Feed settled-state manager from effective state changes.
  // Replaces per-consumer ad-hoc debounce with a unified hysteresis system.
  const subagentMap = useSessionStore((s) => s.subagents);
  useEffect(() => {
    const subagents = useSessionStore.getState().subagents;
    for (const s of sessions) {
      const effState = getEffectiveState(s.state, subagents.get(s.id) || []);
      settledStateManager.update(s.id, effState);
    }
    // Clean up removed sessions
    const sessionIds = new Set(sessions.map((s) => s.id));
    for (const id of settledStateManager._getTrackedSessions()) {
      if (!sessionIds.has(id)) settledStateManager.removeSession(id);
    }
  }, [sessions, subagentMap]);

  // Subscribe to settled-state changes for tab styling
  useEffect(() => {
    return settledStateManager.subscribe(
      (sid, kind) => setSettledTabs((prev) => new Map(prev).set(sid, kind)),
      (sid) => setSettledTabs((prev) => { const n = new Map(prev); n.delete(sid); return n; }),
    );
  }, []);

  // Initialize once
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    void (async () => {
      await loadRuntimeInfo();
      await init();
      useUiConfigStore.getState().loadConfig();
      useSettingsStore.getState().loadPastSessions();
      useSettingsStore.getState().pruneRecentDirs();
      invoke("migrate_legacy_data").catch(() => {});
      // [HM-11] Startup intentionally does not install or mutate Claude hook
      // settings; hook changes are user-managed via the Hooks UI only.
      invoke("cleanup_session_data", { maxAgeHours: 72 }).catch(() => {});
      // Version + update checks: fire after init (non-blocking, failures ignored)
      useVersionStore.getState().loadBuildInfo();
      useVersionStore.getState().checkForAppUpdate();
      useVersionStore.getState().checkLatestCliVersion();
    })();
  }, [init, loadRuntimeInfo]);

  // Dynamic window title with version info
  const appVersion = useVersionStore((s) => s.appVersion);
  const cliVersions = useSettingsStore((s) => s.cliVersions);
  const lastOpenedCliVersions = useSettingsStore((s) => s.lastOpenedCliVersions);
  const setLastOpenedCliVersion = useSettingsStore((s) => s.setLastOpenedCliVersion);
  useEffect(() => {
    const parts = ["Code Tabs"];
    if (appVersion) parts[0] += ` v${appVersion}`;
    parts.push(`Claude ${cliVersions.claude ?? "not installed"}`);
    parts.push(`Codex ${cliVersions.codex ?? "not installed"}`);
    getCurrentWindow().setTitle(parts.join(" · ")).catch(() => {});
  }, [appVersion, cliVersions]);

  useEffect(() => {
    const ranges: ChangelogRequest["ranges"] = {};
    for (const cli of ["claude", "codex"] as const) {
      const current = cliVersions[cli];
      if (!current) continue;
      if (handledCliVersionRef.current[cli] === current) continue;
      handledCliVersionRef.current[cli] = current;

      const previous = lastOpenedCliVersions[cli];
      if (previous && isCliVersionIncrease(current, previous)) {
        ranges[cli] = { fromVersion: previous, toVersion: current };
      }
      if (previous !== current) {
        setLastOpenedCliVersion(cli, current);
      }
    }

    const changedCli = (["claude", "codex"] as const).find((cli) => ranges[cli]);
    if (changedCli && !changelogRequest) {
      setChangelogRequest({
        kind: "startup",
        initialCli: changedCli,
        ranges,
      });
    }
  }, [changelogRequest, cliVersions, lastOpenedCliVersions, setLastOpenedCliVersion]);

  // [PL-01] Linux custom titlebar: tauri.conf.json sets decorations:false globally so non-KDE
  // Wayland compositors honor it at window creation. Non-Linux re-enables native decorations
  // at runtime. KDE+Wayland is a known upstream Tauri bug (issues #6162/#6562 — KWin ignores
  // decorations:false from wry's GTK-Wayland window), so on that combo we restore native
  // decorations and skip our custom Header to avoid a duplicated titlebar.
  const [useNativeChrome, setUseNativeChrome] = useState(false);
  useEffect(() => {
    (async () => {
      const native = IS_LINUX ? await invoke<boolean>("linux_use_native_chrome").catch(() => false) : true;
      setUseNativeChrome(native);
      if (native) {
        await getCurrentWindow().setDecorations(true).catch(() => {});
      }
    })();
  }, []);

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
    const { claudePath, codexPath } = useSessionStore.getState();
    const installedCli = [
      ...(claudePath ? ["claude" as const] : []),
      ...(codexPath ? ["codex" as const] : []),
    ];
    if (installedCli.length === 0) {
      setShowLauncher(true);
      return;
    }
    if (!installedCli.includes(cleanConfig.cli)) {
      cleanConfig.cli = installedCli[0];
    }
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
      void flushDebugLog();
      persist();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [persist]);

  const relaunchDeadSession = useCallback(async (session: Session) => {
    const resumeConfig = {
      ...session.config,
      workingDir: getLaunchWorkingDir(session),
      launchWorkingDir: getLaunchWorkingDir(session),
      resumeSession: getResumeId(session),
      continueSession: false,
      extraFlags: stripWorktreeFlags(session.config.extraFlags),
    };
    const insertAtIndex = sessions.findIndex((s) => s.id === session.id);
    const name = session.name || dirToTabName(getLaunchWorkingDir(session));

    try {
      await createSession(
        name,
        resumeConfig,
        insertAtIndex >= 0 ? { insertAtIndex } : undefined,
      );
      await closeSession(session.id);
    } catch (err) {
      dlog("session", session.id, `dead tab relaunch failed: ${err}`, "ERR");
      setActiveTab(session.id);
    }
  }, [closeSession, createSession, sessions, setActiveTab]);

  // Activate tab — dead tabs relaunch explicitly, live tabs are focused.
  const handleTabActivate = useCallback(
    (id: string) => {
      setInspectedSubagent(null);
      settledStateManager.clearSettled(id);
      if (activeTabId && activeTabId !== id && settledTabs.get(activeTabId) === "idle") {
        settledStateManager.clearSettled(activeTabId);
      }
      const session = sessions.find((s) => s.id === id);
      if (!session) return;

      if (session.state === "dead" && canResumeSession(session)) {
        void relaunchDeadSession(session);
        return;
      }

      if (id !== activeTabId) {
        setActiveTab(id);
      }
    },
    [activeTabId, relaunchDeadSession, sessions, setActiveTab, settledTabs]
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
      // [DS-05] Resume picker opens regardless of current session state.
      if (e.ctrlKey && e.shiftKey && e.key === "R") {
        e.preventDefault();
        setShowResumePicker(true);
      }

      // [KB-11] Ctrl+Shift+F: open RightPanel search tab (cross-session terminal search)
      if (e.ctrlKey && e.shiftKey && e.key === "F") {
        e.preventDefault();
        useSettingsStore.getState().setRightPanelTab("search");
      }

      // [KB-07] Ctrl+,: config manager
      if (e.ctrlKey && e.key === ",") {
        e.preventDefault();
        if (showConfigManager) {
          window.dispatchEvent(new Event(CONFIG_MANAGER_CLOSE_REQUEST_EVENT));
        } else {
          setShowConfigManager("settings");
        }
      }

      if (devtoolsAvailable && e.ctrlKey && e.shiftKey && e.key === "I") {
        e.preventDefault();
        openMainDevtools().catch(() => {});
      }

      // [KB-09] Escape dismissal chain: contextMenu -> palette -> changelog -> contextViewer -> config -> resume -> launcher -> inspector
      if (e.key === "Escape") {
        if (tabContextMenu) { setTabContextMenu(null); return; }
        if (showPalette) return;
        if (changelogRequest) { setChangelogRequest(null); return; }
        if (showContextViewer) { setShowContextViewer(false); return; }
        if (showConfigManager) { window.dispatchEvent(new Event(CONFIG_MANAGER_CLOSE_REQUEST_EVENT)); return; }
        if (showResumePicker) { setShowResumePicker(false); return; }
        if (showLauncher) { setShowLauncher(false); return; }
        if (inspectedSubagent) { e.preventDefault(); setInspectedSubagent(null); return; }
        const el = document.activeElement as HTMLElement | null;
        if (el && !el.closest('.xterm')) {
          e.preventDefault();
          el.blur();
          if (activeTabId) {
            requestAnimationFrame(() => focusTerminal(activeTabId));
          }
        } else if (activeTabId) {
          writeToPty(activeTabId, '\x1b');
        }
      }

      // [KB-04] Ctrl+Tab/Ctrl+Shift+Tab: cycle live tabs only
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        const pool = sessions.filter((s) => !s.isMetaAgent && s.state !== "dead");
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
  }, [activeTabId, sessions, setActiveTab, closeSession, handleCloseSession, setShowLauncher, showPalette, showLauncher, showResumePicker, showConfigManager, setShowConfigManager, changelogRequest, showContextViewer, inspectedSubagent, tabContextMenu, quickLaunch, devtoolsAvailable, openMainDevtools]);

  const regularSessions = useMemo(() => sessions.filter((s) => !s.isMetaAgent), [sessions]);
  const groups = useMemo(() => groupSessionsByDir(regularSessions), [regularSessions]);
  const activeSubagent: Subagent | null = inspectedSubagent
    ? (subagentMap.get(inspectedSubagent.sessionId) || []).find(
        (s) => s.id === inspectedSubagent.subagentId
      ) ?? null
    : null;

  // Active session's subagents + skill invocations — unified bar items
  const activeSession = sessions.find((s) => s.id === activeTabId);
  // [PO-01] Provider-scoped accents: app-provider-{cli} root class swaps --accent palette to the active session's CLI; per-tab .tab-cli-{cli} keeps inactive tabs colored by their own CLI.
  const activeProvider = activeSession?.config.cli ?? "claude";
  const allSubs = activeTabId ? (subagentMap.get(activeTabId) || []) : [];
  // Build agent bar items sorted by timestamp (newest first) — subagents only
  // Skills are shown in CommandBar (they are slash-command results)
  type BarItem = { type: "subagent"; subagent: Subagent; ts: number };
  const barItems = useMemo<BarItem[]>(() => {
    const items: BarItem[] = [];
    for (const sub of allSubs) {
      // Skip CLI-internal sidechains that may have leaked through
      if (sub.id.startsWith("aside_question")) continue;
      items.push({ type: "subagent", subagent: sub, ts: sub.createdAt || 0 });
    }
    items.sort((a, b) => b.ts - a.ts);
    return items;
  }, [subagentMap, activeTabId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`app app-provider-${activeProvider}${ctrlHeld ? " ctrl-held" : ""}`}>
      {IS_LINUX && !useNativeChrome && <Header />}
      {/* Tab bar */}
      {/* [LO-01] Main window layout: tab bar (here), subagent bar, terminal area, CommandBar (slash commands + skill pills + history), StatusBar. */}
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
              // [TA-01] Tab activity: raw event kind from TAP, colored by event phase
              const activity = getActivityText(session.metadata.currentToolName, session.metadata.currentEventKind);
              const activityColor = activity ? eventKindColor(session.metadata.currentEventKind ?? session.metadata.currentToolName!) : undefined;

              // Status row: event/state | model | effort | agents | worktree | context
              const m = effectiveModel(session);
              const wt = parseWorktreePath(session.config.workingDir);
              const statusSpans: { text: string; color: string; title?: string }[] = [];
              if (m) {
                const label = modelLabel(m);
                const resolved = label !== m; // modelLabel shortened it to a family name
                const vMatch = m.match(/(\d+)[.-](\d+)/);
                const ver = resolved && vMatch ? ` ${vMatch[1]}.${vMatch[2]}` : "";
                statusSpans.push({ text: label + ver, color: modelColor(m) });
              }
              const effort = session.config.effort ?? session.metadata.effortLevel;
              if (effort) statusSpans.push({ text: effort.charAt(0).toUpperCase() + effort.slice(1), color: effortColor(effort) });
              const subs = subagentMap.get(session.id) || [];
              const effectiveState = getEffectiveState(session.state, subs);
              const activityText = activity ?? effectiveState;
              const liveAgents = subs.filter((s) => isSubagentActive(s.state)).length;
              if (liveAgents > 0) statusSpans.push({ text: `${liveAgents} agent${liveAgents > 1 ? "s" : ""}`, color: "var(--text-secondary)" });
              if (wt) statusSpans.push({ text: worktreeAcronym(wt.worktreeName), color: "var(--accent-tertiary)", title: wt.worktreeName });
              // [SI-25] When Status hook data exists, surface the current
              // context footprint in the tab status row. Fall back to contextDebug (SSE-derived).
              const sl = session.metadata.statusLine;
              if (sl) {
                const totalCtx = sl.cacheCreationInputTokens + sl.cacheReadInputTokens + sl.currentInputTokens;
                if (totalCtx > 0) {
                  statusSpans.push({
                    text: formatTokenCount(totalCtx),
                    color: "var(--text-muted)",
                    title: `Context: ${sl.currentInputTokens.toLocaleString()} input + ${sl.cacheReadInputTokens.toLocaleString()} cache read + ${sl.cacheCreationInputTokens.toLocaleString()} cache write`,
                  });
                }
              } else if (session.metadata.contextDebug) {
                const dbg = session.metadata.contextDebug;
                if (dbg.totalContextTokens > 0) {
                  statusSpans.push({
                    text: formatTokenCount(dbg.totalContextTokens),
                    color: "var(--text-muted)",
                    title: `Context: ${dbg.inputTokens.toLocaleString()} input + ${dbg.cacheRead.toLocaleString()} cache read + ${dbg.cacheCreation.toLocaleString()} cache write`,
                  });
                }
              }

              return (
                <div
                  key={session.id}
                  className={`tab tab-cli-${session.config.cli}${isActive ? " tab-active" : ""}${isDead ? " tab-dead" : ""}${session.config.runMode ? " tab-run" : ""}${dragOverTabId === session.id ? " tab-drag-over" : ""}${settledTabs.get(session.id) === "idle" ? " tab-settled-idle" : ""}${settledTabs.get(session.id) === "actionNeeded" || settledTabs.get(session.id) === "waitingPermission" ? " tab-settled-action" : ""}`}
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
                    if (e.ctrlKey && canResumeSession(session)) {
                      setLastConfig({
                        ...session.config,
                        workingDir: getLaunchWorkingDir(session),
                        launchWorkingDir: getLaunchWorkingDir(session),
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
                  onMouseEnter={() => settledStateManager.clearSettled(session.id)}
                  title={ctrlHeld ? `Ctrl+Click: Relaunch ${fullName}` : `${fullName} — ${effectiveState}\n${session.config.workingDir}${wt ? `\nWorktree: ${wt.worktreeName}` : ""}`}
                >
                  <span className={`tab-dot state-${effectiveState}${inspectorOffSessions.has(session.id) ? " inspector-off" : ""}`} />
                  <span className="tab-label">
                    <span className="tab-name">{fullName}</span>
                    <span
                      className={`tab-cli-row tab-cli-row-${session.config.cli}`}
                      title={session.config.cli === "codex" ? "Codex" : "Claude Code"}
                    >
                      {session.config.cli === "codex" ? "Codex" : "Claude"}
                    </span>
                    <span className="tab-status-row">
                      <span style={{ color: activityColor ?? "var(--text-secondary)" }}>
                        {activityText}
                      </span>
                      {statusSpans.map((s, i) => (
                        <span key={i}>
                          <span style={{ color: "var(--text-muted)", opacity: 0.5 }}> &middot; </span>
                          <span style={{ color: s.color }} title={s.title}>{s.text}</span>
                        </span>
                      ))}
                    </span>
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
              const isCompleted = !!sub.completed;
              const isDead = sub.state === "dead" && !isCompleted;
              const isIdle = sub.state === "idle";
              const isInterrupted = sub.state === "interrupted";
              const isSelected = inspectedSubagent?.subagentId === sub.id && inspectedSubagent?.sessionId === activeTabId;
              // [TA-06] Subagent activity: same display as parent tabs
              const subActivity = getActivityText(sub.currentToolName, sub.currentEventKind);
              const subActivityColor = subActivity ? eventKindColor(sub.currentEventKind ?? sub.currentToolName!) : undefined;
              const typeLabel = sub.subagentType || sub.agentType;
              const subStatusText = subActivity ?? (isCompleted ? "Completed" : sub.state);
              const subStatusColor = subActivityColor ?? (isCompleted ? "var(--success)" : "var(--text-secondary)");
              const subStatusSpans: string[] = [];
              if (sub.totalToolUses != null) subStatusSpans.push(`${sub.totalToolUses} tools`);
              if (sub.durationMs != null) subStatusSpans.push(`${Math.round(sub.durationMs / 1000)}s`);
              if (sub.tokenCount > 0) subStatusSpans.push(formatTokenCount(sub.tokenCount));
              // [TA-08] Completed subagents stay visible in the bar with success styling/checkmark.
              // [TR-11] Subagent card with selected highlight when inspector is open
              return (
                <button
                  key={sub.id}
                  className={`subagent-card${isActive ? " subagent-active" : ""}${isCompleted ? " subagent-completed" : ""}${isDead ? " subagent-dead" : ""}${isIdle ? " subagent-idle" : ""}${isInterrupted ? " subagent-interrupted" : ""}${isSelected ? " subagent-selected" : ""}`}
                  onClick={() => activeTabId && setInspectedSubagent({ sessionId: activeTabId, subagentId: sub.id })}
                  title={sub.description}
                >
                  {isCompleted
                    ? <span className="subagent-check" />
                    : <span className={`tab-dot state-${sub.state}`} />
                  }
                  <span className="subagent-label">
                    <span className="subagent-name">{sub.description}</span>
                    <span className="subagent-type">{typeLabel ?? "Agent"}</span>
                    <span className="subagent-status-row">
                      <span style={{ color: subStatusColor }}>
                        {subStatusText}
                      </span>
                      {subStatusSpans.map((part, i) => (
                        <span key={i}>
                          <span style={{ color: "var(--text-muted)", opacity: 0.5 }}> &middot; </span>
                          <span>{part}</span>
                        </span>
                      ))}
                    </span>
                  </span>
                </button>
              );
            }
          })}
        </div>
      )}

      {/* Main area: terminals */}
      <div className="app-main">
        <div className="terminal-column">
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
              <Suspense fallback={null}>
                <SubagentInspector
                  key={activeSubagent.id}
                  subagent={activeSubagent}
                  onClose={() => setInspectedSubagent(null)}
                />
              </Suspense>
            )}

            {/* Empty state — no active terminal visible */}
            {initialized && !regularSessions.some((s) => s.id === activeTabId) && (
              <div className="empty-state">
                <kbd>Ctrl+T</kbd> new session &middot; <kbd>Ctrl+Shift+R</kbd> resume from history
              </div>
            )}
          </div>
          <CommandBar
            sessionId={activeTabId}
            sessionState={activeSession?.state ?? "dead"}
            ctrlHeld={ctrlHeld}
          />
        </div>
        <RightPanel />
      </div>

      <StatusBar
        onOpenContextViewer={() => setShowContextViewer(true)}
        onOpenChangelog={() => setChangelogRequest({
          kind: "manual",
          initialCli: activeProvider,
          ranges: {},
        })}
      />

      {showLauncher && <SessionLauncher key={launcherGeneration} />}
      {showResumePicker && (
        <Suspense fallback={null}>
          <ResumePicker onClose={() => setShowResumePicker(false)} />
        </Suspense>
      )}
      {showPalette && (
        <Suspense fallback={null}>
          <CommandPalette onClose={() => setShowPalette(false)} />
        </Suspense>
      )}
      {showConfigManager && (
        <Suspense fallback={null}>
          <ConfigManager />
        </Suspense>
      )}
      {changelogRequest && (
        <Suspense fallback={null}>
          <ChangelogModal
            request={changelogRequest}
            currentVersions={cliVersions}
            onClose={() => setChangelogRequest(null)}
          />
        </Suspense>
      )}
      {showContextViewer && activeSession && (
        <Suspense fallback={null}>
          <ContextViewer
            metadata={activeSession.metadata}
            subagents={subagentMap.get(activeSession.id) || []}
            onClose={() => setShowContextViewer(false)}
          />
        </Suspense>
      )}

      {/* Worktree prune confirmation */}
      {pruneConfirm && (
        <ModalOverlay onClose={() => setPruneConfirm(null)}>
          <div className="prune-dialog">
            <div className="prune-title">
              Close worktree session
              <button className="prune-close" onClick={() => setPruneConfirm(null)} title="Close (Esc)">
                <IconClose size={12} />
              </button>
            </div>
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
                  {debugBuild && (
                    <>
                      <div className="tab-context-menu-label">Observability</div>
                      <button
                        className="tab-context-menu-item"
                        onClick={() => {
                          invoke("open_session_data_dir", { sessionId: ctxSession.id });
                          setTabContextMenu(null);
                        }}
                      >
                        Open Session Data
                      </button>
                      <button
                        className="tab-context-menu-item"
                        onClick={() => {
                          invoke("open_tap_log", { sessionId: ctxSession.id });
                          setTabContextMenu(null);
                        }}
                      >
                        Open Tap Log
                      </button>
                      <button
                        className="tab-context-menu-item"
                        onClick={() => {
                          invoke("open_observability_log", { sessionId: ctxSession.id });
                          setTabContextMenu(null);
                        }}
                      >
                        Open Observability Log
                      </button>
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
                  {regularSessions.length > 1 && (
                    <button
                      className="tab-context-menu-item"
                      onClick={() => {
                        for (const s of regularSessions) {
                          if (s.id !== ctxSession.id) closeSession(s.id);
                        }
                        setTabContextMenu(null);
                      }}
                    >
                      Close Other Tabs
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
                  <button
                    className="tab-context-menu-item tab-context-menu-item-danger"
                    onClick={() => {
                      for (const s of regularSessions) closeSession(s.id);
                      setTabContextMenu(null);
                    }}
                  >
                    Close All Tabs ({regularSessions.length})
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

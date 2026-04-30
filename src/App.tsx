import { lazy, Suspense, useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "./store/sessions";
import { useSettingsStore } from "./store/settings";
import { getResumeId, getLaunchWorkingDir, canResumeSession } from "./lib/claude";
import { TerminalPanel } from "./components/Terminal/TerminalPanel";

import { SessionLauncher } from "./components/SessionLauncher/SessionLauncher";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { CommandBar } from "./components/CommandBar/CommandBar";
import { RightPanel } from "./components/RightPanel/RightPanel";

import { useCliWatcher } from "./hooks/useCliWatcher";
import { useNotifications } from "./hooks/useNotifications";
import { useCommandDiscovery } from "./hooks/useCommandDiscovery";
import { useProcessMetrics } from "./hooks/useProcessMetrics";
import { useCtrlKey } from "./hooks/useCtrlKey";
import { useStartupBootstrap } from "./hooks/useStartupBootstrap";
import { useSessionPersistence } from "./hooks/useSessionPersistence";
import { useWindowTitle } from "./hooks/useWindowTitle";
import { useChangelogOnVersionBump } from "./hooks/useChangelogOnVersionBump";
import { useNativeChrome as useNativeChromeHook } from "./hooks/useNativeChrome";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { killPty } from "./lib/ptyRegistry";
import { dlog } from "./lib/debugLog";
import { Header } from "./components/Header/Header";
import { groupSessionsByDir, parseWorktreePath, IS_LINUX } from "./lib/paths";
import type { Session, Subagent } from "./types/session";
import { getEffectiveState } from "./lib/claude";
import { settledStateManager, type SettledKind } from "./lib/settledState";
import { useRuntimeStore } from "./store/runtime";
import type { ChangelogRequest } from "./lib/changelog";
import { TabBar } from "./components/TabBar/TabBar";
import { SubagentBar } from "./components/SubagentBar/SubagentBar";
import { TabContextMenu, type TabContextMenuRequest } from "./components/TabContextMenu/TabContextMenu";
import { PruneDialog, type PruneRequest } from "./components/PruneDialog/PruneDialog";
import { quickLaunchSession } from "./lib/quickLaunch";
import { relaunchDeadSession } from "./lib/sessionRelaunch";
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
  const devtoolsEnabled = useRuntimeStore((s) => s.observabilityInfo.devtoolsEnabled);
  const observabilityEnabled = useRuntimeStore((s) => s.observabilityInfo.observabilityEnabled);
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
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenuRequest | null>(null);
  const [settledTabs, setSettledTabs] = useState<Map<string, SettledKind>>(new Map());
  const ctrlHeld = useCtrlKey();
  const [pruneConfirm, setPruneConfirm] = useState<PruneRequest | null>(null);
  useCliWatcher();
  useNotifications();
  useCommandDiscovery();
  useProcessMetrics();
  useStartupBootstrap({ init, loadRuntimeInfo });
  useSessionPersistence({ sessions, persist });
  useWindowTitle();
  useChangelogOnVersionBump({ changelogRequest, setChangelogRequest });
  const nativeChrome = useNativeChromeHook();

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

  const cliVersions = useSettingsStore((s) => s.cliVersions);

  // [SL-02] Quick launch: Ctrl+Click "+" or Ctrl+Shift+T, uses saved defaults or last config
  const quickLaunch = useCallback(async () => {
    await quickLaunchSession({
      createSession,
      openLauncher: () => setShowLauncher(true),
    });
  }, [createSession, setShowLauncher]);

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
        void relaunchDeadSession({
          session,
          sessions,
          createSession,
          closeSession,
          setActiveTab,
        });
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

  useKeyboardShortcuts({
    activeTabId,
    sessions,
    showPalette,
    showLauncher,
    showResumePicker,
    showConfigManager,
    changelogRequest,
    showContextViewer,
    inspectedSubagent,
    tabContextMenu,
    devtoolsEnabled,
  }, {
    quickLaunch: () => void quickLaunch(),
    closeActiveTab: handleCloseSession,
    setActiveTab,
    setLastConfig,
    setShowPalette,
    setShowLauncher,
    setShowResumePicker,
    setShowConfigManager,
    setChangelogRequest,
    setShowContextViewer,
    setInspectedSubagent,
    setTabContextMenu,
    openMainDevtools,
  });

  const regularSessions = sessions.filter((s) => !s.isMetaAgent);
  const groups = groupSessionsByDir(regularSessions);
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

  const handleRelaunchWithOptions = useCallback((session: Session) => {
    setLastConfig({
      ...session.config,
      workingDir: getLaunchWorkingDir(session),
      launchWorkingDir: getLaunchWorkingDir(session),
      resumeSession: getResumeId(session),
      continueSession: false,
    });
    useSettingsStore.getState().setReplaceSessionId(session.id);
    setShowLauncher(true);
  }, [setLastConfig, setShowLauncher]);

  const handleKeepWorktree = useCallback((request: PruneRequest) => {
    closeSession(request.sessionId);
    setPruneConfirm(null);
  }, [closeSession]);

  const handlePruneWorktree = useCallback((request: PruneRequest) => {
    const { sessionId, worktreePath, projectRoot } = request;
    setPruneConfirm(null);
    closeSession(sessionId);
    void (async () => {
      try {
        await killPty(sessionId);
      } catch (err) {
        dlog("session", sessionId, `prune: killPty failed: ${err}`, "ERR");
      }
      try {
        await invoke("prune_worktree", { worktreePath, projectRoot });
      } catch (err) {
        dlog("session", sessionId, `prune: git worktree remove failed: ${err}`, "ERR");
      }
    })();
  }, [closeSession]);

  return (
    <div className={`app app-provider-${activeProvider}${ctrlHeld ? " ctrl-held" : ""}`}>
      {IS_LINUX && !nativeChrome && <Header />}
      {/* [LO-01] Main window layout: tab bar, subagent bar, terminal area, CommandBar (slash commands + skill pills + history), StatusBar. */}
      <TabBar
        groups={groups}
        regularSessions={regularSessions}
        activeTabId={activeTabId}
        subagentMap={subagentMap}
        settledTabs={settledTabs}
        inspectorOffSessions={inspectorOffSessions}
        ctrlHeld={ctrlHeld}
        onActivate={handleTabActivate}
        onCloseSession={handleCloseSession}
        onRequestKill={requestKill}
        onReorderTabs={reorderTabs}
        onRelaunchWithOptions={handleRelaunchWithOptions}
        onOpenContextMenu={setTabContextMenu}
        onClearSettled={(sessionId) => settledStateManager.clearSettled(sessionId)}
        onOpenResumePicker={() => setShowResumePicker(true)}
        onOpenConfigManager={() => setShowConfigManager("settings")}
        onOpenLauncher={() => setShowLauncher(true)}
        onQuickLaunch={() => void quickLaunch()}
      />

      <SubagentBar
        subagents={allSubs}
        activeProvider={activeProvider}
        activeTabId={activeTabId}
        inspectedSubagent={inspectedSubagent}
        onInspect={(sessionId, subagentId) => setInspectedSubagent({ sessionId, subagentId })}
      />

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
            sessionId={activeSession.id}
            cli={activeSession.config.cli}
            onClose={() => setShowContextViewer(false)}
          />
        </Suspense>
      )}

      {/* Worktree prune confirmation */}
      {pruneConfirm && (
        <PruneDialog
          request={pruneConfirm}
          onClose={() => setPruneConfirm(null)}
          onKeepWorktree={handleKeepWorktree}
          onPruneWorktree={handlePruneWorktree}
        />
      )}

      {/* Tab context menu portal */}
      {tabContextMenu && (
        <TabContextMenu
          menu={tabContextMenu}
          sessions={sessions}
          groups={groups}
          regularSessions={regularSessions}
          observabilityEnabled={observabilityEnabled}
          inspectorOffSessions={inspectorOffSessions}
          onClose={() => setTabContextMenu(null)}
          onCloseSession={handleCloseSession}
          onCloseSessionImmediate={closeSession}
          onSetLastConfig={setLastConfig}
          onSetInspectorOff={setInspectorOff}
          onSetShowLauncher={setShowLauncher}
        />
      )}
    </div>
  );
}

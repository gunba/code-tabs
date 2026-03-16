import { useEffect, useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "./store/sessions";
import { useSettingsStore } from "./store/settings";
import { dirToTabName, formatTokenCount, sessionColor } from "./lib/claude";
import { TerminalPanel } from "./components/Terminal/TerminalPanel";
import { SubagentInspector } from "./components/SubagentInspector/SubagentInspector";
import { ActivityFeed } from "./components/ActivityFeed/ActivityFeed";
import { SessionLauncher } from "./components/SessionLauncher/SessionLauncher";
import { ResumePicker } from "./components/ResumePicker/ResumePicker";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { CommandBar } from "./components/CommandBar/CommandBar";
import { CommandPalette } from "./components/CommandPalette/CommandPalette";
import { HooksManager } from "./components/HooksManager/HooksManager";

import { useCliWatcher } from "./hooks/useCliWatcher";
import { useNotifications } from "./hooks/useNotifications";
import { useCommandDiscovery } from "./hooks/useCommandDiscovery";

import { useUiConfigStore } from "./lib/uiConfig";
import { startTestHarness } from "./lib/testHarness";
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
  const updateMetadata = useSessionStore((s) => s.updateMetadata);
  const updateSubagent = useSessionStore((s) => s.updateSubagent);
  const reorderTabs = useSessionStore((s) => s.reorderTabs);
  const showLauncher = useSettingsStore((s) => s.showLauncher);
  const setShowLauncher = useSettingsStore((s) => s.setShowLauncher);
  const setLastConfig = useSettingsStore((s) => s.setLastConfig);
  const showHooksManager = useSettingsStore((s) => s.showHooksManager);
  const setShowHooksManager = useSettingsStore((s) => s.setShowHooksManager);
  const [showPalette, setShowPalette] = useState(false);
  const [showResumePicker, setShowResumePicker] = useState(false);
  const [inspectedSubagent, setInspectedSubagent] = useState<{ sessionId: string; subagentId: string } | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const dragTabRef = useRef<string | null>(null);
  const initRef = useRef(false);

  useCliWatcher();
  useNotifications();
  useCommandDiscovery();

  // Initialize once
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    init();
    useUiConfigStore.getState().loadConfig();
    startTestHarness();
  }, [init]);


  // Auto-persist sessions on changes (debounced)
  useEffect(() => {
    if (sessions.length > 0) {
      const timer = setTimeout(() => persist(), 2000);
      return () => clearTimeout(timer);
    }
  }, [sessions, persist]);

  // Revive dead sessions or switch to live ones
  const handleTabActivate = useCallback(
    async (id: string) => {
      const session = sessions.find((s) => s.id === id);
      if (!session) return;

      if (session.state === "dead") {
        // Use the original CLI session ID for resume. After a revival,
        // resumeSession holds the original ID while sessionId gets overwritten
        // to the app's internal ID. The JSONL file lives under the original.
        const resumeId = session.config.resumeSession || session.config.sessionId || session.id;
        const hasConversation = await invoke<boolean>("session_has_conversation", {
          sessionId: resumeId,
          workingDir: session.config.workingDir,
        }).catch(() => false);
        const config = {
          ...session.config,
          continueSession: false,
          resumeSession: hasConversation ? resumeId : null,
        };
        const name = session.name || dirToTabName(session.config.workingDir);
        const idx = sessions.findIndex((s) => s.id === id);
        // Preserve metadata (nodeSummary, tokens, etc.) across revival
        const savedMetadata = { ...session.metadata };
        try {
          await closeSession(id);
          const newSession = await createSession(name, config, { insertAtIndex: idx });
          // Restore the old session's summary and accumulated metadata
          updateMetadata(newSession.id, {
            nodeSummary: savedMetadata.nodeSummary,
            inputTokens: savedMetadata.inputTokens,
            outputTokens: savedMetadata.outputTokens,
            assistantMessageCount: savedMetadata.assistantMessageCount,
          });
          setActiveTab(newSession.id);
        } catch (err) {
          console.error("Failed to revive session:", err);
        }
      } else {
        // Always dismiss subagent inspector when switching tabs
        if (inspectedSubagent) {
          setInspectedSubagent(null);
        }
        if (id !== activeTabId) {
          setActiveTab(id);
        }
      }
    },
    [sessions, activeTabId, inspectedSubagent, setActiveTab, closeSession, createSession, updateMetadata]
  );

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "t") {
        e.preventDefault();
        setShowLauncher(true);
      }

      if (e.ctrlKey && e.key === "w") {
        e.preventDefault();
        if (activeTabId) closeSession(activeTabId);
      }

      if (e.ctrlKey && e.key === "k") {
        e.preventDefault();
        setShowPalette((v) => !v);
      }

      if (e.ctrlKey && e.key === "r") {
        e.preventDefault();
        setShowResumePicker(true);
      }

      if (e.key === "Escape") {
        if (tabContextMenu) { setTabContextMenu(null); return; }
        if (showPalette) return;
        if (showHooksManager) { setShowHooksManager(false); return; }
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

      if (e.ctrlKey && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const nonMeta = sessions.filter((s) => !s.isMetaAgent);
        const idx = parseInt(e.key) - 1;
        if (idx < nonMeta.length) setActiveTab(nonMeta[idx].id);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTabId, sessions, setActiveTab, closeSession, setShowLauncher, showPalette, showLauncher, showResumePicker, showHooksManager, setShowHooksManager, inspectedSubagent, tabContextMenu]);

  const regularSessions = sessions.filter((s) => !s.isMetaAgent);
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
    <div className="app">
      {/* Tab bar — always visible */}
      <div className="tab-bar">
          <div className="tab-bar-scroll">
            {regularSessions.map((session) => {
              const isActive = session.id === activeTabId;
              const name = session.name || dirToTabName(session.config.workingDir);
              const isDead = session.state === "dead";
              const summary = session.metadata.nodeSummary ?? session.metadata.currentAction;

              return (
                <button
                  key={session.id}
                  className={`tab${isActive ? " tab-active" : ""}${isDead ? " tab-dead" : ""}`}
                  draggable
                  onDragStart={() => { dragTabRef.current = session.id; }}
                  onDragOver={(e) => { e.preventDefault(); }}
                  onDrop={() => {
                    const from = dragTabRef.current;
                    if (from && from !== session.id) {
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
                  onDragEnd={() => { dragTabRef.current = null; }}
                  onClick={(e) => {
                    if (e.shiftKey) {
                      const resumeId = session.config.resumeSession || session.config.sessionId || session.id;
                      setLastConfig({
                        ...session.config,
                        workingDir: session.config.workingDir,
                        resumeSession: resumeId,
                        continueSession: false,
                      });
                      useSettingsStore.getState().setReplaceSessionId(session.id);
                      setShowLauncher(true);
                    } else {
                      handleTabActivate(session.id);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setTabContextMenu({ x: e.clientX, y: e.clientY, sessionId: session.id });
                  }}
                  title={`${name} — ${session.state}\n${session.config.workingDir}`}
                >
                  <span className={`tab-dot state-${session.state}`} />
                  <span className="tab-label">
                    <span className="tab-name" style={{ textShadow: `0 0 12px ${sessionColor(session.id)}90, 0 0 4px ${sessionColor(session.id)}60` }}>{name}</span>
                    {summary && <span className="tab-summary">{summary}</span>}
                  </span>
                  <button
                      className="tab-close"
                      onClick={(e) => { e.stopPropagation(); closeSession(session.id); }}
                      title="Close"
                    >
                      ×
                    </button>
                </button>
              );
            })}
          </div>
          <button
            className="tab-resume"
            onClick={() => setShowResumePicker(true)}
            title="Resume session (from Claude history)"
          >
            ↩
          </button>
          <button
            className="tab-add"
            onClick={() => setShowLauncher(true)}
            title="New session (Ctrl+T)"
          >
            +
          </button>
        </div>

      {/* Subagent row — conditional, only for active session */}
      {activeSubs.length > 0 && (
        <div className="subagent-bar">
          {activeSubs.map((sub) => {
            const isActive = sub.state === "thinking" || sub.state === "toolUse" || sub.state === "starting";
            const lastMsg = sub.messages.length > 0
              ? sub.messages[sub.messages.length - 1].text.slice(0, 200)
              : null;
            return (
              <button
                key={sub.id}
                className={`subagent-card${isActive ? " subagent-active" : ""}`}
                onClick={() => activeTabId && setInspectedSubagent({ sessionId: activeTabId, subagentId: sub.id })}
                title={sub.description}
              >
                <span className="subagent-icon">→</span>
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
                  >×</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Main area: terminal + activity feed */}
      <div className="app-main">
        <div className="terminal-area">
          {/* Terminal panels — always mounted, hidden via CSS */}
          {regularSessions.filter((s) => s.state !== "dead").map((session) => (
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
          {initialized && !regularSessions.some((s) => s.id === activeTabId && s.state !== "dead") && (
            <div className="empty-state">
              <kbd>Ctrl+T</kbd> new session &middot; <kbd>Ctrl+R</kbd> resume from history
            </div>
          )}
        </div>

        <ActivityFeed />
      </div>

      <CommandBar
        sessionId={activeTabId}
        sessionState={activeSession?.state ?? "dead"}
        subagents={activeSubs}
      />

      <StatusBar />

      {showLauncher && <SessionLauncher />}
      {showResumePicker && <ResumePicker onClose={() => setShowResumePicker(false)} />}
      {showPalette && <CommandPalette onClose={() => setShowPalette(false)} />}
      {showHooksManager && <HooksManager onClose={() => setShowHooksManager(false)} />}

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
                  {isDead && (
                    <button
                      className="tab-context-menu-item"
                      onClick={() => {
                        const resumeId = ctxSession.config.resumeSession || ctxSession.config.sessionId || ctxSession.id;
                        setLastConfig({
                          ...ctxSession.config,
                          resumeSession: resumeId,
                          workingDir: ctxSession.config.workingDir,
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
                        closeSession(ctxSession.id);
                        setTabContextMenu(null);
                      }}
                    >
                      Close
                    </button>
                  )}
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

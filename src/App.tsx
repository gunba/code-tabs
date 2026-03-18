import { useEffect, useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { useSessionStore } from "./store/sessions";
import { useSettingsStore } from "./store/settings";
import { dirToTabName, formatTokenCount, sessionColor, getSessionColorIndex, forceSessionColor, getResumeId } from "./lib/claude";
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
  const renameSession = useSessionStore((s) => s.renameSession);
  const showLauncher = useSettingsStore((s) => s.showLauncher);
  const setShowLauncher = useSettingsStore((s) => s.setShowLauncher);
  const setLastConfig = useSettingsStore((s) => s.setLastConfig);
  const showHooksManager = useSettingsStore((s) => s.showHooksManager);
  const setShowHooksManager = useSettingsStore((s) => s.setShowHooksManager);
  const [showPalette, setShowPalette] = useState(false);
  const [showResumePicker, setShowResumePicker] = useState(false);
  const [inspectedSubagent, setInspectedSubagent] = useState<{ sessionId: string; subagentId: string } | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabName, setEditingTabName] = useState("");
  const [revivingTabId, setRevivingTabId] = useState<string | null>(null);
  const [flashingTabs, setFlashingTabs] = useState<Set<string>>(new Set());
  const [shiftHeld, setShiftHeld] = useState(false);
  const prevStatesRef = useRef<Map<string, string>>(new Map());
  const dragTabRef = useRef<string | null>(null);
  const initRef = useRef(false);

  useCliWatcher();
  useNotifications();
  useCommandDiscovery();

  // Track state transitions — briefly flash tabs that become idle from an active state
  useEffect(() => {
    const prev = prevStatesRef.current;
    for (const s of sessions) {
      const prevState = prev.get(s.id);
      if (prevState && prevState !== "idle" && prevState !== "dead" && prevState !== "starting" && s.state === "idle") {
        setFlashingTabs((f) => new Set(f).add(s.id));
        setTimeout(() => {
          setFlashingTabs((f) => { const n = new Set(f); n.delete(s.id); return n; });
        }, 1500);
      }
      // Clear reviving spinner once session leaves starting state
      if (revivingTabId === s.id && prevState === "starting" && s.state !== "starting") {
        setRevivingTabId(null);
      }
      prev.set(s.id, s.state);
    }
  }, [sessions, revivingTabId]);

  // Initialize once
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    init();
    useUiConfigStore.getState().loadConfig();
    useSettingsStore.getState().loadPastSessions();
    startTestHarness();
  }, [init]);

  // Track Shift key state for visual indicators
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === "Shift") setShiftHeld(true); };
    const up = (e: KeyboardEvent) => { if (e.key === "Shift") setShiftHeld(false); };
    const blur = () => setShiftHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // Quick launch with saved defaults (Shift+click "+" or Ctrl+Shift+T)
  const quickLaunch = useCallback(async () => {
    const defaults = useSettingsStore.getState().savedDefaults;
    if (!defaults || !defaults.workingDir.trim()) {
      setShowLauncher(true);
      return;
    }
    const cleanConfig = { ...defaults, resumeSession: null, continueSession: false, sessionId: null };
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

  // Flush persist on window close so sessions survive app restart
  useEffect(() => {
    window.addEventListener("beforeunload", persist);
    return () => window.removeEventListener("beforeunload", persist);
  }, [persist]);

  // Revive dead sessions or switch to live ones
  const handleTabActivate = useCallback(
    async (id: string) => {
      const session = sessions.find((s) => s.id === id);
      if (!session) return;

      if (session.state === "dead") {
        setRevivingTabId(id);
        // Use the original CLI session ID for resume. After a revival,
        // resumeSession holds the original ID while sessionId gets overwritten
        // to the app's internal ID. The JSONL file lives under the original.
        const resumeId = getResumeId(session);
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
          // Capture color before close releases it
          const savedColorIdx = getSessionColorIndex(id);
          // Create new session first, THEN close old one — avoids visual gap
          const newSession = await createSession(name, config, { insertAtIndex: idx });
          if (savedColorIdx >= 0) forceSessionColor(newSession.id, savedColorIdx);
          updateMetadata(newSession.id, {
            nodeSummary: savedMetadata.nodeSummary,
            inputTokens: savedMetadata.inputTokens,
            outputTokens: savedMetadata.outputTokens,
            assistantMessageCount: savedMetadata.assistantMessageCount,
          });
          setActiveTab(newSession.id);
          setRevivingTabId(newSession.id);
          // Close old dead tab after new one is visible
          await closeSession(id);
        } catch (err) {
          console.error("Failed to revive session:", err);
          setRevivingTabId(null);
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
  }, [activeTabId, sessions, setActiveTab, closeSession, setShowLauncher, showPalette, showLauncher, showResumePicker, showHooksManager, setShowHooksManager, inspectedSubagent, tabContextMenu, quickLaunch]);

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
    <div className={`app${shiftHeld ? " shift-held" : ""}`}>
      {/* Tab bar */}
      <div className="tab-bar">
          <div className="tab-bar-scroll">
            {regularSessions.map((session) => {
              const isActive = session.id === activeTabId;
              const name = session.name || dirToTabName(session.config.workingDir);
              const isDead = session.state === "dead";
              const summary = session.metadata.nodeSummary ?? session.metadata.currentAction;

              return (
                <div
                  key={session.id}
                  className={`tab${isActive ? " tab-active" : ""}${isDead ? " tab-dead" : ""}${dragOverTabId === session.id ? " tab-drag-over" : ""}${session.state === "waitingPermission" && isActive ? " tab-permission" : ""}${flashingTabs.has(session.id) ? " tab-flash" : ""}${revivingTabId === session.id ? " tab-reviving" : ""}`}
                  role="button"
                  tabIndex={0}
                  draggable
                  onDragStart={(e) => {
                    dragTabRef.current = session.id;
                    // Use a minimal drag image to reduce visual jank
                    const ghost = document.createElement("div");
                    ghost.textContent = name;
                    ghost.style.cssText = "position:absolute;top:-999px;padding:4px 8px;background:var(--bg-surface);color:var(--text-primary);font-size:11px;border-radius:4px;white-space:nowrap;";
                    document.body.appendChild(ghost);
                    e.dataTransfer.setDragImage(ghost, 0, 0);
                    setTimeout(() => document.body.removeChild(ghost), 0);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (dragTabRef.current && dragTabRef.current !== session.id) {
                      setDragOverTabId(session.id);
                    }
                  }}
                  onDragLeave={() => {
                    if (dragOverTabId === session.id) setDragOverTabId(null);
                  }}
                  onDrop={() => {
                    setDragOverTabId(null);
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
                  onDragEnd={() => { dragTabRef.current = null; setDragOverTabId(null); }}
                  onClick={(e) => {
                    if (e.shiftKey) {
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
                    // Only activate on Enter/Space when not editing the rename input
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
                  title={shiftHeld ? `Shift+Click: Relaunch ${name}` : `${name} — ${session.state}\n${session.config.workingDir}`}
                >
                  <span className={`tab-dot state-${session.state}`} />
                  <span className="tab-label">
                    {editingTabId === session.id ? (
                      <input
                        className="tab-name-input"
                        value={editingTabName}
                        onChange={(e) => setEditingTabName(e.target.value)}
                        onBlur={() => {
                          if (editingTabName.trim()) {
                            renameSession(session.id, editingTabName.trim());
                          }
                          setEditingTabId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            if (editingTabName.trim()) {
                              renameSession(session.id, editingTabName.trim());
                            }
                            setEditingTabId(null);
                          }
                          if (e.key === "Escape") setEditingTabId(null);
                          e.stopPropagation();
                        }}
                        onClick={(e) => e.stopPropagation()}
                        autoFocus
                      />
                    ) : (
                      <span className="tab-name" style={{ textShadow: `0 0 12px ${sessionColor(session.id)}90, 0 0 4px ${sessionColor(session.id)}60` }}>{name}</span>
                    )}
                    {summary && editingTabId !== session.id && <span className="tab-summary">{summary}</span>}
                  </span>
                  <span className="tab-actions">
                    <button
                      className="tab-edit"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingTabId(session.id);
                        setEditingTabName(name);
                      }}
                      title="Rename"
                    >
                      ✎
                    </button>
                    <button
                      className="tab-close"
                      onClick={(e) => { e.stopPropagation(); closeSession(session.id); }}
                      title="Close"
                    >
                      ×
                    </button>
                  </span>
                </div>
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
            onClick={(e) => e.shiftKey ? quickLaunch() : setShowLauncher(true)}
            title={shiftHeld ? "Quick launch with saved defaults (Ctrl+Shift+T)" : "New session (Ctrl+T)"}
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
              <kbd>Ctrl+T</kbd> new session &middot; <kbd>Ctrl+R</kbd> resume from history
            </div>
          )}
        </div>

        <ActivityFeed />
      </div>

      <CommandBar
        sessionId={activeTabId}
        sessionState={activeSession?.state ?? "dead"}
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
                      shellOpen(ctxSession.config.workingDir);
                      setTabContextMenu(null);
                    }}
                  >
                    Open in Explorer
                  </button>
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

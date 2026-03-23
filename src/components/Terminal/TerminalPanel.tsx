import { useEffect, useRef, useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTerminal } from "../../hooks/useTerminal";
import { usePty } from "../../hooks/usePty";
import { useSessionStore } from "../../store/sessions";
import { buildClaudeArgs, getResumeId, formatTokenCount, canResumeSession } from "../../lib/claude";
import { allocateInspectorPort, registerInspectorPort, unregisterInspectorPort, registerInspectorCallbacks, unregisterInspectorCallbacks } from "../../lib/inspectorPort";
import { useInspectorState } from "../../hooks/useInspectorState";
import { registerPtyWriter, unregisterPtyWriter } from "../../lib/ptyRegistry";
import { registerBufferReader, unregisterBufferReader, registerTailReader, unregisterTailReader } from "../../lib/terminalRegistry";
import { useSettingsStore } from "../../store/settings";
import type { Session, SessionConfig, SessionState } from "../../types/session";
import "@xterm/xterm/css/xterm.css";
import "./TerminalPanel.css";

interface TerminalPanelProps {
  session: Session;
  visible: boolean;
}

// ── Dead Session Overlay ─────────────────────────────────────────────────

interface DeadOverlayProps {
  session: Session;
  triggerRespawnRef: React.RefObject<(config?: SessionConfig, name?: string) => void>;
  closeSession: (id: string) => void;
}

function DeadOverlay({ session, triggerRespawnRef, closeSession }: DeadOverlayProps) {
  if (session.config.runMode) {
    return (
      <div className="dead-overlay dead-overlay-run">
        <div className="dead-overlay-card">
          <div className="dead-overlay-title">Command complete</div>
          <div className="dead-overlay-actions">
            <button className="dead-overlay-btn" onClick={() => closeSession(session.id)}>
              Close tab
            </button>
          </div>
          <div className="dead-overlay-hint">
            <kbd>Ctrl+W</kbd> close
          </div>
        </div>
      </div>
    );
  }

  const canResume = canResumeSession(session);
  return (
    <div className="dead-overlay">
      <div className="dead-overlay-card">
        <div className="dead-overlay-title">Session ended</div>
        <div className="dead-overlay-actions">
          {canResume && (
            <button
              className="dead-overlay-btn dead-overlay-btn-primary"
              onClick={() => triggerRespawnRef.current()}
            >
              Resume
            </button>
          )}
          <button
            className="dead-overlay-btn"
            onClick={() => {
              window.dispatchEvent(new KeyboardEvent("keydown", { key: "R", ctrlKey: true, shiftKey: true }));
            }}
          >
            Resume other...
          </button>
        </div>
        <div className="dead-overlay-actions">
          <button
            className="dead-overlay-btn"
            onClick={() => {
              const freshConfig: SessionConfig = {
                ...session.config,
                resumeSession: null,
                continueSession: false,
                sessionId: null,
              };
              triggerRespawnRef.current(freshConfig);
            }}
          >
            New session
          </button>
        </div>
        <div className="dead-overlay-hint">
          {canResume ? (
            <><kbd>Enter</kbd> resume &middot; <kbd>Ctrl+Shift+R</kbd> browse</>
          ) : (
            <><kbd>Ctrl+Shift+R</kbd> browse</>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Duration Timer (active time only) ────────────────────────────────────

const ACTIVE_STATES = new Set<SessionState>(["thinking", "toolUse", "actionNeeded", "waitingPermission", "error"]);

function useDurationTimer(sessionId: string, state: SessionState): void {
  const updateMetadata = useSessionStore((s) => s.updateMetadata);
  const accumulatedRef = useRef(0);
  const lastTickRef = useRef(Date.now());
  const lastStateRef = useRef(state);

  // Track state changes so we know when we transition active↔idle
  lastStateRef.current = state;

  useEffect(() => {
    if (state === "dead") return;

    const interval = setInterval(() => {
      const now = Date.now();
      const dt = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;

      if (ACTIVE_STATES.has(lastStateRef.current)) {
        accumulatedRef.current += dt;
        const secs = Math.floor(accumulatedRef.current);
        updateMetadata(sessionId, { durationSecs: secs });
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [sessionId, state === "dead", updateMetadata]);
}

// ── Terminal Panel ──────────────────────────────────────────────────────

export function TerminalPanel({ session, visible }: TerminalPanelProps) {
  const claudePath = useSessionStore((s) => s.claudePath);
  const updateState = useSessionStore((s) => s.updateState);
  const updateConfig = useSessionStore((s) => s.updateConfig);
  const renameSession = useSessionStore((s) => s.renameSession);
  const respawnRequest = useSessionStore((s) => s.respawnRequest);
  const clearRespawnRequest = useSessionStore((s) => s.clearRespawnRequest);
  const killRequest = useSessionStore((s) => s.killRequest);
  const clearKillRequest = useSessionStore((s) => s.clearKillRequest);
  const closeSession = useSessionStore((s) => s.closeSession);
  const hookChangeCounter = useSessionStore((s) => s.hookChangeCounter);
  const spawnedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [respawnCounter, setRespawnCounter] = useState(0);
  const [inspectorReconnectKey, setInspectorReconnectKey] = useState(0);

  // Inspector port: allocated async in doSpawn via OS probe (check_port_available IPC).
  // State triggers re-render so useInspectorState receives the port after allocation.
  const [inspectorPort, setInspectorPort] = useState<number | null>(null);
  const inspector = useInspectorState(
    session.state !== "dead" ? session.id : null,
    inspectorPort,
    inspectorReconnectKey
  );

  // Register inspector disconnect/reconnect callbacks for external debugger support
  useEffect(() => {
    registerInspectorCallbacks(session.id, {
      disconnect: inspector.disconnect,
      reconnect: () => setInspectorReconnectKey((k) => k + 1),
    });
    return () => unregisterInspectorCallbacks(session.id);
  }, [session.id, inspector.disconnect]);

  const [loading, setLoading] = useState(!!session.config.resumeSession);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [showScrollTopBtn, setShowScrollTopBtn] = useState(false);
  const [queuedInput, setQueuedInput] = useState<string | null>(null);
  const lastHookChangeRef = useRef(hookChangeCounter);

  // Hide loading spinner when inspector connects (session is running and responsive)
  useEffect(() => {
    if (loading && inspector.connected) setLoading(false);
  }, [loading, inspector.connected]);

  // Sync Claude's internal session ID into config for persistence (plan-mode forks, compaction)
  const prevClaudeSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!inspector.claudeSessionId) return;
    const prev = prevClaudeSessionIdRef.current;
    prevClaudeSessionIdRef.current = inspector.claudeSessionId;
    // Clear terminal when session ID changes (context clear, plan approval, compaction)
    if (prev && prev !== inspector.claudeSessionId) {
      terminal.termRef.current?.clear();
    }
    if (inspector.claudeSessionId !== session.config.sessionId) {
      updateConfig(session.id, { sessionId: inspector.claudeSessionId });
    }
  }, [inspector.claudeSessionId, session.id, session.config.sessionId, updateConfig]);

  // Cache session config when inspector connects (for resume picker fallback)
  useEffect(() => {
    if (inspector.connected && session.config.sessionId) {
      useSettingsStore.getState().cacheSessionConfig(session.config.sessionId, session.config);
    }
  }, [inspector.connected, session.id, session.config.sessionId]);

  // Duration timer
  useDurationTimer(session.id, session.state);

  // Use a ref to break the circular dependency:
  // handlePtyData needs terminal, terminal needs handleTermData, which needs pty,
  // and pty needs handlePtyData. We use terminalRef to avoid forward-referencing.
  const terminalRef = useRef<ReturnType<typeof useTerminal> | null>(null);
  // Buffer PTY data for background tabs — skip xterm.js writes when not visible,
  // flush in one write when the tab becomes visible. Saves O(N) rendering cost.
  const visibleRef = useRef(visible);
  const bgBufferRef = useRef<Uint8Array[]>([]);
  visibleRef.current = visible;

  // Detect "session already in use" errors in early PTY output
  const earlyOutputRef = useRef("");
  const sessionInUseRef = useRef(false);
  const sessionInUseRetried = useRef(false);

  const handlePtyData = useCallback(
    (data: Uint8Array) => {
      // Accumulate early output for error detection (first ~4KB)
      if (earlyOutputRef.current.length < 4096) {
        const text = new TextDecoder().decode(data);
        earlyOutputRef.current += text;
        if (/already in use/i.test(earlyOutputRef.current)) {
          sessionInUseRef.current = true;
        }
      }
      // Only write to xterm.js if the tab is visible; buffer otherwise
      if (visibleRef.current) {
        terminalRef.current?.writeBytes(data);
      } else {
        bgBufferRef.current.push(data);
      }
    },
    []
  );

  // External process holding the session — shown when user must confirm kill
  const [externalHolder, setExternalHolder] = useState<number[] | null>(null);

  const handlePtyExit = useCallback(
    (info: { exitCode: number }) => {
      console.log(`[TerminalPanel] handlePtyExit session=${session.id} code=${info.exitCode}`);
      // If the CLI exited because the session is already in use,
      // try to kill stale orphans (our own descendants) and retry.
      if (sessionInUseRef.current && !sessionInUseRetried.current) {
        sessionInUseRef.current = false;
        sessionInUseRetried.current = true;
        earlyOutputRef.current = "";
        const resumeId = getResumeId(session);

        invoke<{ killed: number; external: number[] }>("kill_session_holder", { sessionId: resumeId })
          .then((result) => {
            if (result.external.length > 0 && result.killed === 0) {
              // Held by external process — ask user before killing
              setExternalHolder(result.external);
              updateState(session.id, "dead");
            } else {
              // Killed our own orphans (or mixed) — retry
              terminalRef.current?.write(
                "\r\n\x1b[90m[Killed stale session, retrying...]\x1b[0m\r\n"
              );
              setTimeout(() => triggerRespawnRef.current(), 500);
            }
          })
          .catch(() => {
            updateState(session.id, "dead");
          });
        return;
      }
      // Cascade dead state to all subagents so they get cleaned up from canvas
      const subagents = useSessionStore.getState().subagents.get(session.id) || [];
      const { updateSubagent } = useSessionStore.getState();
      for (const sub of subagents) {
        updateSubagent(session.id, sub.id, { state: "dead" });
      }
      updateState(session.id, "dead");
    },
    [session.id, session.config.resumeSession, session.config.sessionId, updateState]
  );

  const pty = usePty({ onData: handlePtyData, onExit: handlePtyExit });

  // ── In-tab respawn ────────────────────────────────────────────────────
  const triggerRespawnRef = useRef<(config?: SessionConfig, name?: string) => void>(() => {});
  // Stable ref so callbacks can call triggerRespawn without stale closures
  triggerRespawnRef.current = (config?: SessionConfig, name?: string) => {
    console.log(`[TerminalPanel] respawn triggered session=${session.id}`);
    // 1. Clean up old PTY, watchers, and inspector
    pty.cleanup();
    inspector.disconnect();
    unregisterPtyWriter(session.id);
    unregisterInspectorPort(session.id);
    useSessionStore.getState().setInspectorOff(session.id, false);

    // 2. Determine config (default: resume if conversation exists)
    const canResume = canResumeSession(session);
    const newConfig: SessionConfig = config ?? {
      ...session.config,
      resumeSession: canResume ? getResumeId(session) : null,
      continueSession: false,
    };

    // 3. Update session in store
    updateConfig(session.id, newConfig);
    if (name) renameSession(session.id, name);

    // 4. Visual feedback + loading spinner for resumed sessions
    // [PT-11] Clear stale buffers before terminal reset
    bgBufferRef.current = [];
    deferredResizeRef.current = null;
    terminal.clearPending();
    terminalRef.current?.write("\x1bc");  // RIS: full terminal reset
    terminal.fit();
    terminalRef.current?.write("\x1b[90m[Resuming...]\x1b[0m\r\n");
    setLoading(!!newConfig.resumeSession);

    // 5. Reset internal state (inspector port allocated in doSpawn)
    lastPtyDimsRef.current = null;
    spawnedRef.current = false;
    earlyOutputRef.current = "";
    sessionInUseRef.current = false;
    sessionInUseRetried.current = false;
    setExternalHolder(null);
    setInspectorPort(null);

    // 6. Trigger re-spawn
    updateState(session.id, "starting");
    setRespawnCounter((c) => c + 1);
  };

  // Accumulate user keystrokes for command history detection.
  // Reading from xterm.js buffer is racy — PTY echo goes through write batching
  // and xterm.js processes writes async, so the buffer may be stale on Enter.
  const inputAccRef = useRef("");

  const handleTermData = useCallback(
    (data: string) => {
      // Swallow all input when session is dead (overlay handles actions)
      if (session.state === "dead") {
        if (!session.config.runMode && (data === "\r" || data === "\n")) {
          triggerRespawnRef.current();
        }
        return;
      }
      // Track user input for command history detection
      if (data === "\r") {
        const input = inputAccRef.current.trim();
        if (input && input.startsWith("/")) {
          useSessionStore.getState().addCommandHistory(session.id, input.split(" ")[0]);
        }
        inputAccRef.current = "";
      } else if (data === "\x7f" || data === "\b") {
        inputAccRef.current = inputAccRef.current.slice(0, -1);
      } else if (data === "\x15" || data === "\x03") {
        inputAccRef.current = "";
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        inputAccRef.current += data;
      } else if (data.length > 1 && !data.startsWith("\x1b")) {
        inputAccRef.current += data;
      }
      pty.handle.current?.write(data);
    },
    // pty.handle is a stable ref — omitted from deps intentionally
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.state]
  );

  const lastPtyDimsRef = useRef<{ cols: number; rows: number } | null>(null);
  const deferredResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const handleResize = useCallback(
    (cols: number, rows: number) => {
      const last = lastPtyDimsRef.current;
      if (last && last.cols === cols && last.rows === rows) return;
      lastPtyDimsRef.current = { cols, rows };
      // Defer the PTY resize if bgBuffer has pending data. The resize triggers
      // a ConPTY repaint + ink full re-render; if xterm.js hasn't caught up yet
      // (buffer not flushed), the repaint duplicates content into scrollback.
      if (bgBufferRef.current.length > 0) {
        deferredResizeRef.current = { cols, rows };
        return;
      }
      pty.handle.current?.resize(cols, rows);
    },
    // pty.handle and bgBufferRef are stable refs — omitted from deps intentionally
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const terminal = useTerminal({
    onData: handleTermData,
    onResize: handleResize,
  });
  terminalRef.current = terminal;

  // Attach terminal to container
  const setContainer = useCallback(
    (el: HTMLDivElement | null) => {
      containerRef.current = el;
      terminal.attach(el);
    },
    [terminal]
  );

  // Spawn PTY once (respawnCounter triggers re-spawn)
  useEffect(() => {
    if (spawnedRef.current || !claudePath || session.state === "dead") return;

    const doSpawn = async () => {
      spawnedRef.current = true;
      try {
        // Allocate a verified-free inspector port before spawning.
        // Register immediately so concurrent allocations (multi-tab restore) skip it.
        const inspPort = await allocateInspectorPort();
        registerInspectorPort(session.id, inspPort);
        setInspectorPort(inspPort);

        const args = await buildClaudeArgs(session.config);
        terminal.fit(); // Force fit before reading dimensions
        const { cols, rows } = terminal.getDimensions();
        // Normalize path slashes for Windows PTY spawn
        const cwd = session.config.workingDir.replace(/\//g, "\\");
        // Pass BUN_INSPECT env for inspector-based state detection
        const env = { BUN_INSPECT: `ws://127.0.0.1:${inspPort}/0` };
        const handle = await pty.spawn(claudePath, args, cwd, cols, rows, env);
        registerPtyWriter(session.id, handle.write);
        updateState(session.id, "idle");

        // Post-spawn dimension verification — catches cases where font metrics
        // or WebGL renderer weren't ready during the initial fit.
        requestAnimationFrame(() => {
          terminal.fit();
          const { cols: c, rows: r } = terminal.getDimensions();
          if (c !== cols || r !== rows) {
            handle.resize(c, r);
          }
        });
      } catch (err) {
        console.error("Failed to spawn PTY:", err);
        updateState(session.id, "error");
        terminal.write(
          `\r\n\x1b[31mFailed to start Claude: ${err}\x1b[0m\r\n`
        );
      }
    };

    const timer = setTimeout(doSpawn, 50);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudePath, session.id, respawnCounter]);

  // Auto-resume dead tabs when they become visible (tab switch or startup).
  // Only fires on hidden→visible transitions, NOT when state changes to "dead"
  // while the tab is already visible (user should see the dead overlay in that case).
  const prevVisibleRef = useRef(false);
  useEffect(() => {
    const becameVisible = visible && !prevVisibleRef.current;
    prevVisibleRef.current = visible;
    if (!becameVisible || session.state !== "dead" || !claudePath) return;
    if (!canResumeSession(session)) return;
    const timer = setTimeout(() => triggerRespawnRef.current(), 150);
    return () => clearTimeout(timer);
  }, [visible, session.state, claudePath]);

  // Register terminal buffer readers for transcript export and selector detection
  useEffect(() => {
    registerBufferReader(session.id, terminal.getBufferText);
    registerTailReader(session.id, terminal.getBufferTail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, terminal.getBufferText, terminal.getBufferTail]);

  // Cleanup PTY and registries on unmount
  useEffect(() => {
    const id = session.id;
    return () => {
      unregisterPtyWriter(id);
      unregisterBufferReader(id);
      unregisterTailReader(id);
      unregisterInspectorPort(id);
      unregisterInspectorCallbacks(id);
      pty.cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Watch for respawn requests from ResumePicker or other components
  useEffect(() => {
    if (respawnRequest?.tabId === session.id && session.state === "dead") {
      clearRespawnRequest();
      triggerRespawnRef.current(respawnRequest.config, respawnRequest.name);
    }
  }, [respawnRequest, session.state, session.id, clearRespawnRequest]);

  // Watch for kill requests from the tab bar
  useEffect(() => {
    if (killRequest === session.id && session.state !== "dead") {
      clearKillRequest();
      console.log(`[TerminalPanel] kill effect triggered for session=${session.id}`);
      pty.cleanup();
      // pty.kill() fires exitCallback → handlePtyExit → state "dead"
    }
  }, [killRequest, session.id, session.state, clearKillRequest, pty]);

  // Re-fit and focus when becoming visible — only depends on visible and session.id.
  // terminal is NOT in deps because useTerminal returns a new object on every render,
  // which would cause this effect to re-fire on every store update, calling fit()
  // repeatedly and flashing the terminal.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let rafInner: number | undefined;
    const raf1 = requestAnimationFrame(() => {
      rafInner = requestAnimationFrame(() => {
        if (cancelled) return;
        // Flush background buffer FIRST — write all buffered data in one batch
        // so xterm.js catches up to ConPTY before any resize is sent.
        const chunks = bgBufferRef.current;
        if (chunks.length > 0) {
          bgBufferRef.current = [];
          let totalLen = 0;
          for (const c of chunks) totalLen += c.length;
          const merged = new Uint8Array(totalLen);
          let offset = 0;
          for (const c of chunks) { merged.set(c, offset); offset += c.length; }
          terminal.termRef.current?.write(merged);
        }
        terminal.fit();
        // Send any deferred PTY resize now that the buffer has been flushed
        const deferred = deferredResizeRef.current;
        if (deferred) {
          deferredResizeRef.current = null;
          pty.handle.current?.resize(deferred.cols, deferred.rows);
        }
        terminal.termRef.current?.scrollToBottom();
        terminal.focus();
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      if (rafInner !== undefined) cancelAnimationFrame(rafInner);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, session.id]);

  // Fix GPU texture corruption after OS sleep / display power-off.
  // clearTextureAtlas() rebuilds the glyph atlas (xterm.js docs recommend
  // this for Chromium/Nvidia sleep bugs), refresh() forces a full redraw.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible" || !visible) return;
      const term = terminal.termRef.current;
      if (!term) return;
      term.clearTextureAtlas();
      term.refresh(0, term.rows - 1);
      terminal.fit();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
    // terminal is NOT in deps — useTerminal returns a new object each render.
    // visible is needed to re-capture its value in the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Queue input handler: read from xterm.js buffer (authoritative), or cancel if already queued
  const handleQueueInput = useCallback(() => {
    if (queuedInput) {
      setQueuedInput(null);
      return;
    }
    const text = terminalRef.current?.getCurrentInput() ?? "";
    if (!text) return;
    pty.handle.current?.write("\x15"); // Clear terminal input line
    setQueuedInput(text);
    // pty.handle and terminalRef are stable refs — omitted from deps intentionally
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuedInput]);

  // Auto-send queued input when session becomes idle, clear if session dies
  useEffect(() => {
    if (!queuedInput) return;
    if (session.state === "dead") { setQueuedInput(null); return; }
    if (session.state !== "idle") return;
    const timer = setTimeout(() => {
      pty.handle.current?.write(queuedInput + "\r");
      setQueuedInput(null);
    }, 800);
    return () => clearTimeout(timer);
    // pty.handle is a stable ref — omitted from deps intentionally
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.state, queuedInput]);

  // Auto-restart session when hooks change, same timing as queued input
  useEffect(() => {
    if (hookChangeCounter <= lastHookChangeRef.current) return;
    if (session.state === "dead") { lastHookChangeRef.current = hookChangeCounter; return; }
    if (session.state !== "idle") return;
    const timer = setTimeout(() => {
      lastHookChangeRef.current = hookChangeCounter;
      triggerRespawnRef.current();
    }, 800);
    return () => clearTimeout(timer);
  }, [session.state, hookChangeCounter]);

  // Poll scroll position to show/hide scroll-to-bottom button
  useEffect(() => {
    if (!visible) return;
    const check = () => {
      setShowScrollBtn(!terminal.isAtBottom());
      setShowScrollTopBtn(!terminal.isAtTop());
    };
    const interval = setInterval(check, 300);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Reclaim focus when terminal is visible but loses it to non-interactive elements.
  // Uses termRef directly instead of terminal (which is a new object every render).
  useEffect(() => {
    if (!visible) return;

    let cancelled = false;
    const handleFocusOut = () => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        const active = document.activeElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")) return;
        // Don't reclaim focus if a modal overlay is open
        if (document.querySelector('.launcher-overlay, .resume-picker-overlay, .modal-overlay, .palette-overlay')) return;
        terminal.termRef.current?.focus();
      });
    };

    const container = containerRef.current;
    container?.addEventListener("focusout", handleFocusOut);
    return () => {
      cancelled = true;
      container?.removeEventListener("focusout", handleFocusOut);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, session.id]);

  const showDeadOverlay = session.state === "dead" && visible;
  const showButtonBar = visible && session.state !== "dead";

  // Ctrl+mouse shortcuts (capture phase — fires before xterm.js ScrollableElement's stopPropagation)
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !visible) return;
    const onWheel = (ev: WheelEvent) => {
      if (ev.ctrlKey) {
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.deltaY > 0) terminal.scrollToBottom();
        else terminal.scrollToTop();
      }
    };
    const onMouseDown = (ev: MouseEvent) => {
      if (ev.button === 1 && ev.ctrlKey) {
        ev.preventDefault();
        ev.stopPropagation();
        terminal.scrollToLastUserMessage();
      }
    };
    el.addEventListener("wheel", onWheel, { capture: true, passive: false });
    el.addEventListener("mousedown", onMouseDown, { capture: true });
    return () => {
      el.removeEventListener("wheel", onWheel, { capture: true });
      el.removeEventListener("mousedown", onMouseDown, { capture: true });
    };
  }, [visible, terminal.scrollToTop, terminal.scrollToBottom, terminal.scrollToLastUserMessage]);

  const totalTokens = session.metadata.inputTokens + session.metadata.outputTokens;

  return (
    <div
      className="terminal-panel"
      style={{ display: visible ? "flex" : "none" }}
    >
      {loading && visible && (
        <div className="terminal-loading">
          <div className="terminal-loading-spinner" />
          <span>Loading conversation...</span>
        </div>
      )}
      {visible && session.state !== "dead" && totalTokens > 0 && (
        <div
          className="terminal-token-badge"
          title={`Input: ${formatTokenCount(session.metadata.inputTokens)}\nOutput: ${formatTokenCount(session.metadata.outputTokens)}`}
        >
          {formatTokenCount(totalTokens)}
        </div>
      )}
      <div className="terminal-inner">
        <div className="terminal-container" ref={setContainer} />
        {showButtonBar && (
          <div className="terminal-button-bar">
            <button
              className="bar-btn"
              style={{ visibility: showScrollTopBtn ? "visible" : "hidden" }}
              onClick={() => terminal.scrollToTop()}
              title="Scroll to top (Ctrl+Home)"
              aria-label="Scroll to top"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="7" y1="12" x2="7" y2="3" />
                <polyline points="3 6 7 2 11 6" />
              </svg>
            </button>
            <div className="bar-spacer" />
            <button
              className="bar-btn"
              style={{ visibility: showScrollTopBtn ? "visible" : "hidden" }}
              onClick={() => terminal.scrollToLastUserMessage()}
              title="Scroll to last user message (Ctrl+Middle-click)"
              aria-label="Scroll to last user message"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 5 7 1 11 5" />
                <line x1="7" y1="1" x2="7" y2="10" />
                <line x1="3" y1="13" x2="11" y2="13" />
              </svg>
            </button>
            <div className="bar-spacer" />
            <button
              className={`bar-btn${queuedInput ? " bar-btn-active" : ""}`}
              onClick={handleQueueInput}
              title={queuedInput ? `Queued: "${queuedInput}" (click to cancel)` : "Queue input for idle send"}
              aria-label="Queue input"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 3v5a2 2 0 0 1-2 2H4" />
                <polyline points="6 8 4 10 6 12" />
              </svg>
            </button>
            <button
              className="bar-btn"
              onClick={() => pty.handle.current?.write("\x15")}
              title="Clear input line (Ctrl+U)"
              aria-label="Clear input line"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" />
                <line x1="18" y1="9" x2="12" y2="15" />
                <line x1="12" y1="9" x2="18" y2="15" />
              </svg>
            </button>
            <button
              className="bar-btn"
              onClick={() => pty.handle.current?.write("\x15".repeat(20))}
              title="Clear all input lines (Ctrl+Shift+X)"
              aria-label="Clear all input lines"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" />
                <line x1="18" y1="9" x2="12" y2="15" />
                <line x1="12" y1="9" x2="18" y2="15" />
                <line x1="2" y1="22" x2="22" y2="22" />
              </svg>
            </button>
            <button
              className="bar-btn"
              style={{ visibility: showScrollBtn ? "visible" : "hidden" }}
              onClick={() => terminal.scrollToBottom()}
              title="Scroll to bottom (Ctrl+End)"
              aria-label="Scroll to bottom"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="7" y1="2" x2="7" y2="11" />
                <polyline points="3 8 7 12 11 8" />
              </svg>
            </button>
          </div>
        )}
      </div>
      {showDeadOverlay && externalHolder && (
        <div className="dead-overlay">
          <div className="dead-overlay-card">
            <div className="dead-overlay-title">Session in use externally</div>
            <div className="dead-overlay-hint" style={{ marginBottom: 8 }}>
              This session is held by a process outside this app.
            </div>
            <div className="dead-overlay-actions">
              <button
                className="dead-overlay-btn dead-overlay-btn-primary"
                onClick={() => {
                  Promise.all(
                    externalHolder.map((pid) =>
                      invoke("force_kill_session_holder", { pid }).catch(() => {})
                    )
                  ).then(() => {
                    setExternalHolder(null);
                    setTimeout(() => triggerRespawnRef.current(), 500);
                  });
                }}
              >
                Kill and resume
              </button>
              <button
                className="dead-overlay-btn"
                onClick={() => setExternalHolder(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {showDeadOverlay && !externalHolder && (
        <DeadOverlay session={session} triggerRespawnRef={triggerRespawnRef} closeSession={closeSession} />
      )}
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTerminal } from "../../hooks/useTerminal";
import { usePty } from "../../hooks/usePty";
import { useSessionStore } from "../../store/sessions";
import { buildClaudeArgs, getResumeId, canResumeSession, stripWorktreeFlags, findNearestLiveTab } from "../../lib/claude";
import { dlog } from "../../lib/debugLog";
import { allocateInspectorPort, registerInspectorPort, unregisterInspectorPort, registerInspectorCallbacks, unregisterInspectorCallbacks } from "../../lib/inspectorPort";
import { useInspectorConnection } from "../../hooks/useInspectorConnection";
import { useTapPipeline } from "../../hooks/useTapPipeline";
import { useTapEventProcessor } from "../../hooks/useTapEventProcessor";
import { registerPtyWriter, unregisterPtyWriter, registerPtyKill, unregisterPtyKill, registerPtyHandleId, unregisterPtyHandleId, writeToPty } from "../../lib/ptyRegistry";
import { registerBufferReader, unregisterBufferReader, registerTailReader, unregisterTailReader, registerTerminal, unregisterTerminal, registerScrollToLine, unregisterScrollToLine } from "../../lib/terminalRegistry";
import { useSettingsStore } from "../../store/settings";
import { IconSearch } from "../Icons/Icons";
import { normalizePath } from "../../lib/paths";
import type { Session, SessionConfig, SessionState } from "../../types/session";
import { isSessionIdle } from "../../types/session";
import "./TerminalPanel.css";


interface TerminalPanelProps {
  session: Session;
  visible: boolean;
}

// ── Duration Timer (active time only) ────────────────────────────────────

const ACTIVE_STATES = new Set<SessionState>(["thinking", "toolUse", "actionNeeded", "waitingPermission", "error"]);

// [SI-22] Duration timer: client-side 1s setInterval, accumulates active-state time
function useDurationTimer(sessionId: string, state: SessionState, respawnCounter: number): void {
  const updateMetadata = useSessionStore((s) => s.updateMetadata);
  const accumulatedRef = useRef(0);
  const lastTickRef = useRef(Date.now());
  const lastStateRef = useRef(state);

  // Track state changes so we know when we transition active↔idle
  lastStateRef.current = state;

  // Reset on respawn so the timer starts from 0 for the new session
  useEffect(() => {
    accumulatedRef.current = 0;
    lastTickRef.current = Date.now();
  }, [respawnCounter]);

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
  const hookChangeCounter = useSessionStore((s) => s.hookChangeCounter);
  const spawnedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [respawnCounter, setRespawnCounter] = useState(0);
  const [inspectorReconnectKey, setInspectorReconnectKey] = useState(0);

  // Inspector port: allocated async in doSpawn via OS probe (check_port_available IPC).
  // State triggers re-render so useInspectorConnection receives the port after allocation.
  const [inspectorPort, setInspectorPort] = useState<number | null>(null);
  const inspector = useInspectorConnection(
    session.state !== "dead" ? session.id : null,
    inspectorPort,
    inspectorReconnectKey
  );

  useTapPipeline({
    sessionId: session.state !== "dead" ? session.id : null,
    wsSend: inspector.wsSend,
    connected: inspector.connected,
  });

  // Auto-start traffic logging when recording config enables it
  const trafficEnabled = useSettingsStore((s) => s.recordingConfig.traffic.enabled);
  const startTrafficLog = useSessionStore((s) => s.startTrafficLog);
  const trafficStartedRef = useRef(false);
  useEffect(() => {
    if (!inspector.connected || session.state === "dead") {
      trafficStartedRef.current = false;
      return;
    }
    if (trafficEnabled && !trafficStartedRef.current) {
      trafficStartedRef.current = true;
      invoke<string>("start_traffic_log", { sessionId: session.id })
        .then((path) => startTrafficLog(session.id, path))
        .catch((e) => dlog("traffic", session.id, `auto-start failed: ${e}`, "WARN"));
    }
  }, [inspector.connected, trafficEnabled, session.id, session.state, startTrafficLog]);

  // Tap event processor: sole source of state, metadata, subagent data
  const tapProcessor = useTapEventProcessor(
    session.state !== "dead" ? session.id : null
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

  // Hide loading spinner when inspector connects — but only for non-resume sessions.
  // Resume sessions keep the spinner until the session reaches idle (buffer flush there).
  useEffect(() => {
    if (loading && inspector.connected && !resumeLoadingRef.current) setLoading(false);
  }, [loading, inspector.connected]);

  // Sync Claude's internal session ID into config for persistence (plan-mode forks, compaction)
  const prevClaudeSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!tapProcessor.claudeSessionId) {
      // Session reset (respawn/restart) — forget the previous ID so JSONL replay
      // session registrations don't trigger a spurious terminal clear.
      prevClaudeSessionIdRef.current = null;
      return;
    }
    const prev = prevClaudeSessionIdRef.current;
    prevClaudeSessionIdRef.current = tapProcessor.claudeSessionId;
    // [TR-13] Clear terminal when session ID changes (context clear, plan approval, compaction).
    // Skip during resume loading: JSONL replay surfaces stale session IDs from old
    // compaction/plan transitions, causing spurious clears that wipe the conversation.
    if (prev && prev !== tapProcessor.claudeSessionId && !resumeLoadingRef.current) {
      bgBufferRef.current = [];
      terminal.clearPending();
      terminal.clear();
    }
    if (tapProcessor.claudeSessionId !== session.config.sessionId) {
      updateConfig(session.id, { sessionId: tapProcessor.claudeSessionId });
    }
  }, [tapProcessor.claudeSessionId, session.id, session.config.sessionId, updateConfig]);

  // Resume complete: flush buffered content atomically and dismiss spinner.
  // After this, context-clear detection works normally for /clear, compaction, etc.
  useEffect(() => {
    if (!resumeLoadingRef.current) return;
    if (!isSessionIdle(session.state) && session.state !== "dead" && session.state !== "error") return;

    resumeLoadingRef.current = false;

    // Flush all PTY data buffered during resume as a single write
    const chunks = bgBufferRef.current;
    if (chunks.length > 0) {
      bgBufferRef.current = [];
      let totalLen = 0;
      for (const c of chunks) totalLen += c.length;
      const merged = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of chunks) { merged.set(c, offset); offset += c.length; }

      const term = terminal.termRef.current;
      if (term) {
        try { term.write(merged); } catch {}
        term.scrollToBottom();
      }
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.state]);

  // Cache session config when inspector connects (for resume picker fallback)
  useEffect(() => {
    if (inspector.connected && session.config.sessionId) {
      useSettingsStore.getState().cacheSessionConfig(session.config.sessionId, session.config);
    }
  }, [inspector.connected, session.id, session.config.sessionId]);

  // Duration timer
  useDurationTimer(session.id, session.state, respawnCounter);

  // Use a ref to break the circular dependency:
  // handlePtyData needs terminal, terminal needs handleTermData, which needs pty,
  // and pty needs handlePtyData. We use terminalRef to avoid forward-referencing.
  const terminalRef = useRef<ReturnType<typeof useTerminal> | null>(null);
  // [BF-01] Buffer PTY data for background tabs — skip terminal writes when not visible,
  // flush in one write when the tab becomes visible. Saves O(1) rendering cost while hidden.
  // [BF-02] visibleRef tracks tab visibility for buffering decisions
  const visibleRef = useRef(visible);
  const bgBufferRef = useRef<Uint8Array[]>([]);
  visibleRef.current = visible;

  // Suppress context-clear detection during resume loading phase.
  // JSONL replay can surface stale session IDs from old compaction/plan transitions,
  // causing spurious terminal.clear() calls that wipe the just-loaded conversation.
  // Set true in triggerRespawn when resuming; cleared on first idle state.
  const resumeLoadingRef = useRef(false);

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
      // Filter TAP lines from terminal display — they're consumed via
      // BUN_INSPECT Console.messageAdded, not the PTY stream.
      // Filtering here (frontend) instead of in process.stderr.write
      // avoids killing the debugger protocol event that Bun derives from the write.
      let filtered = data;
      if (data.includes(0)) {
        const text = new TextDecoder().decode(data);
        if (text.includes("\x00TAP")) {
          const cleaned = text.replace(/\x00TAP[^\n]*\n?/g, "");
          if (cleaned.length === 0) return;
          filtered = new TextEncoder().encode(cleaned);
        }
      }
      // Write to terminal if visible and not buffering for resume; buffer otherwise.
      // During resume loading, PTY data is buffered and flushed atomically when the
      // session reaches idle — prevents content from "flooding in" during replay.
      if (visibleRef.current && !resumeLoadingRef.current) {
        terminalRef.current?.writeBytes(filtered);
      } else {
        bgBufferRef.current.push(filtered);
      }
    },
    [session.id]
  );

  // External process holding the session — shown when user must confirm kill
  const [externalHolder, setExternalHolder] = useState<number[] | null>(null);

  const handlePtyExit = useCallback(
    (info: { exitCode: number }) => {
      dlog("terminal", session.id, `exit code=${info.exitCode}`);
      // Stop TCP tap server immediately (before any early-return paths)
      invoke("stop_tap_server", { sessionId: session.id }).catch(() => {});
      // [DS-07] [RS-06] Session-in-use auto-recovery: kill own orphans, retry; show overlay for external
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
      // [DS-01] Switch away from dead tab to nearest live tab via findNearestLiveTab
      const store = useSessionStore.getState();
      if (store.activeTabId === session.id) {
        const idx = store.sessions.findIndex((x) => x.id === session.id);
        const next = findNearestLiveTab(store.sessions, idx);
        if (next && next !== session.id) store.setActiveTab(next);
      }
    },
    [session.id, session.config.resumeSession, session.config.sessionId, updateState]
  );

  const pty = usePty({ onData: handlePtyData, onExit: handlePtyExit });

  // ── In-tab respawn ────────────────────────────────────────────────────
  const triggerRespawnRef = useRef<(config?: SessionConfig, name?: string) => void>(() => {});
  // Stable ref so callbacks can call triggerRespawn without stale closures
  // [RS-01] triggerRespawn: cleanup old PTY/watchers/inspector, allocate port, increment respawnCounter
  triggerRespawnRef.current = (config?: SessionConfig, name?: string) => {
    dlog("terminal", session.id, "respawn triggered");
    // 1. Clean up old PTY, watchers, inspector, and tap server
    pty.cleanup();
    inspector.disconnect();
    invoke("stop_tap_server", { sessionId: session.id }).catch(() => {});
    unregisterPtyWriter(session.id);
    unregisterPtyKill(session.id);
    unregisterPtyHandleId(session.id);
    unregisterInspectorPort(session.id);
    useSessionStore.getState().setInspectorOff(session.id, false);

    // 2. Determine config (default: resume if conversation exists)
    const canResume = canResumeSession(session);
    const newConfig: SessionConfig = config ?? {
      ...session.config,
      resumeSession: canResume ? getResumeId(session) : null,
      continueSession: false,
      extraFlags: stripWorktreeFlags(session.config.extraFlags),
    };

    // 3. Update session in store
    updateConfig(session.id, newConfig);
    if (name) renameSession(session.id, name);

    // [PT-11] Clear stale buffers before terminal reset
    // 4. Visual feedback + loading spinner for resumed sessions
    // [PT-11] [RS-09] Clear stale buffers then terminal reset (ANSI RIS \x1bc)
    bgBufferRef.current = [];
    deferredResizeRef.current = null;
    terminal.clearPending();
    terminalRef.current?.write("\x1bc");  // [RS-09] RIS: full terminal reset + fit
    terminal.fit();
    terminalRef.current?.write("\x1b[90m[Resuming...]\x1b[0m\r\n");
    setLoading(!!newConfig.resumeSession);

    // 5. Reset internal state (inspector port allocated in doSpawn)
    lastPtyDimsRef.current = null;
    spawnedRef.current = false;
    earlyOutputRef.current = "";
    sessionInUseRef.current = false;
    sessionInUseRetried.current = false;
    // Suppress context-clear during resume: JSONL replay surfaces stale session IDs
    resumeLoadingRef.current = !!newConfig.resumeSession;
    setExternalHolder(null);
    setInspectorPort(null);

    // 6. Trigger re-spawn
    updateState(session.id, "starting");
    setRespawnCounter((c) => c + 1);
  };

  const handleTermData = useCallback(
    (data: string) => {
      if (session.state === "dead") return; // Resume via tab click, not keyboard
      writeToPty(session.id, data);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.id, session.state]
  );

  const lastPtyDimsRef = useRef<{ cols: number; rows: number } | null>(null);
  const deferredResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  // Tracks pending onRender reveal listener — disposed on cleanup to prevent leaks
  const revealDisposableRef = useRef<{ dispose(): void } | null>(null);
  // [PT-13] Same-dimension gate — skip redundant pty.resize() calls
  // [BF-03] Resize occlusion — defer PTY resize when hidden (would trigger ConPTY
  // repaint with no visible terminal) or when bgBuffer has pending data (terminal
  // hasn't caught up yet, repaint would duplicate content into scrollback).
  const handleResize = useCallback(
    (cols: number, rows: number) => {
      const last = lastPtyDimsRef.current;
      if (last && last.cols === cols && last.rows === rows) return;
      lastPtyDimsRef.current = { cols, rows };
      if (!visibleRef.current || bgBufferRef.current.length > 0) {
        deferredResizeRef.current = { cols, rows };
        return;
      }
      pty.handle.current?.resize(cols, rows);
      // Send focus-in after resize: Claude Code's Ink renderer marks new columns as
      // dirty after SIGWINCH and fills them lazily on the next focus event. Sending
      // the focus-in sequence immediately triggers that fill without waiting for the
      // user to click away and back.
      writeToPty(session.id, '\x1b[I');
    },
    // pty.handle and bgBufferRef are stable refs — omitted from deps intentionally
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.id]
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

  // [RS-07] Spawn PTY once; guards against dead sessions (prevents stale auto-spawn on startup)
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

        // Start TCP tap server for this session (before PTY spawn so port is ready)
        let tapPort: number | null = null;
        try {
          tapPort = await invoke<number>("start_tap_server", { sessionId: session.id });
        } catch (err) {
          dlog("terminal", session.id, `tap server failed: ${err}`, "WARN");
        }

        // [PT-12] Pre-spawn fit + post-spawn rAF dimension verification
        const args = await buildClaudeArgs(session.config);
        terminal.fit();
        const { cols, rows } = terminal.getDimensions();
        const cwd = normalizePath(session.config.workingDir);
        // Pass BUN_INSPECT env for inspector-based hook injection,
        // TAP_PORT for dedicated TCP event delivery
        const env: Record<string, string> = { BUN_INSPECT: `ws://127.0.0.1:${inspPort}/0` };
        if (tapPort) env.TAP_PORT = String(tapPort);
        // [TR-15] Inject proxy URL for multi-provider routing
        const { proxyPort } = useSettingsStore.getState();
        if (proxyPort) {
          env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
        }
        const handle = await pty.spawn(claudePath, args, cwd, cols, rows, env);
        registerPtyWriter(session.id, handle.write);
        registerPtyKill(session.id, () => handle.kill());
        registerPtyHandleId(session.id, handle.pid);
        dlog("terminal", session.id, `spawned pid=${handle.pid} port=${inspPort} tapPort=${tapPort} cols=${cols} rows=${rows}`);
        updateState(session.id, "idle");

        // Post-spawn dimension verification
        // or WebGL renderer weren't ready during the initial fit.
        requestAnimationFrame(() => {
          terminal.fit();
          const { cols: c, rows: r } = terminal.getDimensions();
          if (c !== cols || r !== rows) {
            handle.resize(c, r);
          }
        });
      } catch (err) {
        dlog("terminal", session.id, `spawn failed: ${err}`, "ERR");
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

  // [DS-09] [RS-08] Auto-resume: hidden-to-visible transition on dead+resumable tab
  const prevVisibleRef = useRef(false);
  useEffect(() => {
    const becameVisible = visible && !prevVisibleRef.current;
    prevVisibleRef.current = visible;
    if (!becameVisible || session.state !== "dead" || !claudePath) return;
    if (!canResumeSession(session)) return;
    // [RS-08] 150ms delay for render settling
    const timer = setTimeout(() => triggerRespawnRef.current(), 150);
    return () => clearTimeout(timer);
  }, [visible, session.state, claudePath]);

  // Register terminal buffer readers, search addon, and scroll function
  useEffect(() => {
    registerBufferReader(session.id, terminal.getBufferText);
    registerTailReader(session.id, terminal.getBufferTail);
    registerScrollToLine(session.id, terminal.scrollToLine);
    if (terminal.termRef.current) {
      registerTerminal(session.id, terminal.termRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, terminal.getBufferText, terminal.getBufferTail, terminal.scrollToLine]);

  // Cleanup PTY and registries on unmount
  useEffect(() => {
    const id = session.id;
    return () => {
      revealDisposableRef.current?.dispose();
      invoke("stop_tap_server", { sessionId: id }).catch(() => {});
      unregisterPtyWriter(id);
      unregisterPtyKill(id);
      unregisterPtyHandleId(id);
      unregisterBufferReader(id);
      unregisterTailReader(id);
      unregisterTerminal(id);
      unregisterScrollToLine(id);
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
      dlog("terminal", session.id, "kill effect triggered");
      pty.cleanup();
      // pty.kill() fires exitCallback → handlePtyExit → state "dead"
    }
  }, [killRequest, session.id, session.state, clearKillRequest, pty]);

  // [BF-01] Flush bgBuffer on tab focus, reveal after renderer paints
  // [TR-10] fit() deferred on tab switch via useLayoutEffect
  // terminal is NOT in deps because useTerminal returns a new object on every render.
  useLayoutEffect(() => {
    // Dispose any pending reveal from a prior transition
    revealDisposableRef.current?.dispose();
    revealDisposableRef.current = null;

    if (!visible) return;

    const container = containerRef.current;
    const term = terminal.termRef.current;
    const chunks = bgBufferRef.current;
    const hasBuffer = chunks.length > 0;

    // Hide content — reveal only after the renderer paints the correct state.
    // opacity:0 (not visibility:hidden) keeps WebGL renderer active.
    // Skip on initial mount (term not yet created by useEffect) — nothing to hide.
    if (container && term) container.style.opacity = '0';

    if (hasBuffer) {
      bgBufferRef.current = [];
      let totalLen = 0;
      for (const c of chunks) totalLen += c.length;
      const merged = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of chunks) { merged.set(c, offset); offset += c.length; }
      dlog("terminal", session.id, `flush bg buffer ${totalLen}B`, "DEBUG");

      try {
        term!.write(merged);
        term!.scrollToBottom();
        if (container) {
          requestAnimationFrame(() => {
            if (containerRef.current) containerRef.current.style.opacity = '';
          });
        }
      } catch {
        if (container) container.style.opacity = '1';
      }
    }

    terminal.fit();

    // [PT-20] Send deferred PTY resize now that the buffer has been flushed
    const deferred = deferredResizeRef.current;
    if (deferred) {
      deferredResizeRef.current = null;
      pty.handle.current?.resize(deferred.cols, deferred.rows);
      writeToPty(session.id, '\x1b[I');
    }

    if (!hasBuffer && term) {
      term.scrollToBottom();
      // Trigger render cycle and reveal after paint
      if (container) {
        try {
          term.write('', () => {
            requestAnimationFrame(() => {
              if (containerRef.current) containerRef.current.style.opacity = '';
            });
          });
        } catch {
          if (containerRef.current) containerRef.current.style.opacity = '';
        }
      }
    }

    terminal.focus();

    // Cleanup: if tab hides before reveal fires, dispose listener and reset opacity
    return () => {
      revealDisposableRef.current?.dispose();
      revealDisposableRef.current = null;
      if (containerRef.current) containerRef.current.style.opacity = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, session.id]);

  // Re-fit terminal on OS wake / display power-off recovery.
  // Re-fit terminal on OS wake / display power-off recovery.
  // Clear WebGL texture atlas to fix GPU corruption after sleep (DF-07).
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible" || !visible) return;
      terminalRef.current?.webglRef.current?.clearTextureAtlas();
      terminal.fit();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
    // terminal is NOT in deps — useTerminal returns a new object each render.
    // visible is needed to re-capture its value in the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Queue input handler: read from terminal buffer (authoritative), or cancel if already queued
  const handleQueueInput = useCallback(() => {
    if (queuedInput) {
      setQueuedInput(null);
      return;
    }
    const text = terminalRef.current?.getCurrentInput() ?? "";
    if (!text) return;
    writeToPty(session.id, "\x15"); // Clear terminal input line
    setQueuedInput(text);
    // pty.handle and terminalRef are stable refs — omitted from deps intentionally
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuedInput]);

  // Auto-send queued input on event-confirmed completion (not transient idle flashes).
  // tapProcessor.completionCount only increments on result/end_turn events.
  useEffect(() => {
    if (!queuedInput) return;
    if (session.state === "dead") { setQueuedInput(null); return; }
    const timer = setTimeout(() => {
      if (!isSessionIdle(session.state)) return; // Belt-and-suspenders: verify still idle
      writeToPty(session.id, queuedInput + "\r");
      setQueuedInput(null);
    }, 300);
    return () => clearTimeout(timer);
    // pty.handle is a stable ref — omitted from deps intentionally
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tapProcessor.completionCount, queuedInput, session.state]);

  // Auto-restart session when hooks change, same timing as queued input
  useEffect(() => {
    if (hookChangeCounter <= lastHookChangeRef.current) return;
    if (session.state === "dead") { lastHookChangeRef.current = hookChangeCounter; return; }
    if (!isSessionIdle(session.state)) return;
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

  // [TR-09] Ctrl+wheel snaps to top/bottom, [TR-08] Ctrl+middle-click scrolls to last user message
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

  // [TR-05] Hidden tabs use CSS display:none — never unmount/remount xterm.js
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
      <div className="terminal-inner">
        <div className="terminal-container" ref={setContainer} />
        {/* [TR-07] Vertical button bar (28px) with scroll, queue, search buttons */}
        {showButtonBar && (
          <div className="terminal-button-bar">
            {/* [TR-01] Scroll-to-top button, visible when not at top */}
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
              onClick={() => {
                const store = useSettingsStore.getState();
                store.setSidePanel(store.sidePanel === "search" ? null : "search");
              }}
              title="Search all terminals (Ctrl+Shift+F)"
              aria-label="Search all terminals"
            >
              <IconSearch size={14} />
            </button>
            {/* [TR-01] Scroll-to-bottom button, visible when not at bottom */}
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
    </div>
  );
}

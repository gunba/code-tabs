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
import { registerBufferReader, unregisterBufferReader, registerTerminal, unregisterTerminal, registerScrollToLine, unregisterScrollToLine } from "../../lib/terminalRegistry";
import { useFileWatcher } from "../../hooks/useFileWatcher";
import { useSettingsStore } from "../../store/settings";
import { useRuntimeStore } from "../../store/runtime";
import { IconSearch } from "../Icons/Icons";
import { normalizePath } from "../../lib/paths";
import type { Session, SessionConfig, SessionState } from "../../types/session";
import { isSessionIdle } from "../../types/session";
import { startTraceSpan, traceAsync } from "../../lib/perfTrace";
import "./TerminalPanel.css";


interface TerminalPanelProps {
  session: Session;
  visible: boolean;
}

function escapeChunkPreview(text: string): string {
  return text
    .replace(/\x1b/g, "\\x1b")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .slice(0, 240);
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
  const observabilityEnabled = useRuntimeStore((s) => s.observabilityInfo.observabilityEnabled);
  const startTrafficLog = useSessionStore((s) => s.startTrafficLog);
  const trafficStartedRef = useRef(false);
  useEffect(() => {
    if (!inspector.connected || session.state === "dead") {
      trafficStartedRef.current = false;
      return;
    }
    if (observabilityEnabled && trafficEnabled && !trafficStartedRef.current) {
      trafficStartedRef.current = true;
      traceAsync("traffic.start_auto_log", () => invoke<string>("start_traffic_log", { sessionId: session.id }), {
        module: "traffic",
        sessionId: session.id,
        event: "traffic.start_auto_log",
        warnAboveMs: 250,
        data: {},
      })
        .then((path) => startTrafficLog(session.id, path))
        .catch((e) => dlog("traffic", session.id, `auto-start failed: ${e}`, "WARN"));
    }
  }, [inspector.connected, observabilityEnabled, trafficEnabled, session.id, session.state, startTrafficLog]);

  // Tap event processor: sole source of state, metadata, subagent data
  const tapProcessor = useTapEventProcessor(
    session.state !== "dead" ? session.id : null
  );

  // Filesystem watcher: kernel-level file change detection for activity panel
  useFileWatcher(
    session.state !== "dead" ? session.id : null,
    session.config.workingDir ?? null,
    session.state,
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

  // Hide loading spinner when inspector connects
  useEffect(() => {
    if (loading && inspector.connected) setLoading(false);
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
    prevClaudeSessionIdRef.current = tapProcessor.claudeSessionId;
    if (tapProcessor.claudeSessionId !== session.config.sessionId) {
      updateConfig(session.id, { sessionId: tapProcessor.claudeSessionId });
    }
  }, [tapProcessor.claudeSessionId, session.id, session.config.sessionId, updateConfig]);

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

  // Suppress context-clear detection during resume loading phase.


  // Detect "session already in use" errors in early PTY output
  const earlyOutputRef = useRef("");
  const sessionInUseRef = useRef(false);
  const sessionInUseRetried = useRef(false);

  const handlePtyData = useCallback(
    (data: Uint8Array) => {
      const text = new TextDecoder().decode(data);
      dlog("pty", session.id, "PTY output received", "DEBUG", {
        event: "pty.output",
        data: {
          byteLength: data.byteLength,
          containsEscape: text.includes("\x1b"),
          text,
          preview: escapeChunkPreview(text),
        },
      });
      // Accumulate early output for error detection (first ~4KB)
      if (earlyOutputRef.current.length < 4096) {
        earlyOutputRef.current += text;
        if (/already in use/i.test(earlyOutputRef.current)) {
          dlog("terminal", session.id, "session-in-use marker detected in PTY output", "WARN", {
            event: "session.session_in_use_detected",
            data: {
              preview: escapeChunkPreview(earlyOutputRef.current),
            },
          });
          sessionInUseRef.current = true;
        }
      }
      terminalRef.current?.writeBytes(data);
    },
    [session.id]
  );

  // External process holding the session — shown when user must confirm kill
  const [externalHolder, setExternalHolder] = useState<number[] | null>(null);

  const handlePtyExit = useCallback(
    (info: { exitCode: number }) => {
      dlog("terminal", session.id, `exit code=${info.exitCode}`, "LOG", {
        event: "session.exit",
        data: { exitCode: info.exitCode },
      });
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
              dlog("terminal", session.id, "session held by external process", "WARN", {
                event: "session.external_holder_detected",
                data: {
                  externalPids: result.external,
                  killedOwnedPids: result.killed,
                },
              });
              setExternalHolder(result.external);
              updateState(session.id, "dead");
            } else {
              // Killed our own orphans (or mixed) — retry
              dlog("terminal", session.id, "retrying after killing stale holder", "LOG", {
                event: "session.retry_after_holder_cleanup",
                data: {
                  externalPids: result.external,
                  killedOwnedPids: result.killed,
                },
              });
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

  const pty = usePty({ sessionId: session.id, onData: handlePtyData, onExit: handlePtyExit });

  // ── In-tab respawn ────────────────────────────────────────────────────
  const triggerRespawnRef = useRef<(config?: SessionConfig, name?: string) => void>(() => {});
  // Stable ref so callbacks can call triggerRespawn without stale closures
  // [RS-01] triggerRespawn: cleanup old PTY/watchers/inspector, allocate port, increment respawnCounter
  triggerRespawnRef.current = (config?: SessionConfig, name?: string) => {
    dlog("terminal", session.id, "respawn triggered", "LOG", {
      event: "session.respawn_triggered",
      data: {
        name: name ?? null,
        requestedConfig: config ?? null,
      },
    });
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

    // [PT-11] [RS-09] Terminal reset
    terminal.fit();
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

  const handleTermData = useCallback(
    (data: string) => {
      if (session.state === "dead") return; // Resume via tab click, not keyboard
      writeToPty(session.id, data);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.id, session.state]
  );

  const lastPtyDimsRef = useRef<{ cols: number; rows: number } | null>(null);
  // [PT-13] Same-dimension gate — skip redundant pty.resize() calls
  const handleResize = useCallback(
    (cols: number, rows: number) => {
      const last = lastPtyDimsRef.current;
      if (last && last.cols === cols && last.rows === rows) return;
      lastPtyDimsRef.current = { cols, rows };
      pty.handle.current?.resize(cols, rows);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.id]
  );

  const terminal = useTerminal({
    sessionId: session.id,
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
      const spawnSpan = startTraceSpan("session.spawn_sequence", {
        module: "terminal",
        sessionId: session.id,
        event: "session.spawn_sequence",
        warnAboveMs: 1000,
        data: {
          claudePath,
          workingDir: session.config.workingDir,
          resumeSession: session.config.resumeSession,
          continueSession: session.config.continueSession,
        },
      });
      try {
        // Allocate a verified-free inspector port before spawning.
        // Register immediately so concurrent allocations (multi-tab restore) skip it.
        const inspPort = await allocateInspectorPort();
        registerInspectorPort(session.id, inspPort);
        setInspectorPort(inspPort);
        dlog("terminal", session.id, "allocated inspector port", "DEBUG", {
          event: "session.inspector_port_allocated",
          data: { inspectorPort: inspPort },
        });

        // Start TCP tap server for this session (before PTY spawn so port is ready)
        let tapPort: number | null = null;
        try {
          tapPort = await invoke<number>("start_tap_server", { sessionId: session.id });
          dlog("terminal", session.id, "tap server started", "DEBUG", {
            event: "session.tap_server_started",
            data: { tapPort },
          });
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
          env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}/s/${session.id}`;
        }
        dlog("terminal", session.id, "launching Claude session", "LOG", {
          event: "session.launch",
          data: {
            claudePath,
            args,
            cwd,
            cols,
            rows,
            inspectorPort: inspPort,
            tapPort,
            env,
            resumeSession: session.config.resumeSession,
            continueSession: session.config.continueSession,
            permissionMode: session.config.permissionMode,
            model: session.config.model,
          },
        });
        const handle = await pty.spawn(claudePath, args, cwd, cols, rows, env);
        registerPtyWriter(session.id, handle.write);
        registerPtyKill(session.id, () => handle.kill());
        registerPtyHandleId(session.id, handle.pid);
        dlog("terminal", session.id, `spawned pid=${handle.pid} port=${inspPort} tapPort=${tapPort} cols=${cols} rows=${rows}`, "LOG", {
          event: "session.spawned",
          data: {
            ptyHandle: handle.pid,
            inspectorPort: inspPort,
            tapPort,
            cols,
            rows,
          },
        });
        updateState(session.id, "idle");

        // Post-spawn dimension verification
        // or WebGL renderer weren't ready during the initial fit.
        requestAnimationFrame(() => {
          terminal.fit();
          const { cols: c, rows: r } = terminal.getDimensions();
          if (c !== cols || r !== rows) {
            dlog("terminal", session.id, "post-spawn terminal dimensions changed", "DEBUG", {
              event: "session.post_spawn_resize",
              data: {
                before: { cols, rows },
                after: { cols: c, rows: r },
              },
            });
            handle.resize(c, r);
          }
        });
        spawnSpan.end({
          inspectorPort: inspPort,
          tapPort,
          ptyHandle: handle.pid,
          cols,
          rows,
        });
      } catch (err) {
        spawnSpan.fail(err);
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
    registerScrollToLine(session.id, terminal.scrollToLine);
    if (terminal.termRef.current) {
      registerTerminal(session.id, terminal.termRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, terminal.getBufferText, terminal.scrollToLine]);

  // Cleanup PTY and registries on unmount
  useEffect(() => {
    const id = session.id;
    return () => {
      invoke("stop_tap_server", { sessionId: id }).catch(() => {});
      unregisterPtyWriter(id);
      unregisterPtyKill(id);
      unregisterPtyHandleId(id);
      unregisterBufferReader(id);
      unregisterTerminal(id);
      unregisterScrollToLine(id);
      unregisterInspectorPort(id);
      unregisterInspectorCallbacks(id);
      dlog("terminal", id, "terminal panel unmount cleanup", "DEBUG", {
        event: "terminal.unmount_cleanup",
        data: { sessionId: id },
      });
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

  // [TR-10] fit() on tab switch via useLayoutEffect
  useLayoutEffect(() => {
    if (!visible) return;
    dlog("terminal", session.id, "panel became visible", "DEBUG", {
      event: "terminal.visible",
      data: { visible },
    });
    terminal.fit();
    terminal.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, session.id]);

  // [DF-07] Visibility change handler: clears texture atlas and redraws on OS wake / tab restore (fixes GPU corruption after sleep)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible" || !visible) return;
      dlog("terminal", session.id, "document visibility restored for visible panel", "DEBUG", {
        event: "terminal.visibility_restore",
        data: {
          visibilityState: document.visibilityState,
        },
      });
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
      dlog("terminal", session.id, "queued input cleared", "DEBUG", {
        event: "terminal.queue_input_cleared",
        data: { queuedInput },
      });
      setQueuedInput(null);
      return;
    }
    const text = terminalRef.current?.getCurrentInput() ?? "";
    if (!text) return;
    writeToPty(session.id, "\x15"); // Clear terminal input line
    dlog("terminal", session.id, "queued current input", "DEBUG", {
      event: "terminal.queue_input",
      data: {
        text,
      },
    });
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
      dlog("terminal", session.id, "sending queued input", "LOG", {
        event: "terminal.queue_input_sent",
        data: {
          text: queuedInput,
          completionCount: tapProcessor.completionCount,
        },
      });
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
      dlog("terminal", session.id, "restarting session after hook change", "LOG", {
        event: "session.restart_for_hook_change",
        data: {
          hookChangeCounter,
        },
      });
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
        // Don't reclaim focus if a modal overlay or side panel is open
        if (document.querySelector('.launcher-overlay, .resume-picker-overlay, .modal-overlay, .palette-overlay, .search-panel, .debug-panel, .diff-panel')) return;
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

  // [TR-09] Ctrl+wheel snaps to top/bottom
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
    el.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel, { capture: true });
    };
  }, [visible, terminal.scrollToTop, terminal.scrollToBottom]);

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

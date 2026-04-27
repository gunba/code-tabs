import { memo, useEffect, useRef, useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTerminal } from "../../hooks/useTerminal";
import { usePty } from "../../hooks/usePty";
import { useSessionStore } from "../../store/sessions";
import { getResumeId, canResumeSession, stripWorktreeFlags, findNearestLiveTab } from "../../lib/claude";
import { dlog, shouldRecordDebugLog } from "../../lib/debugLog";
import { allocateInspectorPort, registerInspectorPort, unregisterInspectorPort, registerInspectorCallbacks, unregisterInspectorCallbacks } from "../../lib/inspectorPort";
import { useInspectorConnection } from "../../hooks/useInspectorConnection";
import { useTapPipeline } from "../../hooks/useTapPipeline";
import { useTapEventProcessor } from "../../hooks/useTapEventProcessor";
import { registerPtyWriter, unregisterPtyWriter, registerPtyKill, unregisterPtyKill, registerPtyHandleId, unregisterPtyHandleId, writeToPty } from "../../lib/ptyRegistry";
import { registerBufferReader, unregisterBufferReader, registerTerminal, unregisterTerminal } from "../../lib/terminalRegistry";
import { useSettingsStore } from "../../store/settings";
import { useRuntimeStore } from "../../store/runtime";
import { normalizePath } from "../../lib/paths";
import type { Session, SessionConfig, SessionState } from "../../types/session";
import { startTraceSpan, traceAsync } from "../../lib/perfTrace";
import "./TerminalPanel.css";

const EARLY_OUTPUT_LIMIT_BYTES = 4096;
const CLAUDE_SCROLLBACK_LINES = 100_000;
const CODEX_SCROLLBACK_LINES = 50_000;
const ptyOutputDecoder = new TextDecoder();

interface TerminalPanelProps {
  session: Session;
  visible: boolean;
}

// [TA-13] React.memo with terminalPanelPropsEqual gates rerenders on the subset of session fields the panel actually depends on; tap-event-driven metadata churn no longer rerenders the heavy terminal subtree.
function terminalPanelPropsEqual(prev: TerminalPanelProps, next: TerminalPanelProps): boolean {
  return prev.visible === next.visible
    && prev.session.id === next.session.id
    && prev.session.state === next.session.state
    && prev.session.name === next.session.name
    && prev.session.config === next.session.config
    && prev.session.metadata.nodeSummary === next.session.metadata.nodeSummary
    && prev.session.metadata.assistantMessageCount === next.session.metadata.assistantMessageCount;
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

export const TerminalPanel = memo(function TerminalPanel({ session, visible }: TerminalPanelProps) {
  const claudePath = useSessionStore((s) => s.claudePath);
  const codexPath = useSessionStore((s) => s.codexPath);
  const initialized = useSessionStore((s) => s.initialized);
  const updateState = useSessionStore((s) => s.updateState);
  const updateConfig = useSessionStore((s) => s.updateConfig);
  const renameSession = useSessionStore((s) => s.renameSession);
  const killRequest = useSessionStore((s) => s.killRequest);
  const clearKillRequest = useSessionStore((s) => s.clearKillRequest);
  const spawnedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [respawnCounter, setRespawnCounter] = useState(0);
  const [inspectorReconnectKey, setInspectorReconnectKey] = useState(0);

  // Inspector port: allocated async in doSpawn via OS probe (check_port_available IPC).
  // State triggers re-render so useInspectorConnection receives the port after allocation.
  const [inspectorPort, setInspectorPort] = useState<number | null>(null);
  const inspector = useInspectorConnection(
    session.state !== "dead" && session.config.cli === "claude" ? session.id : null,
    inspectorPort,
    inspectorReconnectKey
  );

  useTapPipeline({
    sessionId: session.state !== "dead" ? session.id : null,
    wsSend: inspector.wsSend,
    connected: inspector.connected,
  });

  // Auto-start traffic logging when recording config enables it
  const trafficEnabled = useSettingsStore((s) =>
    (s.recordingConfigsByCli[session.config.cli] ?? s.recordingConfig).traffic.enabled
  );
  const observabilityEnabled = useRuntimeStore((s) => s.observabilityInfo.observabilityEnabled);
  const startTrafficLog = useSessionStore((s) => s.startTrafficLog);
  const stopTrafficLog = useSessionStore((s) => s.stopTrafficLog);
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

  // Register inspector disconnect/reconnect callbacks for external debugger support
  useEffect(() => {
    registerInspectorCallbacks(session.id, {
      disconnect: inspector.disconnect,
      reconnect: () => setInspectorReconnectKey((k) => k + 1),
    });
    return () => unregisterInspectorCallbacks(session.id);
  }, [session.id, inspector.disconnect]);

  const [loading, setLoading] = useState(!!session.config.resumeSession);

  // [SR-01] Hide loading spinner once the session signals readiness.
  // Claude: inspector connect (~1s after spawn).
  // Codex: no inspector — first state transition off "starting" (set after pty.spawn).
  useEffect(() => {
    if (!loading) return;
    if (session.config.cli === "codex") {
      if (session.state !== "starting") setLoading(false);
    } else if (inspector.connected) {
      setLoading(false);
    }
  }, [loading, inspector.connected, session.config.cli, session.state]);

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

  // [SL-07] Cache session config when inspector connects (for resume picker fallback)
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
  const earlyOutputBytesRef = useRef(0);
  const sessionInUseRef = useRef(false);
  const sessionInUseRetried = useRef(false);

  const handlePtyData = useCallback(
    (data: Uint8Array) => {
      const debug = shouldRecordDebugLog("DEBUG", session.id);
      let text: string | null = null;
      const getText = () => text ??= ptyOutputDecoder.decode(data);
      if (debug) {
        const decoded = getText();
        dlog("pty", session.id, "PTY output received", "DEBUG", {
          event: "pty.output",
          data: {
            byteLength: data.byteLength,
            containsEscape: decoded.includes("\x1b"),
            text: decoded,
            preview: escapeChunkPreview(decoded),
          },
        });
      }
      // Accumulate early output for error detection (first ~4KB)
      if (earlyOutputBytesRef.current < EARLY_OUTPUT_LIMIT_BYTES && !sessionInUseRef.current) {
        const remainingBytes = EARLY_OUTPUT_LIMIT_BYTES - earlyOutputBytesRef.current;
        const earlySlice = data.byteLength <= remainingBytes ? data : data.subarray(0, remainingBytes);
        earlyOutputBytesRef.current += earlySlice.byteLength;
        earlyOutputRef.current += earlySlice.byteLength === data.byteLength
          ? getText()
          : ptyOutputDecoder.decode(earlySlice);
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
      // Restore text selection in dead terminal (ConPTY may not pass through
      // the disable sequences that Claude Code sends on exit)
      terminalRef.current?.write('\x1b[?1003l\x1b[?1006l');
      // Stop TCP tap server immediately (before any early-return paths)
      invoke("stop_tap_server", { sessionId: session.id }).catch(() => {});
      invoke("stop_codex_rollout", { sessionId: session.id }).catch(() => {});
      // [DS-07] [RS-06] Session-in-use auto-recovery: kill own orphans, retry; show overlay for external
      if (sessionInUseRef.current && !sessionInUseRetried.current) {
        sessionInUseRef.current = false;
        sessionInUseRetried.current = true;
        earlyOutputRef.current = "";
        earlyOutputBytesRef.current = 0;
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
              triggerRespawnRef.current();
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

  // ── Session restart ──────────────────────────────────────────────────
  const triggerRespawnRef = useRef<(config?: SessionConfig, name?: string) => void>(() => {});
  // Stable ref so callbacks can call triggerRespawn without stale closures
  // [RS-01] [PT-11] triggerRespawn: cleanup old PTY/watchers/inspector, allocate port, increment respawnCounter
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
    invoke("stop_codex_rollout", { sessionId: session.id }).catch(() => {});
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

    setLoading(!!newConfig.resumeSession);

    // 5. Reset internal state (inspector port allocated in doSpawn)
    spawnedRef.current = false;
    earlyOutputRef.current = "";
    earlyOutputBytesRef.current = 0;
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

  const handleResize = useCallback(
    (cols: number, rows: number) => {
      pty.handle.current?.resize(cols, rows);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.id]
  );

  const terminal = useTerminal({
    sessionId: session.id,
    onData: handleTermData,
    onResize: handleResize,
    instanceKey: respawnCounter,
    cwd: session.config.workingDir ?? null,
    scrollback: session.config.cli === "codex" ? CODEX_SCROLLBACK_LINES : CLAUDE_SCROLLBACK_LINES,
    enableWebgl: session.config.cli !== "codex",
    visible,
  });
  terminalRef.current = terminal;

  // Attach terminal to container
  const setContainer = useCallback(
    (el: HTMLDivElement | null) => {
      containerRef.current = el;
      terminal.attach(el);
    },
    [terminal.attach]
  );

  // [RS-07] Spawn PTY once; guards against dead sessions (prevents stale auto-spawn on startup).
  // Sessions wait for their selected CLI detection to complete. Claude still needs
  // the inspector/tap preparation, Codex uses the rollout watcher.
  useEffect(() => {
    if (spawnedRef.current || !initialized || session.state === "dead" || !terminal.ready) return;
    const missingCli =
      (session.config.cli === "claude" && !claudePath)
      || (session.config.cli === "codex" && !codexPath);
    if (!missingCli) return;
    spawnedRef.current = true;
    updateState(session.id, "error");
    terminal.write(`\r\n\x1b[31m${session.config.cli === "codex" ? "Codex" : "Claude Code"} is not installed.\x1b[0m\r\n`);
  }, [initialized, claudePath, codexPath, session.config.cli, session.id, session.state, terminal.ready, terminal.write, updateState]);

  useEffect(() => {
    if (spawnedRef.current || session.state === "dead" || !terminal.ready) return;
    if (session.config.cli === "claude" && !claudePath) return;
    if (session.config.cli === "codex" && !codexPath) return;

    const doSpawn = async () => {
      spawnedRef.current = true;
      const spawnSpan = startTraceSpan("session.spawn_sequence", {
        module: "terminal",
        sessionId: session.id,
        event: "session.spawn_sequence",
        warnAboveMs: 1000,
        data: {
            claudePath,
            codexPath,
          workingDir: session.config.workingDir,
          resumeSession: session.config.resumeSession,
          continueSession: session.config.continueSession,
        },
      });
      let codexRolloutStarted = false;
      let codexTrafficStarted = false;
      try {
        // Allocate a verified-free inspector port before spawning Claude.
        // Codex is a Rust binary and exposes structured data via rollout JSONL,
        // not the Bun inspector.
        let inspPort: number | null = null;
        if (session.config.cli === "claude") {
          inspPort = await allocateInspectorPort();
          registerInspectorPort(session.id, inspPort);
          setInspectorPort(inspPort);
          dlog("terminal", session.id, "allocated inspector port", "DEBUG", {
            event: "session.inspector_port_allocated",
            data: { inspectorPort: inspPort },
          });
        } else {
          setInspectorPort(null);
        }

        // Start TCP tap server for this session (before PTY spawn so port is ready).
        // Claude only — Codex sessions get observability via the rollout watcher
        // (see start_codex_rollout below).
        let tapPort: number | null = null;
        if (session.config.cli === "claude") {
          try {
            tapPort = await invoke<number>("start_tap_server", { sessionId: session.id });
            dlog("terminal", session.id, "tap server started", "DEBUG", {
              event: "session.tap_server_started",
              data: { tapPort },
            });
          } catch (err) {
            dlog("terminal", session.id, `tap server failed: ${err}`, "WARN");
          }
        }

        // Build launch config through the selected CLI adapter.
        const launchConfig: SessionConfig = { ...session.config };
        // Adapter dispatch: build the right SpawnSpec for whichever
        // CLI this session runs. ClaudeAdapter delegates to the
        // existing build_claude_args; CodexAdapter translates into
        // codex flags / subcommands.
        // Codex's `-c openai_base_url=...` proxy override is injected by
        // build_cli_spawn (backend), which also picks the right base path
        // (backend-api/codex vs v1) from ~/.codex/auth.json.
        const spawnSpec = await invoke<{
          program: string;
          args: string[];
          envOverrides: Array<[string, string | null]>;
          cwd: string;
        }>("build_cli_spawn", { config: launchConfig, sessionId: session.id });
        const args = [...spawnSpec.args];
        const program = spawnSpec.program;
        const { cols, rows } = terminal.getDimensions();
        const cwd = normalizePath(session.config.workingDir);
        const { proxyPort } = useSettingsStore.getState();
        // Pass BUN_INSPECT env for inspector-based hook injection,
        // TAP_PORT for dedicated TCP event delivery. Claude CLI sessions only.
        const env: Record<string, string> = {};
        if (session.config.cli === "claude") {
          env.BUN_INSPECT = `ws://127.0.0.1:${inspPort}/0`;
          if (tapPort) env.TAP_PORT = String(tapPort);
          // Claude's proxy hook is env-based; Codex's is the arg override
          // injected by build_cli_spawn.
          if (proxyPort) {
            env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}/s/${session.id}`;
          }
        }
        // Adapter-specific env overrides (e.g. RUST_LOG for Codex if
        // the adapter ever needs them; currently empty).
        for (const [k, v] of spawnSpec.envOverrides) {
          if (v === null) {
            delete env[k];
          } else {
            env[k] = v;
          }
        }
        dlog("terminal", session.id, `launching ${session.config.cli} session`, "LOG", {
          event: "session.launch",
          data: {
            cli: session.config.cli,
            program,
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

        // Codex creates its rollout JSONL during startup. Arm the watcher
        // immediately before PTY spawn so its mtime attribution window cannot
        // miss a fast-created file.
        if (session.config.cli === "codex") {
          if (observabilityEnabled && trafficEnabled && proxyPort && !trafficStartedRef.current) {
            try {
              const path = await invoke<string>("start_traffic_log", { sessionId: session.id });
              startTrafficLog(session.id, path);
              trafficStartedRef.current = true;
              codexTrafficStarted = true;
            } catch (err) {
              dlog("traffic", session.id, `codex auto-start failed: ${err}`, "WARN");
            }
          }
          try {
            await invoke("start_codex_rollout", { sessionId: session.id });
            codexRolloutStarted = true;
          } catch (err) {
            dlog("terminal", session.id, `start_codex_rollout failed: ${err}`, "WARN");
          }
        }
        const handle = await pty.spawn(program, args, cwd, cols, rows, env);
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

        spawnSpan.end({
          inspectorPort: inspPort,
          tapPort,
          ptyHandle: handle.pid,
          cols,
          rows,
        });
      } catch (err) {
        if (codexRolloutStarted) {
          invoke("stop_codex_rollout", { sessionId: session.id }).catch(() => {});
        }
        if (codexTrafficStarted) {
          invoke("stop_traffic_log", { sessionId: session.id }).catch(() => {});
          stopTrafficLog(session.id);
          trafficStartedRef.current = false;
        }
        spawnSpan.fail(err);
        dlog("terminal", session.id, `spawn failed: ${err}`, "ERR");
        updateState(session.id, "error");
        terminal.write(
          `\r\n\x1b[31mFailed to start ${session.config.cli === "codex" ? "Codex" : "Claude"}: ${err}\x1b[0m\r\n`
        );
      }
    };

    void doSpawn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudePath, codexPath, session.config, session.id, session.state, respawnCounter, terminal.ready]);

  // Register terminal buffer reader and terminal instance for search/render-wait
  useEffect(() => {
    registerBufferReader(session.id, terminal.getBufferText);
    if (terminal.termRef.current) {
      registerTerminal(session.id, terminal.termRef.current);
    }
    return () => {
      unregisterBufferReader(session.id);
      unregisterTerminal(session.id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, terminal.getBufferText, terminal.termGeneration]);

  // Cleanup PTY and registries on unmount
  useEffect(() => {
    const id = session.id;
    return () => {
      invoke("stop_tap_server", { sessionId: id }).catch(() => {});
      invoke("stop_codex_rollout", { sessionId: id }).catch(() => {});
      unregisterPtyWriter(id);
      unregisterPtyKill(id);
      unregisterPtyHandleId(id);
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

  // Watch for kill requests from the tab bar
  useEffect(() => {
    if (killRequest === session.id && session.state !== "dead") {
      clearKillRequest();
      dlog("terminal", session.id, "kill effect triggered");
      pty.cleanup();
      // pty.kill() fires exitCallback → handlePtyExit → state "dead"
    }
  }, [killRequest, session.id, session.state, clearKillRequest, pty]);

  // Keep focus on the visible terminal; attach/fit is handled by the terminal lifecycle.
  useEffect(() => {
    if (!visible) return;
    dlog("terminal", session.id, "panel became visible", "DEBUG", {
      event: "terminal.visible",
      data: { visible },
    });
    terminal.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, session.id, terminal.termGeneration]);

  // Reclaim focus when terminal is visible but loses it to non-interactive elements.
  // Uses termRef directly instead of terminal (which is a new object every render).
  useEffect(() => {
    if (!visible) return;

    let cancelled = false;
    const overlaySelector = ".launcher-overlay, .resume-picker-overlay, .modal-overlay, .palette-overlay, .diff-panel";
    const interactiveSelector = "button, input, textarea, select, [role=button], [role=tab], a[href], [contenteditable=true]";

    const handleFocusOut = () => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        const active = document.activeElement as HTMLElement | null;
        if (document.querySelector(overlaySelector)) return;
        if (active?.closest(".right-panel") && active.matches(interactiveSelector)) return;
        if (active?.matches("input, textarea, select, [contenteditable=true]")) return;
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
                    triggerRespawnRef.current();
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
}, terminalPanelPropsEqual);

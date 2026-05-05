import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { dlog } from "../../lib/debugLog";
import {
  allocateInspectorPort,
  registerInspectorPort,
} from "../../lib/inspectorPort";
import {
  registerPtyHandleId,
  registerPtyKill,
  registerPtyWriter,
} from "../../lib/ptyRegistry";
import { normalizePath } from "../../lib/paths";
import { startTraceSpan } from "../../lib/perfTrace";
import { useSessionStore } from "../../store/sessions";
import { useSettingsStore } from "../../store/settings";
import type { Session, SessionConfig } from "../../types/session";
import type { PtyController, TerminalController } from "./terminalPanelTypes";

interface UseTerminalSetupParams {
  claudePath: string | null;
  codexPath: string | null;
  initialized: boolean;
  observabilityEnabled: boolean;
  pty: PtyController;
  respawnCounter: number;
  session: Session;
  setInspectorPort: Dispatch<SetStateAction<number | null>>;
  startTrafficLog: (sessionId: string, path: string) => void;
  stopTrafficLog: (sessionId: string) => void;
  terminal: TerminalController;
  trafficEnabled: boolean;
  trafficStartedRef: MutableRefObject<boolean>;
}

export function useTerminalSetup({
  claudePath,
  codexPath,
  initialized,
  observabilityEnabled,
  pty,
  respawnCounter,
  session,
  setInspectorPort,
  startTrafficLog,
  stopTrafficLog,
  terminal,
  trafficEnabled,
  trafficStartedRef,
}: UseTerminalSetupParams): void {
  const updateState = useSessionStore((s) => s.updateState);
  const spawnedKeyRef = useRef<number | null>(null);

  // [RS-07] Spawn PTY once per respawn key; guards against dead sessions.
  // Sessions wait for missing-CLI detection before showing an install error.
  // Claude still needs the inspector/tap preparation, Codex uses the rollout watcher.
  useEffect(() => {
    if (spawnedKeyRef.current === respawnCounter || session.state === "dead" || !terminal.ready) return;

    const missingCli =
      (session.config.cli === "claude" && !claudePath)
      || (session.config.cli === "codex" && !codexPath);
    if (missingCli) {
      if (!initialized) return;
      spawnedKeyRef.current = respawnCounter;
      updateState(session.id, "error");
      terminal.write(`\r\n\x1b[31m${session.config.cli === "codex" ? "Codex" : "Claude Code"} is not installed.\x1b[0m\r\n`);
      return;
    }

    const doSpawn = async () => {
      spawnedKeyRef.current = respawnCounter;
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
          forkSession: session.config.forkSession,
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
        // Claude only - Codex sessions get observability via the rollout watcher
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
            forkSession: session.config.forkSession,
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
            const codexSessionId =
              session.config.resumeSession
              && !session.config.forkSession
              && !session.config.continueSession
                ? session.config.resumeSession
                : null;
            await invoke("start_codex_rollout", { sessionId: session.id, codexSessionId });
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
  }, [
    claudePath,
    codexPath,
    initialized,
    observabilityEnabled,
    pty.spawn,
    respawnCounter,
    session,
    setInspectorPort,
    startTrafficLog,
    stopTrafficLog,
    terminal.getDimensions,
    terminal.ready,
    terminal.write,
    trafficEnabled,
    trafficStartedRef,
    updateState,
  ]);
}

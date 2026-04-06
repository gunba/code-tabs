// [PT-01] Direct PTY wrapper — calls Tauri IPC commands for PTY lifecycle.
import { invoke } from "@tauri-apps/api/core";
import { dlog } from "./debugLog";

// [PT-07] Active PID registry for cleanup on app close

const activePids = new Set<number>();

export function registerActivePid(osPid: number): void {
  activePids.add(osPid);
  invoke("register_active_pid", { pid: osPid }).catch(() => {});
}

export function unregisterActivePid(osPid: number): void {
  activePids.delete(osPid);
  invoke("unregister_active_pid", { pid: osPid }).catch(() => {});
}

/** [PS-04] Fire-and-forget kill all active PTY process trees. Called on beforeunload. */
export function killAllActivePtys(): void {
  for (const pid of activePids) {
    invoke("kill_process_tree", { pid }).catch(() => {});
  }
  activePids.clear();
}

export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): Promise<void>;
  onData(cb: (data: Uint8Array) => void): void;
  onExit(cb: (info: { exitCode: number }) => void): void;
}

interface SpawnOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  sessionId?: string | null;
}

function escapeDataPreview(data: string): string {
  return data
    .replace(/\x1b/g, "\\x1b")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .slice(0, 240);
}

// ── PTY Spawn ────────────────────────────────────────────────────

export async function spawnPty(
  file: string,
  args: string[],
  options: SpawnOptions = {}
): Promise<PtyProcess> {
  const sessionId = options.sessionId ?? null;
  dlog("pty", sessionId, "spawnPty invoke", "DEBUG", {
    event: "pty.invoke_spawn",
    data: {
      file,
      args,
      cwd: options.cwd ?? null,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      envKeys: Object.keys(options.env ?? {}),
    },
  });
  const pid: number = await invoke("pty_spawn", {
    file,
    args,
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    cwd: options.cwd,
    env: options.env ?? {},
  });

  dlog("pty", sessionId, `spawned pid=${pid} file=${file}`, "LOG", {
    event: "pty.spawned",
    data: { pid, file, cwd: options.cwd ?? null },
  });

  // Get OS PID immediately and register for cleanup on app close
  let osPid: number | null = null;
  try {
    osPid = await invoke("pty_get_child_pid", { pid });
    if (osPid) {
      registerActivePid(osPid);
      dlog("pty", sessionId, "resolved PTY child pid", "DEBUG", {
        event: "pty.child_pid_resolved",
        data: { pid, osPid },
      });
    }
  } catch {
    // Process may have exited instantly
  }

  let aborted = false;
  let dataCallback: ((data: Uint8Array) => void) | null = null;
  let exitCallback: ((info: { exitCode: number }) => void) | null = null;
  let exitFired = false;

  // [PT-04] exitFired guard ensures exactly one exitCallback fires
  const fireExit = (code: number) => {
    if (osPid) unregisterActivePid(osPid);
    if (exitFired) return;
    exitFired = true;
    aborted = true;
    dlog("pty", sessionId, `exit pid=${pid} code=${code}`, "LOG", {
      event: "pty.exit",
      data: { pid, osPid, exitCode: code },
    });
    exitCallback?.({ exitCode: code });
  };

  // Start read loop
  const readLoop = async () => {
    while (!aborted) {
      try {
        const raw: ArrayBuffer = await invoke("pty_read", { pid });
        if (aborted) break;
        // Tauri ipc::Response returns raw binary as ArrayBuffer — zero-copy
        const bytes = new Uint8Array(raw);
        dataCallback?.(bytes);
      } catch (err) {
        dlog("pty", sessionId, `pty_read ended pid=${pid}: ${err}`, "DEBUG", {
          event: "pty.read_end",
          data: { pid, error: String(err) },
        });
        // EOF or error — session ended
        break;
      }
    }
    dlog("pty", sessionId, `read loop exited pid=${pid} aborted=${aborted}`, "DEBUG", {
      event: "pty.read_loop_exit",
      data: { pid, aborted },
    });
    let exitCode = -1;
    try {
      exitCode = await invoke("pty_exitstatus", { pid });
    } catch {
      // Process already cleaned up — use default -1
    }
    fireExit(exitCode);
  };
  readLoop();

  // [PT-10] Parallel exit waiter — catches Ctrl+C exits where ConPTY pipe stays open.
  // exitstatus calls child.wait() on the Rust side (WaitForSingleObject), which
  // reliably returns when the child exits regardless of ConPTY pipe state.
  void invoke<number>("pty_exitstatus", { pid })
    .then((code) => {
      dlog("pty", sessionId, "exitstatus waiter resolved", "DEBUG", {
        event: "pty.exitstatus_waiter",
        data: { pid, exitCode: code },
      });
      fireExit(code);
    })
    .catch(() => { /* process already cleaned up */ });

  return {
    pid,

    write(data: string) {
      if (!aborted) {
        dlog("pty", sessionId, "writing to PTY transport", "DEBUG", {
          event: "pty.write_transport",
          data: {
            pid,
            length: data.length,
            text: data,
            preview: escapeDataPreview(data),
          },
        });
        invoke("pty_write", { pid, data }).catch(() => {});
      }
    },

    resize(cols: number, rows: number) {
      if (!aborted) {
        dlog("pty", sessionId, "resizing PTY transport", "DEBUG", {
          event: "pty.resize_transport",
          data: { pid, cols, rows },
        });
        invoke("pty_resize", { pid, cols, rows }).catch(() => {});
      }
    },

    async kill() {
      if (aborted) return;
      aborted = true;
      dlog("pty", sessionId, `kill started pid=${pid}`, "LOG", {
        event: "pty.kill_started",
        data: { pid, osPid },
      });

      // Unregister from cleanup registry (we're handling it ourselves)
      if (osPid) unregisterActivePid(osPid);

      // 1. Get OS PID if we don't have it yet
      if (!osPid) {
        try {
          osPid = await invoke("pty_get_child_pid", { pid });
        } catch {
          // Process may already be dead
        }
      }

      // 2. Kill the child process
      try {
        await invoke("pty_kill", { pid });
      } catch {
        // Already dead
      }

      // 3. Wait briefly for exit
      const exited = await Promise.race([
        invoke("pty_exitstatus", { pid }).then(() => true).catch(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
      ]);

      // 4. Fallback: kill process tree if still alive
      if (!exited && osPid) {
        try {
          await invoke("kill_process_tree", { pid: osPid });
          dlog("pty", sessionId, `kill fallback tree kill pid=${pid} osPid=${osPid}`, "WARN", {
            event: "pty.kill_fallback_tree",
            data: { pid, osPid },
          });
        } catch {
          // Best effort
        }
      }

      // [PT-18] Drain remaining output from the channel
      try {
        await invoke("pty_drain_output", { pid });
        dlog("pty", sessionId, "drained PTY output after kill", "DEBUG", {
          event: "pty.drain_output",
          data: { pid },
        });
      } catch {
        // Best effort
      }

      // 6. Destroy session — remove from BTreeMap, trigger Drop chain
      try {
        await invoke("pty_destroy", { pid });
        dlog("pty", sessionId, "destroyed PTY session", "DEBUG", {
          event: "pty.destroy",
          data: { pid },
        });
      } catch {
        // Best effort
      }

      dlog("pty", sessionId, `kill completed pid=${pid}`, "LOG", {
        event: "pty.kill_completed",
        data: { pid, osPid },
      });
      fireExit(-1);
    },

    onData(cb) {
      dataCallback = cb;
    },

    onExit(cb) {
      exitCallback = cb;
    },
  };
}

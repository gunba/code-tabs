/**
 * Direct PTY wrapper — replaces `tauri-pty` npm package.
 * Calls `invoke('plugin:pty|...')` directly, with proper cleanup lifecycle.
 */
import { invoke } from "@tauri-apps/api/core";
import { dlog } from "./debugLog";

// ── Active PID registry for cleanup on app close ──────────────────

const activePids = new Set<number>();

export function registerActivePid(osPid: number): void {
  activePids.add(osPid);
  invoke("register_active_pid", { pid: osPid }).catch(() => {});
}

export function unregisterActivePid(osPid: number): void {
  activePids.delete(osPid);
  invoke("unregister_active_pid", { pid: osPid }).catch(() => {});
}

/** Fire-and-forget kill all active PTY process trees. Called on beforeunload. */
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
}

export async function spawnPty(
  file: string,
  args: string[],
  options: SpawnOptions = {}
): Promise<PtyProcess> {
  const pid: number = await invoke("plugin:pty|spawn", {
    file,
    args,
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    cwd: options.cwd,
    env: options.env ?? {},
  });

  dlog("pty", null, `spawned pid=${pid} file=${file}`);

  // Get OS PID immediately and register for cleanup on app close
  let osPid: number | null = null;
  try {
    osPid = await invoke("plugin:pty|get_child_pid", { pid });
    if (osPid) registerActivePid(osPid);
  } catch {
    // Process may have exited instantly
  }

  let aborted = false;
  let dataCallback: ((data: Uint8Array) => void) | null = null;
  let exitCallback: ((info: { exitCode: number }) => void) | null = null;
  let exitFired = false;

  const fireExit = (code: number) => {
    if (osPid) unregisterActivePid(osPid);
    if (exitFired) return;
    exitFired = true;
    aborted = true;
    dlog("pty", null, `exit pid=${pid} code=${code}`);
    exitCallback?.({ exitCode: code });
  };

  // Start read loop
  const readLoop = async () => {
    while (!aborted) {
      try {
        const raw: number[] = await invoke("plugin:pty|read", { pid });
        if (aborted) break;
        // Tauri IPC serializes Vec<u8> as JSON number[] — convert to Uint8Array
        const bytes = Uint8Array.from(raw);
        dataCallback?.(bytes);
      } catch {
        // EOF or error — session ended
        break;
      }
    }
    dlog("pty", null, `read loop exited pid=${pid} aborted=${aborted}`);
    let exitCode = -1;
    try {
      exitCode = await invoke("plugin:pty|exitstatus", { pid });
    } catch {
      // Process already cleaned up — use default -1
    }
    fireExit(exitCode);
  };
  readLoop();

  // Parallel exit waiter — catches Ctrl+C exits where ConPTY pipe stays open.
  // exitstatus calls child.wait() on the Rust side (WaitForSingleObject), which
  // reliably returns when the child exits regardless of ConPTY pipe state.
  void invoke<number>("plugin:pty|exitstatus", { pid })
    .then((code) => fireExit(code))
    .catch(() => { /* process already cleaned up */ });

  return {
    pid,

    write(data: string) {
      if (!aborted) {
        invoke("plugin:pty|write", { pid, data }).catch(() => {});
      }
    },

    resize(cols: number, rows: number) {
      if (!aborted) {
        invoke("plugin:pty|resize", { pid, cols, rows }).catch(() => {});
      }
    },

    async kill() {
      if (aborted) return;
      aborted = true;
      dlog("pty", null, `kill started pid=${pid}`);

      // Unregister from cleanup registry (we're handling it ourselves)
      if (osPid) unregisterActivePid(osPid);

      // 1. Get OS PID if we don't have it yet
      if (!osPid) {
        try {
          osPid = await invoke("plugin:pty|get_child_pid", { pid });
        } catch {
          // Process may already be dead
        }
      }

      // 2. Kill the child process
      try {
        await invoke("plugin:pty|kill", { pid });
      } catch {
        // Already dead
      }

      // 3. Wait briefly for exit
      const exited = await Promise.race([
        invoke("plugin:pty|exitstatus", { pid }).then(() => true).catch(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
      ]);

      // 4. Fallback: kill process tree if still alive
      if (!exited && osPid) {
        try {
          await invoke("kill_process_tree", { pid: osPid });
        } catch {
          // Best effort
        }
      }

      // 5. Drain remaining output from the channel
      try {
        await invoke("plugin:pty|drain_output", { pid });
      } catch {
        // Best effort
      }

      // 6. Destroy session — remove from BTreeMap, trigger Drop chain
      try {
        await invoke("plugin:pty|destroy", { pid });
      } catch {
        // Best effort
      }

      dlog("pty", null, `kill completed pid=${pid}`);
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

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @tauri-apps/api/core before importing the module under test
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { spawnPty } from "../ptyProcess";

const mockInvoke = vi.mocked(invoke);

/**
 * Helper: builds a controllable mock for invoke() that routes by command string.
 * Each command gets its own deferred promise that tests can resolve/reject on demand.
 */
function createInvokeRouter() {
  const deferreds = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; promise: Promise<unknown> }[]
  >();

  /** Get (or create) the next deferred for a command. */
  function nextDeferred(cmd: string) {
    if (!deferreds.has(cmd)) deferreds.set(cmd, []);
    const list = deferreds.get(cmd)!;
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const d = { resolve, reject, promise };
    list.push(d);
    return d;
  }

  /** How many outstanding (unresolved) deferreds exist for `cmd`. */
  function pendingCount(cmd: string): number {
    return deferreds.get(cmd)?.length ?? 0;
  }

  mockInvoke.mockImplementation((cmd: string, ..._args: unknown[]) => {
    // Commands that should resolve immediately
    if (
      cmd === "register_active_pid" ||
      cmd === "unregister_active_pid" ||
      cmd === "kill_process_tree"
    ) {
      return Promise.resolve(undefined) as ReturnType<typeof invoke>;
    }
    // spawn returns a pid
    if (cmd === "plugin:pty|spawn") {
      return Promise.resolve(42) as ReturnType<typeof invoke>;
    }
    // get_child_pid returns an OS pid
    if (cmd === "plugin:pty|get_child_pid") {
      return Promise.resolve(1000) as ReturnType<typeof invoke>;
    }

    // For read and exitstatus, use deferred promises so tests control resolution order
    const d = nextDeferred(cmd);
    return d.promise as ReturnType<typeof invoke>;
  });

  return { nextDeferred, pendingCount, deferreds };
}

describe("spawnPty — parallel exit waiter", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    vi.restoreAllMocks();
  });

  it("fires exitCallback when parallel waiter resolves before read loop", async () => {
    const router = createInvokeRouter();
    const pty = await spawnPty("cmd.exe", []);

    const exitSpy = vi.fn();
    pty.onExit(exitSpy);

    // At this point, the read loop has called invoke("plugin:pty|read") — it's pending.
    // The parallel waiter has called invoke("plugin:pty|exitstatus") — also pending.
    // There are 2 exitstatus calls: one from readLoop's post-loop cleanup path, and one
    // from the parallel waiter. But the readLoop one only fires after the loop breaks.

    // Resolve the parallel exitstatus waiter first (it was queued first in deferreds)
    const exitDeferreds = router.deferreds.get("plugin:pty|exitstatus");
    expect(exitDeferreds).toBeDefined();
    expect(exitDeferreds!.length).toBeGreaterThanOrEqual(1);
    exitDeferreds![0].resolve(0);

    // Let microtasks flush
    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledTimes(1);
    });
    expect(exitSpy).toHaveBeenCalledWith({ exitCode: 0 });

    // Now let the read loop error out (simulating EOF after the parallel waiter fired)
    const readDeferreds = router.deferreds.get("plugin:pty|read");
    expect(readDeferreds).toBeDefined();
    readDeferreds![0].reject(new Error("EOF"));

    // Flush microtasks — the read loop's post-exit path should NOT fire again
    await vi.waitFor(() => {
      // Resolve the readLoop's exitstatus call if it appears
      const allExitDeferreds = router.deferreds.get("plugin:pty|exitstatus");
      if (allExitDeferreds && allExitDeferreds.length > 1) {
        allExitDeferreds[1].resolve(0);
      }
    });

    // exitCallback should still have been called only once (exitFired guard)
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it("does not double-fire exitCallback when read loop exits first", async () => {
    const router = createInvokeRouter();
    const pty = await spawnPty("cmd.exe", []);

    const exitSpy = vi.fn();
    pty.onExit(exitSpy);

    // Break the read loop first by rejecting the read
    const readDeferreds = router.deferreds.get("plugin:pty|read");
    expect(readDeferreds).toBeDefined();
    readDeferreds![0].reject(new Error("EOF"));

    // The read loop will now call exitstatus. Wait for it to appear in deferreds.
    await vi.waitFor(() => {
      const exitDeferreds = router.deferreds.get("plugin:pty|exitstatus");
      // We need at least 2: one from parallel waiter, one from readLoop post-break
      expect(exitDeferreds).toBeDefined();
      expect(exitDeferreds!.length).toBeGreaterThanOrEqual(2);
    });

    const exitDeferreds = router.deferreds.get("plugin:pty|exitstatus")!;

    // Resolve the readLoop's exitstatus call (the second one queued)
    exitDeferreds[1].resolve(130);

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledTimes(1);
    });
    expect(exitSpy).toHaveBeenCalledWith({ exitCode: 130 });

    // Now resolve the parallel waiter's exitstatus (the first one queued)
    exitDeferreds[0].resolve(130);

    // Flush microtasks
    await new Promise((r) => setTimeout(r, 10));

    // Still only 1 call — exitFired guard prevents double-fire
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it("parallel waiter sets aborted=true so read loop stops", async () => {
    const router = createInvokeRouter();
    const pty = await spawnPty("cmd.exe", []);

    const dataSpy = vi.fn();
    pty.onData(dataSpy);

    // Resolve the parallel exitstatus waiter
    const exitDeferreds = router.deferreds.get("plugin:pty|exitstatus");
    expect(exitDeferreds).toBeDefined();
    exitDeferreds![0].resolve(0);

    // Flush microtasks so the .then() runs and sets aborted=true
    await new Promise((r) => setTimeout(r, 10));

    // Now resolve the pending read — even though it returns data,
    // the read loop should NOT process it because aborted is true
    const readDeferreds = router.deferreds.get("plugin:pty|read");
    expect(readDeferreds).toBeDefined();
    readDeferreds![0].resolve([72, 105]); // "Hi"

    await new Promise((r) => setTimeout(r, 10));

    // dataCallback should NOT have been called because the loop checks aborted after await
    expect(dataSpy).not.toHaveBeenCalled();
  });

  it("parallel waiter catches errors without throwing", async () => {
    const router = createInvokeRouter();
    const pty = await spawnPty("cmd.exe", []);

    const exitSpy = vi.fn();
    pty.onExit(exitSpy);

    // Reject the parallel exitstatus waiter (simulates already-cleaned-up process)
    const exitDeferreds = router.deferreds.get("plugin:pty|exitstatus");
    expect(exitDeferreds).toBeDefined();
    exitDeferreds![0].reject(new Error("process already cleaned up"));

    // Should not throw — the .catch() in the IIFE handles it
    await new Promise((r) => setTimeout(r, 10));

    // exitCallback should NOT have been called (only .catch ran, not .then)
    expect(exitSpy).not.toHaveBeenCalled();

    // Now let the read loop handle exit normally
    const readDeferreds = router.deferreds.get("plugin:pty|read");
    readDeferreds![0].reject(new Error("EOF"));

    await vi.waitFor(() => {
      const allExitDeferreds = router.deferreds.get("plugin:pty|exitstatus");
      expect(allExitDeferreds!.length).toBeGreaterThanOrEqual(2);
    });

    router.deferreds.get("plugin:pty|exitstatus")![1].resolve(1);

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledTimes(1);
    });
    expect(exitSpy).toHaveBeenCalledWith({ exitCode: 1 });
  });
});

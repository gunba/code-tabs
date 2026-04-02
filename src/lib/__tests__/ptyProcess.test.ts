import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { spawnPty, killAllActivePtys } from "../ptyProcess";

const mockInvoke = vi.mocked(invoke);

/**
 * Controllable invoke mock router — each IPC command gets deferred promises
 * so tests control resolution order.
 */
function createInvokeRouter(overrides?: Record<string, (args: unknown) => unknown>) {
  const deferreds = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; promise: Promise<unknown> }[]
  >();

  function defer(cmd: string) {
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

  mockInvoke.mockImplementation((cmd: string, ...rest: unknown[]) => {
    // Immediate-resolve commands
    if (
      cmd === "register_active_pid" ||
      cmd === "unregister_active_pid" ||
      cmd === "kill_process_tree"
    ) {
      return Promise.resolve(undefined) as ReturnType<typeof invoke>;
    }
    if (cmd === "pty_spawn") {
      return Promise.resolve(42) as ReturnType<typeof invoke>;
    }
    if (cmd === "pty_get_child_pid") {
      return Promise.resolve(1000) as ReturnType<typeof invoke>;
    }

    // Override hooks for specific commands (e.g. pty_kill, pty_drain_output, pty_destroy)
    if (overrides?.[cmd]) {
      const result = overrides[cmd](rest[0]);
      return (result instanceof Promise ? result : Promise.resolve(result)) as ReturnType<typeof invoke>;
    }

    // Default: deferred promise
    const d = defer(cmd);
    return d.promise as ReturnType<typeof invoke>;
  });

  return { defer, deferreds };
}

/** Overrides that make pty_kill, pty_drain_output, pty_destroy resolve immediately. */
const KILL_OVERRIDES = {
  pty_kill: () => Promise.resolve(undefined),
  pty_drain_output: () => Promise.resolve(undefined),
  pty_destroy: () => Promise.resolve(undefined),
} as const;

/** Spawn a PTY, start kill(), resolve exitstatus deferreds, and await completion. */
async function spawnAndKill(overrides = KILL_OVERRIDES) {
  const router = createInvokeRouter(overrides);
  const pty = await spawnPty("cmd.exe", []);
  const killPromise = pty.kill();
  await vi.waitFor(() => {
    const d = router.deferreds.get("pty_exitstatus");
    expect(d).toBeDefined();
    expect(d!.length).toBeGreaterThanOrEqual(1);
  });
  for (const d of router.deferreds.get("pty_exitstatus") ?? []) d.resolve(0);
  await killPromise;
  return { router, pty };
}

/** Reset mock and clear the global activePids set between tests. */
function resetState() {
  mockInvoke.mockReset();
  vi.restoreAllMocks();
  // killAllActivePtys calls invoke("kill_process_tree") — needs a resolved Promise mock
  mockInvoke.mockResolvedValue(undefined as never);
  killAllActivePtys();
  mockInvoke.mockReset();
}

describe("spawnPty — spawn args and returned object", () => {
  beforeEach(resetState);

  it("passes file, args, and default dimensions to pty_spawn", async () => {
    createInvokeRouter();
    await spawnPty("bash", ["-l"]);

    const spawnCall = mockInvoke.mock.calls.find(([cmd]) => cmd === "pty_spawn");
    expect(spawnCall).toBeDefined();
    expect(spawnCall![1]).toEqual({
      file: "bash",
      args: ["-l"],
      cols: 80,
      rows: 24,
      cwd: undefined,
      env: {},
    });
  });

  it("passes custom cwd, cols, rows, and env", async () => {
    createInvokeRouter();
    await spawnPty("bash", [], {
      cwd: "/tmp",
      cols: 120,
      rows: 40,
      env: { FOO: "bar" },
    });

    const spawnCall = mockInvoke.mock.calls.find(([cmd]) => cmd === "pty_spawn");
    expect(spawnCall![1]).toEqual({
      file: "bash",
      args: [],
      cols: 120,
      rows: 40,
      cwd: "/tmp",
      env: { FOO: "bar" },
    });
  });

  it("returns a PtyProcess with the correct pid", async () => {
    createInvokeRouter();
    const pty = await spawnPty("cmd.exe", []);
    expect(pty.pid).toBe(42);
  });

  it("registers the OS PID for cleanup immediately after spawn", async () => {
    createInvokeRouter();
    await spawnPty("cmd.exe", []);

    const registerCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "register_active_pid"
    );
    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0][1]).toEqual({ pid: 1000 });
  });
});

describe("spawnPty — write and resize", () => {
  beforeEach(resetState);

  it("write() calls pty_write with pid and data", async () => {
    createInvokeRouter();
    const pty = await spawnPty("cmd.exe", []);

    pty.write("hello\r");

    const writeCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "pty_write");
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0][1]).toEqual({ pid: 42, data: "hello\r" });
  });

  it("write() is a no-op after kill()", async () => {
    const { pty } = await spawnAndKill();

    mockInvoke.mockClear();
    pty.write("should not send");

    const writeCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "pty_write");
    expect(writeCalls).toHaveLength(0);
  });

  it("resize() calls pty_resize with pid, cols, rows", async () => {
    createInvokeRouter();
    const pty = await spawnPty("cmd.exe", []);

    pty.resize(120, 40);

    const resizeCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "pty_resize");
    expect(resizeCalls).toHaveLength(1);
    expect(resizeCalls[0][1]).toEqual({ pid: 42, cols: 120, rows: 40 });
  });

  it("resize() is a no-op after kill()", async () => {
    const { pty } = await spawnAndKill();

    mockInvoke.mockClear();
    pty.resize(200, 50);

    const resizeCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "pty_resize");
    expect(resizeCalls).toHaveLength(0);
  });
});

describe("spawnPty — onData callback", () => {
  beforeEach(resetState);

  it("delivers read data to the onData callback", async () => {
    const router = createInvokeRouter();
    const pty = await spawnPty("cmd.exe", []);

    const chunks: Uint8Array[] = [];
    pty.onData((data) => chunks.push(data));

    const readDeferreds = router.deferreds.get("pty_read");
    expect(readDeferreds).toBeDefined();
    readDeferreds![0].resolve(new ArrayBuffer(3));

    await vi.waitFor(() => {
      expect(chunks).toHaveLength(1);
    });
    expect(chunks[0]).toBeInstanceOf(Uint8Array);
    expect(chunks[0].length).toBe(3);
  });

  it("delivers multiple reads in sequence", async () => {
    const router = createInvokeRouter();
    const pty = await spawnPty("cmd.exe", []);

    const chunks: Uint8Array[] = [];
    pty.onData((data) => chunks.push(data));

    router.deferreds.get("pty_read")![0].resolve(new ArrayBuffer(2));

    await vi.waitFor(() => {
      expect(chunks).toHaveLength(1);
    });

    await vi.waitFor(() => {
      expect(router.deferreds.get("pty_read")!.length).toBeGreaterThanOrEqual(2);
    });

    router.deferreds.get("pty_read")![1].resolve(new ArrayBuffer(5));

    await vi.waitFor(() => {
      expect(chunks).toHaveLength(2);
    });
    expect(chunks[1].length).toBe(5);
  });
});

describe("spawnPty — kill sequence", () => {
  beforeEach(resetState);

  it("kill() calls pty_kill, pty_drain_output, pty_destroy in order", async () => {
    const callOrder: string[] = [];
    const killOverrides: Record<string, () => Promise<unknown>> = {
      pty_kill: () => { callOrder.push("pty_kill"); return Promise.resolve(undefined); },
      pty_drain_output: () => { callOrder.push("pty_drain_output"); return Promise.resolve(undefined); },
      pty_destroy: () => { callOrder.push("pty_destroy"); return Promise.resolve(undefined); },
    };
    const router = createInvokeRouter(killOverrides);
    const pty = await spawnPty("cmd.exe", []);

    const killPromise = pty.kill();

    // Resolve exitstatus deferreds so the race completes
    await vi.waitFor(() => {
      const exitDeferreds = router.deferreds.get("pty_exitstatus");
      expect(exitDeferreds).toBeDefined();
      expect(exitDeferreds!.length).toBeGreaterThanOrEqual(1);
    });
    for (const d of router.deferreds.get("pty_exitstatus") ?? []) {
      d.resolve(0);
    }

    await killPromise;

    expect(callOrder).toEqual(["pty_kill", "pty_drain_output", "pty_destroy"]);
  });

  it("kill() fires exitCallback with code -1 when parallel waiter has not fired", async () => {
    const killOverrides = {
      pty_kill: () => Promise.resolve(undefined),
      pty_drain_output: () => Promise.resolve(undefined),
      pty_destroy: () => Promise.resolve(undefined),
    };
    const router = createInvokeRouter(killOverrides);
    const pty = await spawnPty("cmd.exe", []);

    const exitSpy = vi.fn();
    pty.onExit(exitSpy);

    const killPromise = pty.kill();

    // Wait for kill's exitstatus call to appear (in addition to the parallel waiter's)
    await vi.waitFor(() => {
      const exitDeferreds = router.deferreds.get("pty_exitstatus");
      expect(exitDeferreds).toBeDefined();
      // At least 2: parallel waiter [0] + kill's race [1]
      expect(exitDeferreds!.length).toBeGreaterThanOrEqual(2);
    });

    const exitDeferreds = router.deferreds.get("pty_exitstatus")!;
    // Reject the parallel waiter's deferred so it doesn't fire first
    exitDeferreds[0].reject(new Error("cleaned up"));
    // Resolve kill's own exitstatus (the race succeeds, then kill continues to fireExit(-1))
    exitDeferreds[1].resolve(0);

    await killPromise;

    // kill() calls fireExit(-1) at the end, after the race completes
    expect(exitSpy).toHaveBeenCalledWith({ exitCode: -1 });
  });

  it("kill() is idempotent — second call returns immediately", async () => {
    const { pty } = await spawnAndKill();

    const exitSpy = vi.fn();
    pty.onExit(exitSpy);

    // Second kill should be a no-op
    mockInvoke.mockClear();
    await pty.kill();

    const ptyCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "pty_kill" || cmd === "pty_destroy"
    );
    expect(ptyCalls).toHaveLength(0);
    // exitCallback was already fired during spawnAndKill; registering after means no new calls
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("kill() unregisters the OS PID", async () => {
    await spawnAndKill();

    const unregisterCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "unregister_active_pid"
    );
    expect(unregisterCalls.length).toBeGreaterThanOrEqual(1);
    expect(unregisterCalls[0][1]).toEqual({ pid: 1000 });
  });
});

describe("spawnPty — natural exit via read loop", () => {
  beforeEach(resetState);

  it("read loop EOF triggers exitstatus and fires exit callback", async () => {
    const router = createInvokeRouter();
    const pty = await spawnPty("cmd.exe", []);

    const exitSpy = vi.fn();
    pty.onExit(exitSpy);

    // Break the read loop with EOF
    const readDeferreds = router.deferreds.get("pty_read");
    expect(readDeferreds).toBeDefined();
    readDeferreds![0].reject(new Error("EOF"));

    // The read loop will call pty_exitstatus after breaking
    await vi.waitFor(() => {
      const exitDeferreds = router.deferreds.get("pty_exitstatus");
      expect(exitDeferreds).toBeDefined();
      expect(exitDeferreds!.length).toBeGreaterThanOrEqual(2);
    });

    // Resolve the readLoop's exitstatus (index 1, since index 0 is the parallel waiter)
    router.deferreds.get("pty_exitstatus")![1].resolve(0);

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledTimes(1);
    });
    expect(exitSpy).toHaveBeenCalledWith({ exitCode: 0 });
  });

  it("natural exit unregisters the OS PID", async () => {
    const router = createInvokeRouter();
    await spawnPty("cmd.exe", []);

    // Trigger the parallel exit waiter
    const exitDeferreds = router.deferreds.get("pty_exitstatus");
    expect(exitDeferreds).toBeDefined();
    exitDeferreds![0].resolve(0);

    // Wait for fireExit to run
    await vi.waitFor(() => {
      const unregisterCalls = mockInvoke.mock.calls.filter(
        ([cmd]) => cmd === "unregister_active_pid"
      );
      expect(unregisterCalls.length).toBeGreaterThanOrEqual(1);
    });

    const unregisterCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "unregister_active_pid"
    );
    expect(unregisterCalls[0][1]).toEqual({ pid: 1000 });
  });

  it("exitstatus failure in read loop post-break uses exit code -1", async () => {
    const router = createInvokeRouter();
    const pty = await spawnPty("cmd.exe", []);

    const exitSpy = vi.fn();
    pty.onExit(exitSpy);

    // Break the read loop
    router.deferreds.get("pty_read")![0].reject(new Error("EOF"));

    // Wait for readLoop's exitstatus call
    await vi.waitFor(() => {
      const exitDeferreds = router.deferreds.get("pty_exitstatus");
      expect(exitDeferreds!.length).toBeGreaterThanOrEqual(2);
    });

    // Reject the parallel waiter's exitstatus
    router.deferreds.get("pty_exitstatus")![0].reject(new Error("cleaned up"));

    // Reject the readLoop's exitstatus too — should fall back to -1
    router.deferreds.get("pty_exitstatus")![1].reject(new Error("cleaned up"));

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledTimes(1);
    });
    expect(exitSpy).toHaveBeenCalledWith({ exitCode: -1 });
  });
});

describe("spawnPty — edge cases", () => {
  beforeEach(resetState);

  it("handles pty_get_child_pid failure gracefully (process exits instantly)", async () => {
    // Override pty_get_child_pid to reject
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "pty_spawn") return Promise.resolve(42) as ReturnType<typeof invoke>;
      if (cmd === "pty_get_child_pid") return Promise.reject(new Error("no child"));
      if (
        cmd === "register_active_pid" ||
        cmd === "unregister_active_pid" ||
        cmd === "kill_process_tree"
      ) {
        return Promise.resolve(undefined) as ReturnType<typeof invoke>;
      }
      // Hang everything else so spawnPty completes without read loop breaking
      return new Promise(() => {}) as ReturnType<typeof invoke>;
    });

    // Should not throw despite pty_get_child_pid failure
    const pty = await spawnPty("cmd.exe", []);
    expect(pty.pid).toBe(42);

    // No register_active_pid call should have been made (osPid is null)
    const registerCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "register_active_pid"
    );
    expect(registerCalls).toHaveLength(0);
  });

  it("kill() handles pty_kill failure gracefully", async () => {
    await expect(
      spawnAndKill({
        ...KILL_OVERRIDES,
        pty_kill: () => Promise.reject(new Error("already dead")),
      })
    ).resolves.toBeDefined();
  });

  it("kill() handles pty_destroy failure gracefully", async () => {
    await expect(
      spawnAndKill({
        ...KILL_OVERRIDES,
        pty_destroy: () => Promise.reject(new Error("already destroyed")),
      })
    ).resolves.toBeDefined();
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";

// perfTrace has module-level state (traces array). We re-import fresh each test
// by resetting the module registry.
let trace: typeof import("../perfTrace").trace;
let traceAsync: typeof import("../perfTrace").traceAsync;
let dumpTraces: typeof import("../perfTrace").dumpTraces;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("../perfTrace");
  trace = mod.trace;
  traceAsync = mod.traceAsync;
  dumpTraces = mod.dumpTraces;
});

describe("trace", () => {
  it("records a single event", () => {
    trace("app:init");
    const dump = dumpTraces();
    expect(dump).toContain("app:init");
  });

  it("records multiple events in order", () => {
    trace("first");
    trace("second");
    trace("third");
    const dump = dumpTraces();
    const lines = dump.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("first");
    expect(lines[1]).toContain("second");
    expect(lines[2]).toContain("third");
  });

  it("includes timestamp prefix", () => {
    trace("event");
    const dump = dumpTraces();
    // Format: +<number>ms  <event>
    expect(dump).toMatch(/^\+\d+ms\s+event$/);
  });

  it("timestamp is non-negative", () => {
    trace("event");
    const dump = dumpTraces();
    const match = dump.match(/^\+(\d+)ms/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(0);
  });
});

describe("traceAsync", () => {
  it("returns the resolved value", async () => {
    const result = await traceAsync("load", async () => 42);
    expect(result).toBe(42);
  });

  it("records start and done events", async () => {
    await traceAsync("load", async () => "ok");
    const dump = dumpTraces();
    const lines = dump.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("load [start]");
    expect(lines[1]).toContain("load [done]");
  });

  it("includes duration on done event", async () => {
    await traceAsync("slow-op", async () => {
      // Small delay to get a measurable duration
      await new Promise((r) => setTimeout(r, 10));
      return "done";
    });
    const dump = dumpTraces();
    const doneLine = dump.split("\n").find((l) => l.includes("[done]"));
    expect(doneLine).toBeDefined();
    // Format: +Nms  slow-op [done] (Nms)
    expect(doneLine).toMatch(/\(\d+ms\)$/);
  });

  it("records FAIL event on rejection", async () => {
    const err = new Error("boom");
    await expect(
      traceAsync("broken", async () => {
        throw err;
      }),
    ).rejects.toThrow("boom");

    const dump = dumpTraces();
    const lines = dump.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("broken [start]");
    expect(lines[1]).toContain("broken [FAIL]");
  });

  it("includes duration on FAIL event when measurable", async () => {
    await traceAsync("fail-op", async () => {
      await new Promise((r) => setTimeout(r, 10));
      throw new Error("fail");
    }).catch(() => {});

    const dump = dumpTraces();
    const failLine = dump.split("\n").find((l) => l.includes("[FAIL]"));
    expect(failLine).toBeDefined();
    // durationMs is non-zero after the delay, so duration suffix is present
    expect(failLine).toMatch(/\(\d+ms\)$/);
  });

  it("re-throws the original error", async () => {
    const original = new Error("original error");
    try {
      await traceAsync("err-op", async () => {
        throw original;
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBe(original);
    }
  });

  it("handles async functions that return immediately", async () => {
    const result = await traceAsync("instant", async () => "fast");
    expect(result).toBe("fast");
    const dump = dumpTraces();
    expect(dump).toContain("instant [start]");
    expect(dump).toContain("instant [done]");
  });

  it("omits duration suffix when rounded duration is 0", async () => {
    // When the async fn resolves instantly, Math.round can yield 0,
    // which is falsy — so the (Nms) suffix is omitted.
    await traceAsync("zero-dur", async () => {});
    const dump = dumpTraces();
    const doneLine = dump.split("\n").find((l) => l.includes("[done]"));
    expect(doneLine).toBeDefined();
    // Either no duration suffix (0ms case) or a valid duration suffix
    expect(doneLine).toMatch(/\[done\](\s\(\d+ms\))?$/);
  });
});

describe("dumpTraces", () => {
  it("returns empty string when no traces recorded", () => {
    expect(dumpTraces()).toBe("");
  });

  it("formats simple trace correctly", () => {
    trace("boot");
    const dump = dumpTraces();
    // Single line: +Nms  boot
    expect(dump).toMatch(/^\+\d+ms\s{2}boot$/);
  });

  it("formats trace with duration correctly", async () => {
    await traceAsync("op", async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    const dump = dumpTraces();
    const doneLine = dump.split("\n")[1];
    // +Nms  op [done] (Nms)
    expect(doneLine).toMatch(/^\+\d+ms\s{2}op \[done\] \(\d+ms\)$/);
  });

  it("separates entries with newlines", () => {
    trace("a");
    trace("b");
    trace("c");
    const dump = dumpTraces();
    const lines = dump.split("\n");
    expect(lines).toHaveLength(3);
  });

  it("timestamps are monotonically non-decreasing", async () => {
    trace("first");
    await new Promise((r) => setTimeout(r, 5));
    trace("second");
    const dump = dumpTraces();
    const timestamps = dump.split("\n").map((line) => {
      const match = line.match(/^\+(\d+)ms/);
      return match ? Number(match[1]) : -1;
    });
    expect(timestamps[1]).toBeGreaterThanOrEqual(timestamps[0]);
  });

  it("is idempotent — calling twice returns same result", () => {
    trace("event");
    const first = dumpTraces();
    const second = dumpTraces();
    expect(first).toBe(second);
  });
});

describe("globalThis.__perfDump", () => {
  it("is set on globalThis", () => {
    const fn = (globalThis as Record<string, unknown>).__perfDump;
    expect(fn).toBeTypeOf("function");
  });
});

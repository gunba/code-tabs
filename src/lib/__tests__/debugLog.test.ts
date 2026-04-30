import { describe, it, expect, beforeEach, vi } from "vitest";
import { dlog, getDebugLog, getDebugLogForSession, clearDebugLog, removeDebugLogSession, getDebugLogGeneration, subscribeDebugLog, setDebugCaptureEnabled, setDebugCaptureResolver, configureObservability, shouldRecordDebugLog } from "../debugLog";
import type { DebugLogEntry } from "../debugLog";

const MAX_BUFFER_ENTRIES = 3000;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(0)),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

describe("debugLog", () => {
  beforeEach(() => {
    clearDebugLog();
    configureObservability({
      observabilityEnabled: true,
      devtoolsEnabled: true,
      globalLogPath: null,
    });
    setDebugCaptureResolver(null);
    setDebugCaptureEnabled(true);
    vi.restoreAllMocks();
  });

  it("pushes structured entry to buffer", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    dlog("pty", "sess-1", "spawned pid=42");
    const buf = getDebugLog();
    expect(buf).toHaveLength(1);
    expect(buf[0].module).toBe("pty");
    expect(buf[0].sessionId).toBe("sess-1");
    expect(buf[0].message).toBe("spawned pid=42");
    expect(buf[0].level).toBe("LOG");
    expect(buf[0].ts).toBeGreaterThan(0);
    expect(buf[0].tsIso).toContain("T");
    expect(buf[0].source).toBe("frontend");
    expect(buf[0].event).toBe("message");
  });

  it("defaults level to LOG", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    dlog("test", null, "hello");
    expect(getDebugLog()[0].level).toBe("LOG");
  });

  it("preserves all four levels", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    dlog("m", null, "a", "DEBUG");
    dlog("m", null, "b", "LOG");
    dlog("m", null, "c", "WARN");
    dlog("m", null, "d", "ERR");
    const levels = getDebugLog().map((e) => e.level);
    expect(levels).toEqual(["DEBUG", "LOG", "WARN", "ERR"]);
  });

  it("preserves null sessionId", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    dlog("pty", null, "global event");
    expect(getDebugLog()[0].sessionId).toBeNull();
  });

  it("forwards LOG to console.log without mirroring DEBUG noise", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    dlog("pty", null, "hello");
    dlog("pty", null, "verbose", "DEBUG");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("[pty] hello");
    expect(getDebugLog().map((entry) => entry.message)).toEqual(["hello", "verbose"]);
  });

  it("forwards WARN to console.warn", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    dlog("inspector", "s1", "timeout", "WARN");
    expect(spy).toHaveBeenCalledWith("[inspector] timeout");
  });

  it("forwards ERR to console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    dlog("session", null, "failed", "ERR");
    expect(spy).toHaveBeenCalledWith("[session] failed");
  });

  it("evicts oldest entries at MAX_ENTRIES per session", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (let i = 0; i < MAX_BUFFER_ENTRIES + 1; i++) {
      dlog("m", "sess-a", `msg-${i}`);
    }
    const buf = getDebugLogForSession("sess-a");
    expect(buf).toHaveLength(MAX_BUFFER_ENTRIES);
    expect(buf[0].message).toBe("msg-1");
    expect(buf[buf.length - 1].message).toBe(`msg-${MAX_BUFFER_ENTRIES}`);
  });

  it("clearDebugLog empties all buffers", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    dlog("m", "a", "x");
    dlog("m", "b", "y");
    dlog("m", null, "z");
    clearDebugLog();
    expect(getDebugLog()).toHaveLength(0);
    expect(getDebugLogForSession("a")).toHaveLength(0);
    expect(getDebugLogForSession("b")).toHaveLength(0);
    expect(getDebugLogForSession(null)).toHaveLength(0);
  });

  it("exposes buffers on globalThis.__debugLogBuffers", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    dlog("m", "s1", "test");
    const global = (globalThis as Record<string, unknown>).__debugLogBuffers as Map<string, DebugLogEntry[]>;
    expect(global).toBeInstanceOf(Map);
    expect(global.get("s1")).toHaveLength(1);
    expect(global.get("s1")![0].message).toBe("test");
  });

  // --- Per-session isolation ---

  it("isolates entries by session", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    dlog("m", "a", "msg-a");
    dlog("m", "b", "msg-b");
    dlog("m", null, "msg-global");

    expect(getDebugLogForSession("a")).toHaveLength(1);
    expect(getDebugLogForSession("a")[0].message).toBe("msg-a");
    expect(getDebugLogForSession("b")).toHaveLength(1);
    expect(getDebugLogForSession("b")[0].message).toBe("msg-b");
    expect(getDebugLogForSession(null)).toHaveLength(1);
    expect(getDebugLogForSession(null)[0].message).toBe("msg-global");
    expect(getDebugLog()).toHaveLength(3);
  });

  it("per-session eviction does not affect other sessions", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // Fill session A past capacity
    for (let i = 0; i < MAX_BUFFER_ENTRIES + 1; i++) {
      dlog("m", "a", `a-${i}`);
    }
    // Session B has 1 entry
    dlog("m", "b", "b-only");

    expect(getDebugLogForSession("a")).toHaveLength(MAX_BUFFER_ENTRIES);
    expect(getDebugLogForSession("b")).toHaveLength(1);
    expect(getDebugLogForSession("b")[0].message).toBe("b-only");
  });

  it("removeDebugLogSession cleans up one session", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    dlog("m", "a", "x");
    dlog("m", "b", "y");
    removeDebugLogSession("a");
    expect(getDebugLogForSession("a")).toHaveLength(0);
    expect(getDebugLogForSession("b")).toHaveLength(1);
  });

  it("merged all view sorts by timestamp", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    now = 1000; dlog("m", "a", "first");
    now = 3000; dlog("m", "b", "third");
    now = 2000; dlog("m", "a", "second");

    const all = getDebugLog();
    expect(all.map((e) => e.message)).toEqual(["first", "second", "third"]);
  });

  it("generation counter increments across sessions", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const g0 = getDebugLogGeneration();
    dlog("m", "a", "x");
    expect(getDebugLogGeneration()).toBe(g0 + 1);
    dlog("m", "b", "y");
    expect(getDebugLogGeneration()).toBe(g0 + 2);
  });

  it("notifies subscribers when the buffer generation changes", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const listener = vi.fn();
    const unsubscribe = subscribeDebugLog(listener);

    dlog("m", "a", "x");
    expect(listener).toHaveBeenCalledTimes(1);

    removeDebugLogSession("a");
    expect(listener).toHaveBeenCalledTimes(2);

    clearDebugLog();
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    dlog("m", "b", "y");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  // --- Debug capture toggle ---

  it("suppresses DEBUG entries when capture disabled", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    setDebugCaptureEnabled(false);
    dlog("m", null, "debug-msg", "DEBUG");
    expect(getDebugLog()).toHaveLength(0);
    // Non-DEBUG still captured
    dlog("m", null, "log-msg", "LOG");
    expect(getDebugLog()).toHaveLength(1);
  });

  it("suppresses console output for DEBUG when capture disabled", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    setDebugCaptureEnabled(false);
    dlog("m", null, "x", "DEBUG");
    expect(spy).not.toHaveBeenCalled();
  });

  it("re-enables DEBUG capture when toggled back on", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    setDebugCaptureEnabled(false);
    dlog("m", null, "hidden", "DEBUG");
    setDebugCaptureEnabled(true);
    dlog("m", null, "visible", "DEBUG");
    expect(getDebugLog()).toHaveLength(1);
    expect(getDebugLog()[0].message).toBe("visible");
  });

  it("can scope DEBUG capture by session", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    setDebugCaptureResolver((sessionId) => sessionId === "codex-session");
    dlog("m", "claude-session", "hidden", "DEBUG");
    dlog("m", "codex-session", "visible", "DEBUG");
    expect(getDebugLog()).toHaveLength(1);
    expect(getDebugLog()[0].sessionId).toBe("codex-session");
  });

  it("does not capture non-error logs when observability is disabled", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    configureObservability({
      observabilityEnabled: false,
      devtoolsEnabled: false,
      globalLogPath: null,
    });
    dlog("m", null, "hidden");
    expect(getDebugLog()).toHaveLength(0);
  });

  it("does not normalize dropped payloads", () => {
    configureObservability({
      observabilityEnabled: false,
      devtoolsEnabled: false,
      globalLogPath: null,
    });
    const data = {
      get expensive() {
        throw new Error("should not evaluate");
      },
    };
    expect(() => dlog("m", null, "hidden", "DEBUG", { data })).not.toThrow();
    expect(getDebugLog()).toHaveLength(0);
  });

  it("reports whether a log would be recorded", () => {
    expect(shouldRecordDebugLog("LOG", null)).toBe(true);
    setDebugCaptureResolver((sessionId) => sessionId === "s2");
    expect(shouldRecordDebugLog("DEBUG", "s1")).toBe(false);
    expect(shouldRecordDebugLog("DEBUG", "s2")).toBe(true);
  });
});

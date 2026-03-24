import { describe, it, expect, beforeEach, vi } from "vitest";
import { dlog, getDebugLog, clearDebugLog } from "../debugLog";
import type { DebugLogEntry } from "../debugLog";

describe("debugLog", () => {
  beforeEach(() => {
    clearDebugLog();
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

  it("forwards LOG and DEBUG to console.log", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    dlog("pty", null, "hello");
    dlog("pty", null, "verbose", "DEBUG");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith("[pty] hello");
    expect(spy).toHaveBeenCalledWith("[pty] verbose");
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

  it("evicts oldest entries at MAX_ENTRIES", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (let i = 0; i < 2001; i++) {
      dlog("m", null, `msg-${i}`);
    }
    const buf = getDebugLog();
    expect(buf).toHaveLength(2000);
    expect(buf[0].message).toBe("msg-1");
    expect(buf[buf.length - 1].message).toBe("msg-2000");
  });

  it("clearDebugLog empties the buffer", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    dlog("m", null, "a");
    dlog("m", null, "b");
    clearDebugLog();
    expect(getDebugLog()).toHaveLength(0);
  });

  it("exposes buffer on globalThis.__debugLogEntries", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    dlog("m", null, "test");
    const global = (globalThis as Record<string, unknown>).__debugLogEntries as DebugLogEntry[];
    expect(global).toHaveLength(1);
    expect(global[0].message).toBe("test");
  });
});

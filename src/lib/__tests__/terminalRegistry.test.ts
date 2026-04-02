import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerBufferReader,
  unregisterBufferReader,
  getSessionTranscript,
  registerTailReader,
  unregisterTailReader,
  getSessionBufferTail,
  registerTerminal,
  unregisterTerminal,
  highlightMatch,
  clearHighlight,
  registerScrollToLine,
  unregisterScrollToLine,
  scrollSessionToLine,
} from "../terminalRegistry";

// ── Minimal Terminal mock ──

function mockTerminal() {
  return {
    select: vi.fn(),
    clearSelection: vi.fn(),
  } as unknown as import("@xterm/xterm").Terminal;
}

// ── Tests ──

describe("terminalRegistry", () => {
  const SID = "test-session";
  const SID2 = "test-session-2";

  beforeEach(() => {
    unregisterBufferReader(SID);
    unregisterBufferReader(SID2);
    unregisterTailReader(SID);
    unregisterTailReader(SID2);
    unregisterTerminal(SID);
    unregisterTerminal(SID2);
    unregisterScrollToLine(SID);
    unregisterScrollToLine(SID2);
  });

  // ── Buffer reader ──

  describe("bufferReader", () => {
    it("returns null for unregistered session", () => {
      expect(getSessionTranscript("nonexistent")).toBeNull();
    });

    it("returns transcript from registered reader", () => {
      registerBufferReader(SID, () => "line1\nline2");
      expect(getSessionTranscript(SID)).toBe("line1\nline2");
    });

    it("returns null after unregistering", () => {
      registerBufferReader(SID, () => "data");
      unregisterBufferReader(SID);
      expect(getSessionTranscript(SID)).toBeNull();
    });

    it("does not affect other sessions", () => {
      registerBufferReader(SID, () => "session-1-data");
      registerBufferReader(SID2, () => "session-2-data");
      expect(getSessionTranscript(SID)).toBe("session-1-data");
      expect(getSessionTranscript(SID2)).toBe("session-2-data");
    });

    it("overwrites reader on re-registration", () => {
      registerBufferReader(SID, () => "old");
      registerBufferReader(SID, () => "new");
      expect(getSessionTranscript(SID)).toBe("new");
    });

    it("unregistering a non-existent session does not throw", () => {
      expect(() => unregisterBufferReader("nonexistent")).not.toThrow();
    });
  });

  // ── Tail reader ──

  describe("tailReader", () => {
    it("returns null for unregistered session", () => {
      expect(getSessionBufferTail("nonexistent", 10)).toBeNull();
    });

    it("returns tail from registered reader", () => {
      registerTailReader(SID, (n) => `last ${n} lines`);
      expect(getSessionBufferTail(SID, 5)).toBe("last 5 lines");
    });

    it("passes line count through to reader function", () => {
      const reader = vi.fn().mockReturnValue("data");
      registerTailReader(SID, reader);
      getSessionBufferTail(SID, 42);
      expect(reader).toHaveBeenCalledWith(42);
    });

    it("returns null after unregistering", () => {
      registerTailReader(SID, () => "data");
      unregisterTailReader(SID);
      expect(getSessionBufferTail(SID, 10)).toBeNull();
    });

    it("unregistering a non-existent session does not throw", () => {
      expect(() => unregisterTailReader("nonexistent")).not.toThrow();
    });
  });

  // ── Terminal (highlight/clearHighlight) ──

  describe("highlightMatch", () => {
    it("calls terminal.select with correct arguments", () => {
      const term = mockTerminal();
      registerTerminal(SID, term);
      highlightMatch(SID, 10, 5, 8);
      expect(term.select).toHaveBeenCalledWith(5, 10, 8);
    });

    it("is a no-op for unregistered session", () => {
      // Should not throw
      expect(() => highlightMatch("nonexistent", 0, 0, 5)).not.toThrow();
    });

    it("is a no-op after unregistering terminal", () => {
      const term = mockTerminal();
      registerTerminal(SID, term);
      unregisterTerminal(SID);
      highlightMatch(SID, 0, 0, 5);
      expect(term.select).not.toHaveBeenCalled();
    });
  });

  describe("clearHighlight", () => {
    it("calls terminal.clearSelection", () => {
      const term = mockTerminal();
      registerTerminal(SID, term);
      clearHighlight(SID);
      expect(term.clearSelection).toHaveBeenCalledOnce();
    });

    it("is a no-op for unregistered session", () => {
      expect(() => clearHighlight("nonexistent")).not.toThrow();
    });

    it("is a no-op after unregistering terminal", () => {
      const term = mockTerminal();
      registerTerminal(SID, term);
      unregisterTerminal(SID);
      clearHighlight(SID);
      expect(term.clearSelection).not.toHaveBeenCalled();
    });
  });

  describe("terminal registration", () => {
    it("overwrites terminal on re-registration", () => {
      const term1 = mockTerminal();
      const term2 = mockTerminal();
      registerTerminal(SID, term1);
      registerTerminal(SID, term2);
      highlightMatch(SID, 0, 0, 1);
      expect(term1.select).not.toHaveBeenCalled();
      expect(term2.select).toHaveBeenCalled();
    });

    it("unregistering a non-existent session does not throw", () => {
      expect(() => unregisterTerminal("nonexistent")).not.toThrow();
    });

    it("does not affect other sessions", () => {
      const term1 = mockTerminal();
      const term2 = mockTerminal();
      registerTerminal(SID, term1);
      registerTerminal(SID2, term2);
      highlightMatch(SID, 1, 2, 3);
      expect(term1.select).toHaveBeenCalled();
      expect(term2.select).not.toHaveBeenCalled();
    });
  });

  // ── Scroll to line ──

  describe("scrollSessionToLine", () => {
    it("calls registered scroll function with line number", () => {
      const scrollFn = vi.fn();
      registerScrollToLine(SID, scrollFn);
      scrollSessionToLine(SID, 42);
      expect(scrollFn).toHaveBeenCalledWith(42);
    });

    it("is a no-op for unregistered session", () => {
      expect(() => scrollSessionToLine("nonexistent", 0)).not.toThrow();
    });

    it("is a no-op after unregistering", () => {
      const scrollFn = vi.fn();
      registerScrollToLine(SID, scrollFn);
      unregisterScrollToLine(SID);
      scrollSessionToLine(SID, 10);
      expect(scrollFn).not.toHaveBeenCalled();
    });

    it("overwrites scroll function on re-registration", () => {
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      registerScrollToLine(SID, fn1);
      registerScrollToLine(SID, fn2);
      scrollSessionToLine(SID, 5);
      expect(fn1).not.toHaveBeenCalled();
      expect(fn2).toHaveBeenCalledWith(5);
    });

    it("unregistering a non-existent session does not throw", () => {
      expect(() => unregisterScrollToLine("nonexistent")).not.toThrow();
    });
  });
});

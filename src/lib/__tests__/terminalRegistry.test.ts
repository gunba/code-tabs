import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerBufferReader,
  unregisterBufferReader,
  getSessionTranscript,
  getSessionViewport,
  registerTerminal,
  focusTerminal,
  unregisterTerminal,
  waitForRender,
  isAltScreen,
  scrollBufferToText,
} from "../terminalRegistry";

// ── Minimal Terminal mock ──

function mockTerminal(altScreen = false) {
  const renderListeners: Array<(range: { start: number; end: number }) => void> = [];
  return {
    onRender: vi.fn((cb: (range: { start: number; end: number }) => void) => {
      renderListeners.push(cb);
      return { dispose: vi.fn(() => {
        const idx = renderListeners.indexOf(cb);
        if (idx >= 0) renderListeners.splice(idx, 1);
      }) };
    }),
    buffer: {
      active: { type: altScreen ? "alternate" : "normal" },
    },
    _fireRender: () => { renderListeners.forEach(cb => cb({ start: 0, end: 24 })); },
  } as unknown as import("@xterm/xterm").Terminal & { _fireRender: () => void };
}

/** Terminal mock with scrollable buffer lines for scrollBufferToText tests. */
function mockTerminalWithBuffer(lines: string[], rows = 24, viewportY = 0) {
  const scrollToLine = vi.fn();
  return {
    term: {
      rows,
      scrollToLine,
      buffer: {
        active: {
          type: "normal" as const,
          length: lines.length,
          viewportY,
          getLine: (i: number) =>
            i >= 0 && i < lines.length
              ? { translateToString: () => lines[i] }
              : null,
        },
      },
    } as unknown as import("@xterm/xterm").Terminal,
    scrollToLine,
  };
}

// ── Tests ──

describe("terminalRegistry", () => {
  const SID = "test-session";
  const SID2 = "test-session-2";

  beforeEach(() => {
    unregisterBufferReader(SID);
    unregisterBufferReader(SID2);
    unregisterTerminal(SID);
    unregisterTerminal(SID2);
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

  describe("viewport reader", () => {
    it("returns null for unregistered session", () => {
      expect(getSessionViewport("nonexistent")).toBeNull();
    });

    it("reads only visible viewport rows", () => {
      const { term } = mockTerminalWithBuffer([
        "line 0",
        "line 1",
        "line 2",
        "line 3",
      ], 2, 1);
      registerTerminal(SID, term);
      expect(getSessionViewport(SID)).toBe("line 1\nline 2");
    });
  });

  // ── Terminal registration ──

  describe("terminal registration", () => {
    it("overwrites terminal on re-registration", () => {
      const term1 = mockTerminal();
      const term2 = mockTerminal();
      registerTerminal(SID, term1);
      registerTerminal(SID, term2);
      // Verify the second terminal is active by checking isAltScreen
      expect(isAltScreen(SID)).toBe(false);
    });

    it("focuses a registered terminal", () => {
      const focus = vi.fn();
      const term = {
        ...mockTerminal(),
        focus,
      } as unknown as import("@xterm/xterm").Terminal;
      registerTerminal(SID, term);
      focusTerminal(SID);
      expect(focus).toHaveBeenCalledTimes(1);
    });

    it("focusing an unregistered terminal does not throw", () => {
      expect(() => focusTerminal("nonexistent")).not.toThrow();
    });

    it("unregistering a non-existent session does not throw", () => {
      expect(() => unregisterTerminal("nonexistent")).not.toThrow();
    });
  });

  // ── waitForRender ──

  describe("waitForRender", () => {
    it("resolves immediately for unregistered session", async () => {
      await waitForRender("nonexistent");
    });

    it("resolves when terminal fires onRender", async () => {
      const term = mockTerminal();
      registerTerminal(SID, term);
      const promise = waitForRender(SID);
      term._fireRender();
      await promise;
    });
  });

  // ── isAltScreen ──

  describe("isAltScreen", () => {
    it("returns false for unregistered session", () => {
      expect(isAltScreen("nonexistent")).toBe(false);
    });

    it("returns false for normal buffer", () => {
      registerTerminal(SID, mockTerminal(false));
      expect(isAltScreen(SID)).toBe(false);
    });

    it("returns true for alternate buffer", () => {
      registerTerminal(SID, mockTerminal(true));
      expect(isAltScreen(SID)).toBe(true);
    });
  });

  // ── scrollBufferToText ──

  describe("scrollBufferToText", () => {
    it("returns false for unregistered session", () => {
      expect(scrollBufferToText("nonexistent", "hello")).toBe(false);
    });

    it("returns false when target text is empty/whitespace", () => {
      const { term } = mockTerminalWithBuffer(["hello world"]);
      registerTerminal(SID, term);
      expect(scrollBufferToText(SID, "")).toBe(false);
      expect(scrollBufferToText(SID, "   ")).toBe(false);
    });

    it("returns false when text is not found", () => {
      const { term, scrollToLine } = mockTerminalWithBuffer([
        "line one",
        "line two",
        "line three",
      ]);
      registerTerminal(SID, term);
      expect(scrollBufferToText(SID, "not present")).toBe(false);
      expect(scrollToLine).not.toHaveBeenCalled();
    });

    it("finds a single-line match and scrolls to it", () => {
      const { term, scrollToLine } = mockTerminalWithBuffer([
        "first line",
        "the target text here",
        "third line",
      ], 24);
      registerTerminal(SID, term);
      expect(scrollBufferToText(SID, "target text")).toBe(true);
      // Offset = floor(24/3) = 8, line 1 - 8 = clamped to 0
      expect(scrollToLine).toHaveBeenCalledWith(0);
    });

    it("case-insensitive matching", () => {
      const { term, scrollToLine } = mockTerminalWithBuffer([
        "Hello World Target",
      ]);
      registerTerminal(SID, term);
      expect(scrollBufferToText(SID, "hello world target")).toBe(true);
      expect(scrollToLine).toHaveBeenCalled();
    });

    it("normalizes whitespace for matching", () => {
      const { term, scrollToLine } = mockTerminalWithBuffer([
        "foo   bar    baz",
      ]);
      registerTerminal(SID, term);
      expect(scrollBufferToText(SID, "foo bar baz")).toBe(true);
      expect(scrollToLine).toHaveBeenCalled();
    });

    it("finds match spanning two adjacent lines", () => {
      const { term, scrollToLine } = mockTerminalWithBuffer([
        "start of the",
        "target phrase here",
        "unrelated",
      ], 24);
      registerTerminal(SID, term);
      // "the target phrase" spans lines 0 and 1
      expect(scrollBufferToText(SID, "the target phrase")).toBe(true);
      // Should scroll to line 0 (clamped from 0 - 8)
      expect(scrollToLine).toHaveBeenCalledWith(0);
    });

    it("prefers last match (scans bottom-to-top)", () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
      lines[10] = "match here";
      lines[40] = "match here";
      const { term, scrollToLine } = mockTerminalWithBuffer(lines, 24);
      registerTerminal(SID, term);
      expect(scrollBufferToText(SID, "match here")).toBe(true);
      // Should find line 40 first (bottom-to-top), offset = floor(24/3) = 8
      expect(scrollToLine).toHaveBeenCalledWith(32);
    });

    it("offsets scroll so match appears 1/3 from top", () => {
      const lines = Array.from({ length: 100 }, (_, i) => `padding ${i}`);
      lines[60] = "the target";
      const { term, scrollToLine } = mockTerminalWithBuffer(lines, 30);
      registerTerminal(SID, term);
      expect(scrollBufferToText(SID, "the target")).toBe(true);
      // offset = floor(30/3) = 10, scroll to 60 - 10 = 50
      expect(scrollToLine).toHaveBeenCalledWith(50);
    });
  });
});

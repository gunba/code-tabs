import { describe, it, expect } from "vitest";
import { LineAccumulator } from "../inputAccumulator";

describe("LineAccumulator", () => {
  it("accumulates printable characters", () => {
    const acc = new LineAccumulator();
    expect(acc.feed("abc")).toEqual([]);
    expect(acc.current).toBe("abc");
  });

  it("emits line on Enter (\\r)", () => {
    const acc = new LineAccumulator();
    expect(acc.feed("hello\r")).toEqual(["hello"]);
    expect(acc.current).toBe("");
  });

  it("emits line on \\n", () => {
    const acc = new LineAccumulator();
    expect(acc.feed("hello\n")).toEqual(["hello"]);
  });

  it("handles backspace (\\x7f)", () => {
    const acc = new LineAccumulator();
    expect(acc.feed("ab\x7fc\r")).toEqual(["ac"]);
  });

  it("handles backspace (\\x08)", () => {
    const acc = new LineAccumulator();
    expect(acc.feed("ab\x08c\r")).toEqual(["ac"]);
  });

  it("handles backspace on empty buffer", () => {
    const acc = new LineAccumulator();
    expect(acc.feed("\x7f\x7f")).toEqual([]);
    expect(acc.current).toBe("");
  });

  it("handles Ctrl+U (clear)", () => {
    const acc = new LineAccumulator();
    expect(acc.feed("abc\x15def\r")).toEqual(["def"]);
  });

  it("handles Ctrl+C (clear)", () => {
    const acc = new LineAccumulator();
    expect(acc.feed("abc\x03def\r")).toEqual(["def"]);
  });

  it("handles bare Escape (clear)", () => {
    const acc = new LineAccumulator();
    expect(acc.feed("abc\x1bdef\r")).toEqual(["def"]);
  });

  it("skips CSI sequences and preserves buffer", () => {
    const acc = new LineAccumulator();
    // Arrow up: \x1b[A
    expect(acc.feed("ab\x1b[Ac\r")).toEqual(["abc"]);
  });

  it("skips CSI with parameters", () => {
    const acc = new LineAccumulator();
    // Ctrl+Right: \x1b[1;5C
    expect(acc.feed("ab\x1b[1;5Cc\r")).toEqual(["abc"]);
  });

  it("skips SS3 sequences", () => {
    const acc = new LineAccumulator();
    expect(acc.feed("ab\x1bOAc\r")).toEqual(["abc"]);
  });

  it("handles bracketed paste", () => {
    const acc = new LineAccumulator();
    expect(acc.feed("\x1b[200~/r\x1b[201~\r")).toEqual(["/r"]);
  });

  it("handles bracketed paste with newlines", () => {
    const acc = new LineAccumulator();
    const result = acc.feed("\x1b[200~line1\rline2\x1b[201~");
    expect(result).toEqual(["line1"]);
    expect(acc.current).toBe("line2");
  });

  it("handles multi-char write (CommandBar path)", () => {
    const acc = new LineAccumulator();
    expect(acc.feed("/r\r")).toEqual(["/r"]);
  });

  it("handles multiple lines in one feed", () => {
    const acc = new LineAccumulator();
    expect(acc.feed("a\rb\r")).toEqual(["a", "b"]);
  });

  it("ignores empty Enter (no empty strings emitted)", () => {
    const acc = new LineAccumulator();
    expect(acc.feed("\r")).toEqual([]);
    expect(acc.feed("\r\r\r")).toEqual([]);
  });

  it("resets buffer", () => {
    const acc = new LineAccumulator();
    acc.feed("abc");
    acc.reset();
    expect(acc.current).toBe("");
  });

  it("enforces 500 char safety cap", () => {
    const acc = new LineAccumulator();
    acc.feed("x".repeat(600));
    expect(acc.current.length).toBe(500);
  });

  it("ignores tab and other control chars", () => {
    const acc = new LineAccumulator();
    expect(acc.feed("a\tb\r")).toEqual(["ab"]);
  });

  it("handles type-only without Enter", () => {
    const acc = new LineAccumulator();
    expect(acc.feed("/r")).toEqual([]);
    expect(acc.current).toBe("/r");
  });

  it("accumulates across multiple feed calls", () => {
    const acc = new LineAccumulator();
    acc.feed("/");
    acc.feed("r");
    expect(acc.feed("\r")).toEqual(["/r"]);
  });

  it("handles slash command with arguments", () => {
    const acc = new LineAccumulator();
    expect(acc.feed("/r --verbose\r")).toEqual(["/r --verbose"]);
  });

  it("handles backspace mid-command", () => {
    const acc = new LineAccumulator();
    // Type /rx, backspace, then j → /rj
    expect(acc.feed("/rx\x7fj\r")).toEqual(["/rj"]);
  });

  it("handles multiple backspaces clearing partial input", () => {
    const acc = new LineAccumulator();
    expect(acc.feed("abc\x7f\x7f\x7f\r")).toEqual([]);
    // Buffer was fully cleared, Enter with empty buffer → no emission
  });

  it("handles Ctrl+C then new input", () => {
    const acc = new LineAccumulator();
    acc.feed("old stuff\x03");
    expect(acc.current).toBe("");
    expect(acc.feed("new\r")).toEqual(["new"]);
  });

  it("handles interleaved escape sequences and typing", () => {
    const acc = new LineAccumulator();
    // Type "he", arrow left, arrow right, type "llo"
    expect(acc.feed("he\x1b[D\x1b[Cllo\r")).toEqual(["hello"]);
  });
});

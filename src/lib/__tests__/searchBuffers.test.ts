import { describe, it, expect } from "vitest";
import { searchBuffers, validateRegex } from "../searchBuffers";

// ── searchBuffers ────────────────────────────────────────────────

describe("searchBuffers", () => {
  const sessions = [
    { id: "s1", text: "hello world\nfoo bar\nhello again" },
    { id: "s2", text: "another line\nhello there\nnothing" },
  ];

  it("returns empty for empty query", () => {
    expect(searchBuffers(sessions, "", false, false, 500)).toEqual([]);
  });

  it("finds literal matches across sessions", () => {
    const results = searchBuffers(sessions, "hello", false, false, 500);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ sessionId: "s1", lineIndex: 0, matchStart: 0 });
    expect(results[1]).toMatchObject({ sessionId: "s1", lineIndex: 2, matchStart: 0 });
    expect(results[2]).toMatchObject({ sessionId: "s2", lineIndex: 1, matchStart: 0 });
  });

  it("is case-insensitive by default", () => {
    const results = searchBuffers(sessions, "HELLO", false, false, 500);
    expect(results).toHaveLength(3);
  });

  it("respects case sensitivity", () => {
    const results = searchBuffers(sessions, "HELLO", true, false, 500);
    expect(results).toHaveLength(0);
  });

  it("supports regex mode", () => {
    const results = searchBuffers(sessions, "hel+o", false, true, 500);
    expect(results).toHaveLength(3);
  });

  it("returns empty for invalid regex", () => {
    const results = searchBuffers(sessions, "[invalid(", false, true, 500);
    expect(results).toEqual([]);
  });

  it("respects result limit", () => {
    const results = searchBuffers(sessions, "hello", false, false, 2);
    expect(results).toHaveLength(2);
  });

  it("includes matchLength for the matched text", () => {
    const results = searchBuffers(sessions, "bar", false, false, 500);
    expect(results).toHaveLength(1);
    expect(results[0].matchLength).toBe(3);
    expect(results[0].matchStart).toBe(4);
  });

  it("escapes regex special chars in literal mode", () => {
    const data = [{ id: "s1", text: "price is $5.00\nfoo" }];
    const results = searchBuffers(data, "$5.00", false, false, 500);
    expect(results).toHaveLength(1);
    expect(results[0].matchStart).toBe(9);
  });

  it("returns empty for no sessions", () => {
    expect(searchBuffers([], "hello", false, false, 500)).toEqual([]);
  });
});

// ── validateRegex ────────────────────────────────────────────────

describe("validateRegex", () => {
  it("returns null for valid pattern", () => {
    expect(validateRegex("hel+o")).toBeNull();
  });

  it("returns error message for invalid pattern", () => {
    const err = validateRegex("[invalid(");
    expect(err).toBeTypeOf("string");
    expect(err!.length).toBeGreaterThan(0);
  });

  it("returns null for empty pattern", () => {
    expect(validateRegex("")).toBeNull();
  });
});

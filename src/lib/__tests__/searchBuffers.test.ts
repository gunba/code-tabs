import { describe, expect, it } from "vitest";
import { buildTerminalSearchTargets, findSnippetHighlight, validateRegex } from "../searchBuffers";

describe("searchBuffers", () => {
  it("validates regex patterns", () => {
    expect(validateRegex("use.*less")).toBeNull();
    expect(validateRegex("(")).toContain("Invalid");
  });

  it("falls back to text lookup when offsets are stale byte offsets", () => {
    const highlight = findSnippetHighlight({
      snippet: "🙂 useless result",
      matchOffset: 6,
      matchLength: 7,
      query: "useless",
      caseSensitive: false,
      useRegex: false,
    });

    expect(highlight.before).toBe("🙂 ");
    expect(highlight.matched).toBe("useless");
    expect(highlight.after).toBe(" result");
  });

  it("builds contextual terminal search targets with short fallbacks", () => {
    const targets = buildTerminalSearchTargets({
      snippet: "before useless after",
      matchOffset: 7,
      matchLength: 7,
      matchedText: "useless",
      query: "useless",
      useRegex: false,
    });

    expect(targets[0]).toBe("before useless after");
    expect(targets).toContain("useless");
  });
});

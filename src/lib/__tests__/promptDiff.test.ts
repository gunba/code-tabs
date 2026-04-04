import { describe, it, expect } from "vitest";
import {
  escapeRegex,
  diffLines,
  generateRulesFromDiff,
  applyRulesToText,
  unescapeRegex,
  classifyRule,
} from "../promptDiff";
import type { SystemPromptRule } from "../../types/session";

// ── escapeRegex ─────────────────────────────────────────────────────

describe("escapeRegex", () => {
  it("escapes all regex metacharacters", () => {
    const metacharacters = ". * + ? ^ $ { } ( ) | [ ] \\";
    const escaped = escapeRegex(metacharacters);
    // Every metacharacter should be preceded by a backslash
    expect(escaped).toBe("\\. \\* \\+ \\? \\^ \\$ \\{ \\} \\( \\) \\| \\[ \\] \\\\");
    // Should match the original string literally
    const re = new RegExp(escaped);
    expect(re.test(metacharacters)).toBe(true);
  });

  it("leaves normal text unchanged", () => {
    expect(escapeRegex("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(escapeRegex("")).toBe("");
  });

  it("handles mixed text with metacharacters", () => {
    const input = "Price: $100.00 (USD)";
    const escaped = escapeRegex(input);
    const re = new RegExp(escaped);
    expect(re.test(input)).toBe(true);
    // Should not match a different string
    expect(re.test("Price: X100X00 XUSDX")).toBe(false);
  });
});

// ── diffLines ───────────────────────────────────────────────────────

describe("diffLines", () => {
  it("returns empty for two empty strings", () => {
    expect(diffLines("", "")).toEqual([]);
  });

  it("returns same lines for identical text", () => {
    const text = "line1\nline2\nline3";
    const result = diffLines(text, text);
    expect(result).toEqual([
      { type: "same", text: "line1" },
      { type: "same", text: "line2" },
      { type: "same", text: "line3" },
    ]);
  });

  it("detects pure additions", () => {
    const result = diffLines("a\nb", "a\nx\nb");
    expect(result).toEqual([
      { type: "same", text: "a" },
      { type: "add", text: "x" },
      { type: "same", text: "b" },
    ]);
  });

  it("detects pure deletions", () => {
    const result = diffLines("a\nx\nb", "a\nb");
    expect(result).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "x" },
      { type: "same", text: "b" },
    ]);
  });

  it("detects modifications", () => {
    const result = diffLines("a\nold\nb", "a\nnew\nb");
    expect(result).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "old" },
      { type: "add", text: "new" },
      { type: "same", text: "b" },
    ]);
  });

  it("handles multiline modification hunk", () => {
    const result = diffLines("a\nb\nc\nd", "a\nX\nY\nd");
    expect(result).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "b" },
      { type: "del", text: "c" },
      { type: "add", text: "X" },
      { type: "add", text: "Y" },
      { type: "same", text: "d" },
    ]);
  });

  it("handles completely different strings", () => {
    const result = diffLines("a\nb", "x\ny");
    // All old lines deleted, all new lines added
    for (const line of result) {
      expect(["add", "del"]).toContain(line.type);
    }
  });

  it("handles before empty, after non-empty", () => {
    const result = diffLines("", "x\ny");
    expect(result).toEqual([
      { type: "add", text: "x" },
      { type: "add", text: "y" },
    ]);
  });

  it("handles before non-empty, after empty", () => {
    const result = diffLines("x\ny", "");
    expect(result).toEqual([
      { type: "del", text: "x" },
      { type: "del", text: "y" },
    ]);
  });
});

// ── applyRulesToText ────────────────────────────────────────────────

describe("applyRulesToText", () => {
  it("returns original text when no rules", () => {
    expect(applyRulesToText("hello", [])).toBe("hello");
  });

  it("applies a simple replacement", () => {
    const rules: SystemPromptRule[] = [{
      id: "1", name: "test", pattern: "Claude", replacement: "Assistant",
      flags: "g", enabled: true,
    }];
    expect(applyRulesToText("You are Claude. Claude is helpful.", rules)).toBe(
      "You are Assistant. Assistant is helpful.",
    );
  });

  it("skips disabled rules", () => {
    const rules: SystemPromptRule[] = [{
      id: "1", name: "test", pattern: "Claude", replacement: "Assistant",
      flags: "g", enabled: false,
    }];
    expect(applyRulesToText("You are Claude.", rules)).toBe("You are Claude.");
  });

  it("skips empty patterns", () => {
    const rules: SystemPromptRule[] = [{
      id: "1", name: "test", pattern: "", replacement: "x",
      flags: "g", enabled: true,
    }];
    expect(applyRulesToText("hello", rules)).toBe("hello");
  });

  it("applies rules in order (chaining)", () => {
    const rules: SystemPromptRule[] = [
      { id: "1", name: "step1", pattern: "A", replacement: "B", flags: "g", enabled: true },
      { id: "2", name: "step2", pattern: "B", replacement: "C", flags: "g", enabled: true },
    ];
    expect(applyRulesToText("A", rules)).toBe("C");
  });

  it("handles case-insensitive flag", () => {
    const rules: SystemPromptRule[] = [{
      id: "1", name: "test", pattern: "claude", replacement: "X",
      flags: "gi", enabled: true,
    }];
    expect(applyRulesToText("Claude CLAUDE claude", rules)).toBe("X X X");
  });

  it("handles multiline flag", () => {
    const rules: SystemPromptRule[] = [{
      id: "1", name: "test", pattern: "^line", replacement: "row",
      flags: "gm", enabled: true,
    }];
    expect(applyRulesToText("line 1\nline 2", rules)).toBe("row 1\nrow 2");
  });

  it("handles dotall flag for multiline patterns", () => {
    const rules: SystemPromptRule[] = [{
      id: "1", name: "test", pattern: "start.*end", replacement: "REPLACED",
      flags: "gs", enabled: true,
    }];
    expect(applyRulesToText("start\nmiddle\nend", rules)).toBe("REPLACED");
  });

  it("skips invalid regex patterns", () => {
    const rules: SystemPromptRule[] = [{
      id: "1", name: "test", pattern: "[invalid", replacement: "x",
      flags: "g", enabled: true,
    }];
    // Should not throw, just skip
    expect(applyRulesToText("hello", rules)).toBe("hello");
  });

  it("supports capture group references", () => {
    const rules: SystemPromptRule[] = [{
      id: "1", name: "test", pattern: "(\\w+) (\\w+)", replacement: "$2 $1",
      flags: "g", enabled: true,
    }];
    expect(applyRulesToText("hello world", rules)).toBe("world hello");
  });

  it("always applies globally even without explicit g flag", () => {
    const rules: SystemPromptRule[] = [{
      id: "1", name: "test", pattern: "a", replacement: "b",
      flags: "", enabled: true,
    }];
    // 'g' is always prepended
    expect(applyRulesToText("aaa", rules)).toBe("bbb");
  });
});

// ── generateRulesFromDiff ───────────────────────────────────────────

describe("generateRulesFromDiff", () => {
  it("returns empty array for identical text", () => {
    expect(generateRulesFromDiff("hello", "hello", [])).toEqual([]);
  });

  it("generates deletion rule", () => {
    const rules = generateRulesFromDiff("a\nremove me\nb", "a\nb", []);
    expect(rules.length).toBe(1);
    expect(rules[0].replacement).toBe("");
    expect(rules[0].enabled).toBe(false);
    // Applying the rule should reproduce the edit
    const result = applyRulesToText("a\nremove me\nb", [{ ...rules[0], enabled: true }]);
    expect(result).toBe("a\nb");
  });

  it("generates modification rule", () => {
    const rules = generateRulesFromDiff("a\nold line\nb", "a\nnew line\nb", []);
    expect(rules.length).toBe(1);
    // Applying the rule should reproduce the edit
    const result = applyRulesToText("a\nold line\nb", [{ ...rules[0], enabled: true }]);
    expect(result).toBe("a\nnew line\nb");
  });

  it("generates addition rule with context anchor", () => {
    const rules = generateRulesFromDiff("a\nb", "a\nnew\nb", []);
    expect(rules.length).toBe(1);
    // Applying the rule should reproduce the edit
    const result = applyRulesToText("a\nb", [{ ...rules[0], enabled: true }]);
    expect(result).toBe("a\nnew\nb");
  });

  it("skips pure addition at start with no context", () => {
    const rules = generateRulesFromDiff("a", "new\na", []);
    // Pure addition at start has no preceding context — should be skipped
    // The diff sees "new" as added and "a" as same, with no preceding context
    expect(rules.length).toBe(0);
  });

  it("generates multiline deletion rule with s flag", () => {
    const rules = generateRulesFromDiff("a\nline1\nline2\nb", "a\nb", []);
    expect(rules.length).toBe(1);
    expect(rules[0].flags).toBe("gs");
    const result = applyRulesToText("a\nline1\nline2\nb", [{ ...rules[0], enabled: true }]);
    expect(result).toBe("a\nb");
  });

  it("deduplicates against existing rules", () => {
    const existing: SystemPromptRule[] = [{
      id: "1", name: "existing", pattern: escapeRegex("old"),
      replacement: "new", flags: "g", enabled: true,
    }];
    // Generate rule that would have the same pattern
    const rules = generateRulesFromDiff("a\nold\nb", "a\nnew\nb", existing);
    expect(rules.length).toBe(0);
  });

  it("generates rules that are disabled by default", () => {
    const rules = generateRulesFromDiff("old", "new", []);
    for (const rule of rules) {
      expect(rule.enabled).toBe(false);
    }
  });

  it("handles multiple hunks", () => {
    const original = "header\nold1\nmiddle\nold2\nfooter";
    const edited = "header\nnew1\nmiddle\nnew2\nfooter";
    const rules = generateRulesFromDiff(original, edited, []);
    expect(rules.length).toBe(2);
    // Applying both rules should reproduce the full edit
    const enabled = rules.map((r) => ({ ...r, enabled: true }));
    const result = applyRulesToText(original, enabled);
    expect(result).toBe(edited);
  });

  it("generates deletion rule at start without trailing newline", () => {
    const rules = generateRulesFromDiff("only line", "", []);
    expect(rules.length).toBe(1);
    const result = applyRulesToText("only line", [{ ...rules[0], enabled: true }]);
    expect(result).toBe("");
  });

  it("generates deletion rule at start with trailing content", () => {
    const rules = generateRulesFromDiff("remove me\nkeep", "keep", []);
    expect(rules.length).toBe(1);
    const result = applyRulesToText("remove me\nkeep", [{ ...rules[0], enabled: true }]);
    expect(result).toBe("keep");
  });

  it("end-to-end: generated rules transform original to edited", () => {
    const original = "You are Claude, an AI.\nBe helpful and honest.\nDo not lie.\nBe concise.";
    const edited = "You are Claude, an AI.\nBe helpful, honest, and safe.\nBe concise.";
    const rules = generateRulesFromDiff(original, edited, []);
    const enabled = rules.map((r) => ({ ...r, enabled: true }));
    const result = applyRulesToText(original, enabled);
    expect(result).toBe(edited);
  });
});

// ── Integration: escapeRegex round-trip ─────────────────────────────

describe("escapeRegex round-trip", () => {
  it("escaped text used as pattern matches the original", () => {
    const samples = [
      "hello (world)",
      "price: $99.99",
      "a[0] + b[1]",
      "regex: /^test$/gi",
      "path\\to\\file.txt",
      "question? answer!",
      "a|b|c",
      "{key: value}",
      "line1\nline2",
    ];
    for (const text of samples) {
      const pattern = escapeRegex(text);
      const re = new RegExp(pattern, "gs");
      expect(re.test(text)).toBe(true);
    }
  });
});

// ── unescapeRegex ──────────────────────────────────────────────────

describe("unescapeRegex", () => {
  it("reverses escapeRegex for all metacharacters", () => {
    expect(unescapeRegex("\\. \\* \\+ \\? \\^ \\$ \\{ \\} \\( \\) \\| \\[ \\] \\\\"))
      .toBe(". * + ? ^ $ { } ( ) | [ ] \\");
  });

  it("leaves non-metacharacter backslash sequences unchanged", () => {
    expect(unescapeRegex("\\n \\t \\d")).toBe("\\n \\t \\d");
  });

  it("round-trips with escapeRegex", () => {
    const samples = ["hello (world)", "price: $99.99", "a[0]+b[1]", "path\\to\\file"];
    for (const s of samples) {
      expect(unescapeRegex(escapeRegex(s))).toBe(s);
    }
  });

  it("handles empty string", () => {
    expect(unescapeRegex("")).toBe("");
  });
});

// ── classifyRule ───────────────────────────────────────────────────

describe("classifyRule", () => {
  it("classifies a generated remove-with-context rule", () => {
    const rule = generateRulesFromDiff("a\nremove me\nb", "a\nb", [])[0];
    const info = classifyRule(rule);
    expect(info.type).toBe("remove");
    expect(info.displayLeft).toBe("remove me");
    expect(info.displayRight).toBe("");
  });

  it("classifies a generated remove-at-start rule", () => {
    const rule = generateRulesFromDiff("remove me\nkeep", "keep", [])[0];
    const info = classifyRule(rule);
    expect(info.type).toBe("remove");
    expect(info.displayLeft).toBe("remove me");
  });

  it("classifies a generated add-after rule", () => {
    const rule = generateRulesFromDiff("a\nb", "a\nnew\nb", [])[0];
    const info = classifyRule(rule);
    expect(info.type).toBe("add");
    expect(info.displayLeft).toBe("a");
    expect(info.displayRight).toBe("new");
  });

  it("classifies add-after with metacharacter context", () => {
    const rule = generateRulesFromDiff("price: $100\nb", "price: $100\nnew\nb", [])[0];
    const info = classifyRule(rule);
    expect(info.type).toBe("add");
    expect(info.displayLeft).toBe("price: $100");
  });

  it("classifies a generated replace rule", () => {
    const rule = generateRulesFromDiff("a\nold\nb", "a\nnew\nb", [])[0];
    const info = classifyRule(rule);
    expect(info.type).toBe("replace");
    expect(info.displayLeft).toBe("old");
    expect(info.displayRight).toBe("new");
  });

  it("classifies a manual rule as replace", () => {
    const rule: SystemPromptRule = {
      id: "1", name: "custom", pattern: "Claude", replacement: "Assistant",
      flags: "g", enabled: true,
    };
    const info = classifyRule(rule);
    expect(info.type).toBe("replace");
    expect(info.displayLeft).toBe("Claude");
    expect(info.displayRight).toBe("Assistant");
  });

  it("classifies empty-pattern empty-replacement as remove", () => {
    const rule: SystemPromptRule = {
      id: "1", name: "x", pattern: "", replacement: "",
      flags: "g", enabled: false,
    };
    const info = classifyRule(rule);
    expect(info.type).toBe("remove");
    expect(info.displayLeft).toBe("");
  });

  it("classifies manual remove rule (non-empty pattern, empty replacement)", () => {
    const rule: SystemPromptRule = {
      id: "1", name: "strip warnings", pattern: "WARNING:.*",
      replacement: "", flags: "g", enabled: true,
    };
    const info = classifyRule(rule);
    expect(info.type).toBe("remove");
    expect(info.displayLeft).toBe("WARNING:.*");
  });
});

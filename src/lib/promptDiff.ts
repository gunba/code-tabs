// [CM-26] promptDiff: pure LCS-based line diff, regex escape, rule apply/generate for PromptsTab
import type { SystemPromptRule } from "../types/session";

// ── Types ───────────────────────────────────────────────────────────

export interface DiffLine {
  type: "same" | "add" | "del";
  text: string;
}

// ── Regex Escaping ──────────────────────────────────────────────────

/** Escape all regex metacharacters so the string matches literally. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Display helpers ─────────────────────────────────────────────────

/** Reverse escapeRegex — strip backslashes before regex metacharacters for display. */
export function unescapeRegex(pattern: string): string {
  return pattern.replace(/\\([.*+?^${}()|[\]\\])/g, "$1");
}

/** Strip newline anchors added by generateRulesFromDiff.
 *  Two shapes: "\n" + escaped (with context) vs escaped + "(?:\\n|$)" (start-of-text).
 *  Only strip leading \n when the suffix anchor is absent to avoid eating content. */
function stripAnchors(pattern: string): string {
  let p = pattern;
  if (p.endsWith("(?:\\n|$)")) {
    p = p.slice(0, -8);
  } else if (p.startsWith("\n")) {
    p = p.slice(1);
  }
  return p;
}

export interface RuleClassification {
  type: "remove" | "add" | "replace";
  displayLeft: string;
  displayRight: string;
}

/** Classify a rule by its data and return human-readable display text. */
export function classifyRule(rule: SystemPromptRule): RuleClassification {
  if (rule.replacement === "") {
    return {
      type: "remove",
      displayLeft: unescapeRegex(stripAnchors(rule.pattern)),
      displayRight: "",
    };
  }

  // Detect "Add after" shape: pattern = escapedContext + "\n"
  if (rule.pattern.endsWith("\n")) {
    const anchor = unescapeRegex(rule.pattern.slice(0, -1));
    if (rule.replacement.startsWith(anchor + "\n")) {
      let added = rule.replacement.slice(anchor.length + 1);
      if (added.endsWith("\n")) added = added.slice(0, -1);
      return { type: "add", displayLeft: anchor, displayRight: added };
    }
  }

  return {
    type: "replace",
    displayLeft: unescapeRegex(rule.pattern),
    displayRight: rule.replacement,
  };
}

// ── Line Diff (LCS-based) ──────────────────────────────────────────

/**
 * Compute a line-level diff between two strings.
 * Uses the longest common subsequence (LCS) algorithm.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  if (before === after) {
    return before === "" ? [] : before.split("\n").map((t) => ({ type: "same", text: t }));
  }

  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");

  // Build LCS table
  const m = a.length;
  const n = b.length;
  // Use Uint16Array for rows (supports up to 65535 lines)
  const dp: Uint16Array[] = [];
  for (let i = 0; i <= m; i++) dp.push(new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to produce diff
  const result: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.push({ type: "same", text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: "add", text: b[j - 1] });
      j--;
    } else {
      result.push({ type: "del", text: a[i - 1] });
      i--;
    }
  }

  result.reverse();
  return result;
}

// ── Apply Rules (mirrors Rust proxy.rs:579) ─────────────────────────

/**
 * Apply system prompt rules to text, matching the Rust proxy's behavior.
 * The `g` flag is always applied (Rust uses replace_all).
 * Other flags (i, m, s) are passed to the RegExp constructor.
 */
export function applyRulesToText(text: string, rules: SystemPromptRule[]): string {
  let result = text;
  for (const rule of rules) {
    if (!rule.enabled || !rule.pattern) continue;
    try {
      // Always include 'g' (matches Rust replace_all), plus any other flags
      const flags = rule.flags.includes("g") ? rule.flags : "g" + rule.flags;
      const re = new RegExp(rule.pattern, flags);
      result = result.replace(re, rule.replacement);
    } catch {
      // Skip invalid patterns (matches Rust's if let Ok(re) = ...)
    }
  }
  return result;
}

// ── Generate Rules from Diff ────────────────────────────────────────

interface Hunk {
  delLines: string[];
  addLines: string[];
  /** Line immediately before this hunk in the original (for anchoring pure additions) */
  precedingContext: string | null;
}

/** Group consecutive change lines from a diff into hunks. */
function groupHunks(diff: DiffLine[]): Hunk[] {
  const hunks: Hunk[] = [];
  let lastContext: string | null = null;
  let currentDel: string[] = [];
  let currentAdd: string[] = [];

  function flush() {
    if (currentDel.length > 0 || currentAdd.length > 0) {
      hunks.push({
        delLines: currentDel,
        addLines: currentAdd,
        precedingContext: lastContext,
      });
      currentDel = [];
      currentAdd = [];
    }
  }

  for (const line of diff) {
    if (line.type === "same") {
      flush();
      lastContext = line.text;
    } else if (line.type === "del") {
      currentDel.push(line.text);
    } else {
      currentAdd.push(line.text);
    }
  }
  flush();

  return hunks;
}

/**
 * Generate SystemPromptRules from the diff between original and edited text.
 * Deduplicates against existingRules by pattern.
 * Returns rules NOT yet committed — caller decides when to add them.
 */
export function generateRulesFromDiff(
  original: string,
  edited: string,
  existingRules: SystemPromptRule[],
): SystemPromptRule[] {
  if (original === edited) return [];

  const diff = diffLines(original, edited);
  const hunks = groupHunks(diff);
  const existingPatterns = new Set(existingRules.map((r) => r.pattern));
  const rules: SystemPromptRule[] = [];

  for (const hunk of hunks) {
    let pattern: string;
    let replacement: string;
    let name: string;

    if (hunk.delLines.length > 0 && hunk.addLines.length === 0) {
      // Pure deletion — include a surrounding newline to avoid leaving blank lines
      const deletedText = hunk.delLines.join("\n");
      if (hunk.precedingContext !== null) {
        // Preceding context exists: match \n + deleted text
        pattern = "\n" + escapeRegex(deletedText);
      } else {
        // At start of text: match deleted text + optional trailing newline
        pattern = escapeRegex(deletedText) + "(?:\\n|$)";
      }
      replacement = "";
      name = "Remove: " + hunk.delLines[0].slice(0, 40);
    } else if (hunk.delLines.length === 0 && hunk.addLines.length > 0) {
      // Pure addition — anchor to preceding context line
      if (hunk.precedingContext === null) {
        // No context available — skip this hunk
        continue;
      }
      const ctx = escapeRegex(hunk.precedingContext);
      pattern = ctx + "\n";
      replacement = hunk.precedingContext + "\n" + hunk.addLines.join("\n") + "\n";
      name = "Add after: " + hunk.precedingContext.slice(0, 30);
    } else {
      // Modification — old lines → new lines
      pattern = escapeRegex(hunk.delLines.join("\n"));
      replacement = hunk.addLines.join("\n");
      name = "Replace: " + hunk.delLines[0].slice(0, 40);
    }

    // Deduplicate
    if (existingPatterns.has(pattern)) continue;

    // Determine flags: add 's' (dotall) when pattern spans multiple lines
    const flags = pattern.includes("\n") ? "gs" : "g";

    // Validate pattern before adding
    try {
      new RegExp(pattern, flags);
    } catch {
      continue;
    }

    existingPatterns.add(pattern);
    rules.push({
      id: crypto.randomUUID(),
      name: name.length > 60 ? name.slice(0, 57) + "..." : name,
      pattern,
      replacement,
      flags,
      enabled: false,
    });
  }

  return rules;
}

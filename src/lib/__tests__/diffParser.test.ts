import { describe, it, expect } from "vitest";
import {
  parseUnifiedDiff,
  splitFilePath,
  toSideBySide,
} from "../diffParser";
import type { DiffHunk } from "../../types/git";

// ── parseUnifiedDiff ─────────────────────────────────────────────

describe("parseUnifiedDiff", () => {
  const sampleDiff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1234567..abcdef0 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -10,7 +10,8 @@ function main() {",
    "   const a = 1;",
    "-  const b = 2;",
    "+  const b = 3;",
    "+  const c = 4;",
    "   const d = 5;",
  ].join("\n");

  it("extracts file path", () => {
    const result = parseUnifiedDiff(sampleDiff);
    expect(result.path).toBe("src/app.ts");
    expect(result.oldPath).toBeNull();
  });

  it("parses hunk header", () => {
    const result = parseUnifiedDiff(sampleDiff);
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0].oldStart).toBe(10);
    expect(result.hunks[0].oldCount).toBe(7);
    expect(result.hunks[0].newStart).toBe(10);
    expect(result.hunks[0].newCount).toBe(8);
  });

  it("parses diff lines with correct kinds", () => {
    const result = parseUnifiedDiff(sampleDiff);
    const lines = result.hunks[0].lines;
    // [hunk-header, context, del, add, add, context]
    expect(lines[0].kind).toBe("hunk-header");
    expect(lines[1].kind).toBe("context");
    expect(lines[2].kind).toBe("del");
    expect(lines[3].kind).toBe("add");
    expect(lines[4].kind).toBe("add");
    expect(lines[5].kind).toBe("context");
  });

  it("computes line numbers correctly", () => {
    const result = parseUnifiedDiff(sampleDiff);
    const lines = result.hunks[0].lines;
    // Context line: old=10, new=10
    expect(lines[1].oldLine).toBe(10);
    expect(lines[1].newLine).toBe(10);
    // Del line: old=11, new=null
    expect(lines[2].oldLine).toBe(11);
    expect(lines[2].newLine).toBeNull();
    // Add lines: old=null, new=11,12
    expect(lines[3].oldLine).toBeNull();
    expect(lines[3].newLine).toBe(11);
    expect(lines[4].newLine).toBe(12);
    // Context: old=12, new=13
    expect(lines[5].oldLine).toBe(12);
    expect(lines[5].newLine).toBe(13);
  });

  it("detects binary files", () => {
    const bin = "diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n";
    const result = parseUnifiedDiff(bin);
    expect(result.isBinary).toBe(true);
    expect(result.hunks).toHaveLength(0);
  });

  it("detects new file", () => {
    const diff = "diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+line1\n+line2\n";
    const result = parseUnifiedDiff(diff);
    expect(result.isNew).toBe(true);
    expect(result.isDeleted).toBe(false);
  });

  it("detects deleted file", () => {
    const diff = "diff --git a/old.ts b/old.ts\ndeleted file mode 100644\n--- a/old.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-line1\n-line2\n";
    const result = parseUnifiedDiff(diff);
    expect(result.isDeleted).toBe(true);
    expect(result.isNew).toBe(false);
  });

  it("detects truncation marker", () => {
    const diff = sampleDiff + "\n[truncated]";
    const result = parseUnifiedDiff(diff);
    expect(result.truncated).toBe(true);
  });

  it("handles rename paths", () => {
    const diff = "diff --git a/old.ts b/new.ts\nindex 1234..5678 100644\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const result = parseUnifiedDiff(diff);
    expect(result.path).toBe("new.ts");
    expect(result.oldPath).toBe("old.ts");
  });

  it("parses multiple hunks", () => {
    const multi = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      "+B",
      " c",
      "@@ -10,3 +10,3 @@",
      " x",
      "-y",
      "+Y",
      " z",
    ].join("\n");
    const result = parseUnifiedDiff(multi);
    expect(result.hunks).toHaveLength(2);
    expect(result.hunks[0].oldStart).toBe(1);
    expect(result.hunks[1].oldStart).toBe(10);
  });

  it("handles empty diff", () => {
    const result = parseUnifiedDiff("");
    expect(result.hunks).toHaveLength(0);
    expect(result.path).toBe("");
    expect(result.isBinary).toBe(false);
    expect(result.isNew).toBe(false);
    expect(result.isDeleted).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("handles hunk header without count", () => {
    const diff = "diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const result = parseUnifiedDiff(diff);
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0].oldCount).toBe(1);
    expect(result.hunks[0].newCount).toBe(1);
  });

  it("skips no-newline-at-end-of-file marker", () => {
    const diff = "diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n";
    const result = parseUnifiedDiff(diff);
    const kinds = result.hunks[0].lines.map(l => l.kind);
    // hunk-header + del + add — the "\ No newline" line is skipped
    expect(kinds).toEqual(["hunk-header", "del", "add"]);
  });

  it("handles mode-change-only diff (no hunks)", () => {
    const diff = "diff --git a/f.sh b/f.sh\nold mode 100644\nnew mode 100755\n";
    const result = parseUnifiedDiff(diff);
    expect(result.hunks).toHaveLength(0);
    expect(result.isBinary).toBe(false);
    expect(result.path).toBe("f.sh");
  });
});

// ── splitFilePath ────────────────────────────────────────────────

describe("splitFilePath", () => {
  it("splits path into dir and name", () => {
    expect(splitFilePath("src/lib/app.ts")).toEqual({ dir: "src/lib/", name: "app.ts" });
  });

  it("handles file with no directory", () => {
    expect(splitFilePath("app.ts")).toEqual({ dir: "", name: "app.ts" });
  });

  it("handles backslashes", () => {
    expect(splitFilePath("src\\lib\\app.ts")).toEqual({ dir: "src\\lib\\", name: "app.ts" });
  });
});

// ── toSideBySide ────────────────────────────────────────────────

describe("toSideBySide", () => {
  function makeHunk(lines: DiffHunk["lines"]): DiffHunk {
    return { header: "@@ -1 +1 @@", oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines };
  }

  it("returns empty for no hunks", () => {
    expect(toSideBySide([])).toEqual([]);
  });

  it("converts hunk-header to separator", () => {
    const rows = toSideBySide([makeHunk([
      { kind: "hunk-header", content: "fn main()", oldLine: null, newLine: null },
    ])]);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("separator");
  });

  it("puts context lines on both sides", () => {
    const rows = toSideBySide([makeHunk([
      { kind: "hunk-header", content: "", oldLine: null, newLine: null },
      { kind: "context", content: "hello", oldLine: 1, newLine: 1 },
    ])]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      type: "paired",
      left: { lineNo: 1, content: "hello", kind: "context" },
      right: { lineNo: 1, content: "hello", kind: "context" },
    });
  });

  it("pairs consecutive del and add lines", () => {
    const rows = toSideBySide([makeHunk([
      { kind: "hunk-header", content: "", oldLine: null, newLine: null },
      { kind: "del", content: "old", oldLine: 1, newLine: null },
      { kind: "add", content: "new", oldLine: null, newLine: 1 },
    ])]);
    // separator + paired
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      type: "paired",
      left: { lineNo: 1, content: "old", kind: "del" },
      right: { lineNo: 1, content: "new", kind: "add" },
    });
  });

  it("handles more dels than adds", () => {
    const rows = toSideBySide([makeHunk([
      { kind: "hunk-header", content: "", oldLine: null, newLine: null },
      { kind: "del", content: "a", oldLine: 1, newLine: null },
      { kind: "del", content: "b", oldLine: 2, newLine: null },
      { kind: "del", content: "c", oldLine: 3, newLine: null },
      { kind: "add", content: "x", oldLine: null, newLine: 1 },
    ])]);
    // separator + 3 paired rows
    expect(rows).toHaveLength(4);
    expect(rows[1].left?.content).toBe("a");
    expect(rows[1].right?.content).toBe("x");
    expect(rows[2].left?.content).toBe("b");
    expect(rows[2].right).toBeNull();
    expect(rows[3].left?.content).toBe("c");
    expect(rows[3].right).toBeNull();
  });

  it("handles more adds than dels", () => {
    const rows = toSideBySide([makeHunk([
      { kind: "hunk-header", content: "", oldLine: null, newLine: null },
      { kind: "del", content: "old", oldLine: 1, newLine: null },
      { kind: "add", content: "new1", oldLine: null, newLine: 1 },
      { kind: "add", content: "new2", oldLine: null, newLine: 2 },
    ])]);
    expect(rows).toHaveLength(3);
    expect(rows[1].left?.content).toBe("old");
    expect(rows[1].right?.content).toBe("new1");
    expect(rows[2].left).toBeNull();
    expect(rows[2].right?.content).toBe("new2");
  });

  it("handles adds only (no dels)", () => {
    const rows = toSideBySide([makeHunk([
      { kind: "hunk-header", content: "", oldLine: null, newLine: null },
      { kind: "add", content: "line1", oldLine: null, newLine: 1 },
      { kind: "add", content: "line2", oldLine: null, newLine: 2 },
    ])]);
    expect(rows).toHaveLength(3);
    expect(rows[1].left).toBeNull();
    expect(rows[1].right?.content).toBe("line1");
    expect(rows[2].left).toBeNull();
    expect(rows[2].right?.content).toBe("line2");
  });

  it("handles dels only (no adds)", () => {
    const rows = toSideBySide([makeHunk([
      { kind: "hunk-header", content: "", oldLine: null, newLine: null },
      { kind: "del", content: "gone1", oldLine: 1, newLine: null },
      { kind: "del", content: "gone2", oldLine: 2, newLine: null },
    ])]);
    expect(rows).toHaveLength(3);
    expect(rows[1].left?.content).toBe("gone1");
    expect(rows[1].right).toBeNull();
    expect(rows[2].left?.content).toBe("gone2");
    expect(rows[2].right).toBeNull();
  });

  it("handles mixed context, del, add sequence", () => {
    const rows = toSideBySide([makeHunk([
      { kind: "hunk-header", content: "", oldLine: null, newLine: null },
      { kind: "context", content: "before", oldLine: 1, newLine: 1 },
      { kind: "del", content: "old", oldLine: 2, newLine: null },
      { kind: "add", content: "new", oldLine: null, newLine: 2 },
      { kind: "context", content: "after", oldLine: 3, newLine: 3 },
    ])]);
    expect(rows).toHaveLength(4); // separator + context + paired + context
    expect(rows[1].left?.kind).toBe("context");
    expect(rows[2].left?.kind).toBe("del");
    expect(rows[2].right?.kind).toBe("add");
    expect(rows[3].left?.kind).toBe("context");
  });

  it("adds separator between multiple hunks", () => {
    const hunk1 = makeHunk([
      { kind: "hunk-header", content: "", oldLine: null, newLine: null },
      { kind: "context", content: "a", oldLine: 1, newLine: 1 },
    ]);
    const hunk2 = makeHunk([
      { kind: "hunk-header", content: "", oldLine: null, newLine: null },
      { kind: "context", content: "b", oldLine: 10, newLine: 12 },
    ]);
    const rows = toSideBySide([hunk1, hunk2]);
    // hunk1: separator + context, hunk2: separator + context
    expect(rows).toHaveLength(4);
    expect(rows[0].type).toBe("separator");
    expect(rows[1].type).toBe("paired");
    expect(rows[2].type).toBe("separator");
    expect(rows[3].type).toBe("paired");
  });

  it("handles interleaved del/add groups separated by context", () => {
    const rows = toSideBySide([makeHunk([
      { kind: "hunk-header", content: "", oldLine: null, newLine: null },
      { kind: "context", content: "before", oldLine: 1, newLine: 1 },
      { kind: "del", content: "oldA", oldLine: 2, newLine: null },
      { kind: "add", content: "newA", oldLine: null, newLine: 2 },
      { kind: "context", content: "middle", oldLine: 3, newLine: 3 },
      { kind: "del", content: "oldB1", oldLine: 4, newLine: null },
      { kind: "del", content: "oldB2", oldLine: 5, newLine: null },
      { kind: "add", content: "newB", oldLine: null, newLine: 4 },
      { kind: "context", content: "after", oldLine: 6, newLine: 5 },
    ])]);
    // separator + before + paired(A) + middle + paired(B1) + paired(B2) + after
    expect(rows).toHaveLength(7);
    expect(rows[1].left?.kind).toBe("context");
    expect(rows[2].left?.content).toBe("oldA");
    expect(rows[2].right?.content).toBe("newA");
    expect(rows[3].left?.kind).toBe("context");
    expect(rows[4].left?.content).toBe("oldB1");
    expect(rows[4].right?.content).toBe("newB");
    expect(rows[5].left?.content).toBe("oldB2");
    expect(rows[5].right).toBeNull();
    expect(rows[6].left?.kind).toBe("context");
  });

  it("integration: parseUnifiedDiff output piped to toSideBySide", () => {
    const raw = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,5 +1,5 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "+const c = 4;",
      " const d = 5;",
    ].join("\n");
    const diff = parseUnifiedDiff(raw);
    const rows = toSideBySide(diff.hunks);
    // separator + context(a) + paired(b→b,c) + extra add(c) + context(d)
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].type).toBe("separator"); // hunk header
    expect(rows[1].type).toBe("paired");
    expect(rows[1].left?.content).toBe("const a = 1;");
    expect(rows[1].right?.content).toBe("const a = 1;");
    // del "const b = 2;" paired with add "const b = 3;"
    expect(rows[2].left?.content).toBe("const b = 2;");
    expect(rows[2].left?.kind).toBe("del");
    expect(rows[2].right?.content).toBe("const b = 3;");
    expect(rows[2].right?.kind).toBe("add");
    // extra add "const c = 4;" with no del pair
    expect(rows[3].left).toBeNull();
    expect(rows[3].right?.content).toBe("const c = 4;");
    // context "const d = 5;"
    expect(rows[4].left?.content).toBe("const d = 5;");
    expect(rows[4].right?.content).toBe("const d = 5;");
  });
});

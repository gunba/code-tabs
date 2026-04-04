import type { DiffHunk, FileDiff, SideBySideRow } from "../types/git";

// ── Unified diff parsing ─────────────────────────────────────────────────

export function parseUnifiedDiff(raw: string): FileDiff {
  const truncated = raw.endsWith("[truncated]");
  const isBinary = /^Binary files .+ differ$/m.test(raw);
  const isNew = /^new file mode/m.test(raw);
  const isDeleted = /^deleted file mode/m.test(raw);

  // Extract path from "diff --git a/... b/..." or "--- a/..." header
  let path = "";
  let oldPath: string | null = null;
  const gitLine = raw.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  if (gitLine) {
    oldPath = gitLine[1] !== gitLine[2] ? gitLine[1] : null;
    path = gitLine[2];
  }

  if (isBinary) {
    return { path, oldPath, isNew, isDeleted, isBinary: true, hunks: [], truncated };
  }

  const hunks: DiffHunk[] = [];
  const lines = raw.split("\n");
  let currentHunk: DiffHunk | null = null;
  let oldLineNo = 0;
  let newLineNo = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hunkMatch) {
      const oldStart = parseInt(hunkMatch[1], 10);
      const oldCount = parseInt(hunkMatch[2] ?? "1", 10);
      const newStart = parseInt(hunkMatch[3], 10);
      const newCount = parseInt(hunkMatch[4] ?? "1", 10);
      currentHunk = {
        header: line,
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: [{
          kind: "hunk-header",
          content: hunkMatch[5]?.trim() || line,
          oldLine: null,
          newLine: null,
        }],
      };
      oldLineNo = oldStart;
      newLineNo = newStart;
      hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({
        kind: "add",
        content: line.slice(1),
        oldLine: null,
        newLine: newLineNo++,
      });
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({
        kind: "del",
        content: line.slice(1),
        oldLine: oldLineNo++,
        newLine: null,
      });
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({
        kind: "context",
        content: line.slice(1),
        oldLine: oldLineNo++,
        newLine: newLineNo++,
      });
    }
    // Lines starting with \ (no newline at end of file) are skipped
  }

  return { path, oldPath, isNew, isDeleted, isBinary: false, hunks, truncated };
}

// ── Utility functions ────────────────────────────────────────────────────

export function splitFilePath(filePath: string): { dir: string; name: string } {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (lastSlash === -1) return { dir: "", name: filePath };
  return {
    dir: filePath.slice(0, lastSlash + 1),
    name: filePath.slice(lastSlash + 1),
  };
}

// ── Side-by-side diff transformation ────────────────────────────────

// [DF-10] toSideBySide: transforms unified DiffHunk[] into aligned SideBySideRow[] for dual-pane rendering
export function toSideBySide(hunks: DiffHunk[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];

  for (const hunk of hunks) {
    const { lines } = hunk;
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (line.kind === "hunk-header") {
        rows.push({ type: "separator", left: null, right: null });
        i++;
        continue;
      }

      if (line.kind === "context") {
        rows.push({
          type: "paired",
          left: { lineNo: line.oldLine!, content: line.content, kind: "context" },
          right: { lineNo: line.newLine!, content: line.content, kind: "context" },
        });
        i++;
        continue;
      }

      // Collect consecutive del lines
      const dels: typeof lines = [];
      while (i < lines.length && lines[i].kind === "del") {
        dels.push(lines[i]);
        i++;
      }

      // Collect consecutive add lines following dels
      const adds: typeof lines = [];
      while (i < lines.length && lines[i].kind === "add") {
        adds.push(lines[i]);
        i++;
      }

      // Pair dels and adds; overflow gets null on the other side
      const count = Math.max(dels.length, adds.length);
      for (let j = 0; j < count; j++) {
        const d = dels[j];
        const a = adds[j];
        rows.push({
          type: "paired",
          left: d ? { lineNo: d.oldLine!, content: d.content, kind: "del" } : null,
          right: a ? { lineNo: a.newLine!, content: a.content, kind: "add" } : null,
        });
      }
    }
  }

  return rows;
}

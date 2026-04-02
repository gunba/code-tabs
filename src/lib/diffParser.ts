import type { GitFileEntry, GitStatusCode, GitStatusData, DiffHunk, FileDiff, SideBySideRow } from "../types/git";

// ── Git status parsing ───────────────────────────────────────────────────

interface NumstatEntry {
  insertions: number;
  deletions: number;
}

function parseNumstat(raw: string): Map<string, NumstatEntry> {
  const map = new Map<string, NumstatEntry>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    // Format: "insertions\tdeletions\tpath" — binary files show "-\t-\tpath"
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const ins = parts[0] === "-" ? 0 : parseInt(parts[0], 10);
    const del = parts[1] === "-" ? 0 : parseInt(parts[1], 10);
    // Renames show as "path{old => new}" or "{old => new}path" or "old\tnew"
    const path = parts.slice(2).join("\t");
    map.set(path, { insertions: isNaN(ins) ? 0 : ins, deletions: isNaN(del) ? 0 : del });
  }
  return map;
}

function parseBranch(porcelain: string): string | null {
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("## ")) {
      // "## main...origin/main" or "## HEAD (no branch)" or "## main"
      const rest = line.slice(3);
      const dotIdx = rest.indexOf("...");
      return dotIdx >= 0 ? rest.slice(0, dotIdx) : rest;
    }
  }
  return null;
}

export function parseGitStatus(
  porcelain: string,
  numstat: string,
  numstatStaged: string,
): GitStatusData {
  const staged: GitFileEntry[] = [];
  const unstaged: GitFileEntry[] = [];
  const untracked: GitFileEntry[] = [];
  const branch = parseBranch(porcelain);

  const numstatMap = parseNumstat(numstat);
  const numstatStagedMap = parseNumstat(numstatStaged);

  let totalInsertions = 0;
  let totalDeletions = 0;

  for (const line of porcelain.split("\n")) {
    // Skip branch header and empty lines
    if (!line || line.startsWith("## ")) continue;
    if (line.length < 3) continue;

    const indexStatus = line[0];
    const workTreeStatus = line[1];
    const rawPath = line.slice(3);

    // Parse renames: "old -> new"
    const renameParts = rawPath.split(" -> ");
    const path = renameParts.length > 1 ? renameParts[1] : rawPath;
    const oldPath = renameParts.length > 1 ? renameParts[0] : null;

    // Untracked
    if (indexStatus === "?" && workTreeStatus === "?") {
      untracked.push({ path, status: "?", oldPath: null, insertions: 0, deletions: 0 });
      continue;
    }

    // Ignored
    if (indexStatus === "!" && workTreeStatus === "!") continue;

    // Staged changes (index status is not space or ?)
    if (indexStatus !== " " && indexStatus !== "?") {
      const stats = numstatStagedMap.get(path) ?? numstatStagedMap.get(rawPath);
      const entry: GitFileEntry = {
        path,
        status: indexStatus as GitStatusCode,
        oldPath,
        insertions: stats?.insertions ?? 0,
        deletions: stats?.deletions ?? 0,
      };
      staged.push(entry);
      totalInsertions += entry.insertions;
      totalDeletions += entry.deletions;
    }

    // Unstaged changes (worktree status is not space or ?)
    if (workTreeStatus !== " " && workTreeStatus !== "?") {
      const stats = numstatMap.get(path) ?? numstatMap.get(rawPath);
      const entry: GitFileEntry = {
        path,
        status: workTreeStatus as GitStatusCode,
        oldPath,
        insertions: stats?.insertions ?? 0,
        deletions: stats?.deletions ?? 0,
      };
      unstaged.push(entry);
      totalInsertions += entry.insertions;
      totalDeletions += entry.deletions;
    }
  }

  return { staged, unstaged, untracked, branch, totalInsertions, totalDeletions };
}

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

function fileKey(section: string, path: string): string {
  return `${section}:${path}`;
}

function buildPathSet(data: GitStatusData): Set<string> {
  const s = new Set<string>();
  for (const f of data.staged) s.add(fileKey("s", f.path));
  for (const f of data.unstaged) s.add(fileKey("u", f.path));
  for (const f of data.untracked) s.add(fileKey("t", f.path));
  return s;
}

export function detectChangedPaths(
  prev: GitStatusData | null,
  next: GitStatusData,
): Set<string> {
  if (!prev) return new Set();
  const prevSet = buildPathSet(prev);
  const nextSet = buildPathSet(next);
  const changed = new Set<string>();

  // New entries
  for (const key of nextSet) {
    if (!prevSet.has(key)) changed.add(key);
  }

  // Status changes within same section (e.g., file stats changed)
  const findByPath = (arr: GitFileEntry[], path: string) =>
    arr.find((f) => f.path === path);

  for (const f of next.staged) {
    const prev2 = findByPath(prev.staged, f.path);
    if (prev2 && (prev2.insertions !== f.insertions || prev2.deletions !== f.deletions)) {
      changed.add(fileKey("s", f.path));
    }
  }
  for (const f of next.unstaged) {
    const prev2 = findByPath(prev.unstaged, f.path);
    if (prev2 && (prev2.insertions !== f.insertions || prev2.deletions !== f.deletions)) {
      changed.add(fileKey("u", f.path));
    }
  }

  return changed;
}

const STATUS_LABELS: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  U: "Conflict",
  "?": "Untracked",
  "!": "Ignored",
};

export function statusLabel(code: string): string {
  return STATUS_LABELS[code] ?? code;
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

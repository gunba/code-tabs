// Git and diff rendering types

export type GitStatusCode = "M" | "A" | "D" | "R" | "C" | "U" | "?" | "!";

export interface GitFileEntry {
  path: string;
  status: GitStatusCode;
  oldPath: string | null;
  insertions: number;
  deletions: number;
}

export interface DiffLine {
  kind: "add" | "del" | "context" | "hunk-header";
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
  hunks: DiffHunk[];
  truncated: boolean;
}

export interface SideBySideRow {
  type: "paired" | "separator";
  left: { lineNo: number; content: string; kind: "del" | "context" } | null;
  right: { lineNo: number; content: string; kind: "add" | "context" } | null;
}

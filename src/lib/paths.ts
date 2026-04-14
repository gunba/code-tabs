/**
 * Unified path utilities for Claude Tabs.
 *
 * All path manipulation (normalization, display formatting, filter matching)
 * lives here. Mirrors the Rust-side path_utils.rs module.
 */

import type { Session } from "../types/session";

// Detect platform in both Tauri WebView (navigator) and Node/vitest (process)
export const IS_WINDOWS =
  ("process" in globalThis && ((globalThis as Record<string, unknown>).process as Record<string, string>)?.platform === "win32") ||
  (navigator?.platform?.startsWith("Win") ?? false);

export const IS_LINUX =
  ("process" in globalThis && ((globalThis as Record<string, unknown>).process as Record<string, string>)?.platform === "linux") ||
  (navigator?.platform?.startsWith("Linux") ?? false);

/** Normalize a path: consistent separators per platform, strip trailing. */
export function normalizePath(p: string): string {
  if (IS_WINDOWS) {
    return p.replace(/\//g, "\\").replace(/\\+$/, "");
  }
  return p.replace(/\/+$/, "");
}

/**
 * Canonicalize a path to a stable forward-slash form for identity comparisons.
 * Handles Windows backslashes, MSYS-style /c/Users/..., and drive letter casing.
 */
// [AP-01] Stable forward-slash identity form: backslashes, MSYS /c/..., drive letter casing
export function canonicalizePath(p: string): string {
  let result = p.replace(/\\/g, "/");
  // Convert MSYS-style /c/Users/... → C:/Users/...
  const msys = result.match(/^\/([a-zA-Z])(\/|$)/);
  if (msys) {
    result = msys[1].toUpperCase() + ":/" + result.slice(3);
  }
  // Normalize drive letter casing: c:/ → C:/
  if (/^[a-z]:\//.test(result)) {
    result = result[0].toUpperCase() + result.slice(1);
  }
  return result.replace(/\/+$/, "");
}

export interface WorktreeInfo {
  projectName: string;   // last component of project root (e.g., "claude_tabs")
  worktreeName: string;  // full slug (e.g., "sorted-marinating-dove")
  projectRoot: string;   // path before /.claude/worktrees/
}

/** Detect if a directory is a `.claude/worktrees/<name>` path and extract info. */
export function parseWorktreePath(dir: string): WorktreeInfo | null {
  const normalized = dir.replace(/\\/g, "/");
  const match = normalized.match(/^(.+)\/\.claude\/worktrees\/([^/]+)\/?$/);
  if (!match) return null;
  const projectRoot = match[1];
  const worktreeName = match[2];
  const projectName = projectRoot.split("/").filter(Boolean).pop() || projectRoot;
  return { projectName, worktreeName, projectRoot };
}

/** Acronym from hyphen-separated slug: "sorted-marinating-dove" → "SMD". */
export function worktreeAcronym(name: string): string {
  return name.split("-").map((s) => (s[0] || "").toUpperCase()).join("");
}

/** Derive a short tab name from the last component of a directory path. */
export function dirToTabName(dir: string): string {
  const wt = parseWorktreePath(dir);
  if (wt) return wt.projectName;
  const parts = dir.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || dir;
}

/** Abbreviate a full directory path for display: keep last two components. */
export function abbreviatePath(dir: string): string {
  const normalized = dir.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) return normalized;
  return `~/${parts.slice(-2).join("/")}`;
}

/**
 * Normalize a path or string for fuzzy filter matching.
 * Collapses all non-alphanumeric chars to hyphens and lowercases.
 *
 * This mirrors encode_dir's lossy encoding: "Jordan.Graham", "Jordan/Graham",
 * and "Jordan-Graham" all normalize to "jordan-graham", so filtering works
 * regardless of whether the path was decoded correctly.
 */
export function normalizeForFilter(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
}

/** Return the parent directory of a file path (everything before the last separator). */
export function parentDir(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash > 0 ? filePath.substring(0, lastSlash) : filePath;
}

/** Split a file path into directory prefix and basename, preserving separators. */
export function splitFilePath(filePath: string): { dir: string; name: string } {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (lastSlash === -1) return { dir: "", name: filePath };
  return {
    dir: filePath.slice(0, lastSlash + 1),
    name: filePath.slice(lastSlash + 1),
  };
}

export interface TabGroup {
  key: string;          // normalizePath(workingDir) — stable identity
  label: string;        // dirToTabName(workingDir)
  fullPath: string;     // effective dir (projectRoot for worktrees, original workingDir otherwise)
  sessions: Session[];  // ordered subset preserving relative order from flat array
}

/** [DF-09] Group sessions by normalized workingDir. Worktrees collapse into project root. O(n). */
export function groupSessionsByDir(sessions: Session[]): TabGroup[] {
  const map = new Map<string, TabGroup>();
  for (const s of sessions) {
    const wt = parseWorktreePath(s.config.workingDir);
    const effectiveDir = wt ? wt.projectRoot : s.config.workingDir;
    const key = normalizePath(effectiveDir);
    let group = map.get(key);
    if (!group) {
      group = { key, label: dirToTabName(effectiveDir), fullPath: effectiveDir, sessions: [] };
      map.set(key, group);
    }
    group.sessions.push(s);
  }
  return [...map.values()];
}

/** [DF-09] Swap a session with its neighbor within its group. Returns new ID order, or null at boundary. */
export function swapWithinGroup(
  allIds: string[],
  targetId: string,
  direction: "left" | "right",
  groups: TabGroup[]
): string[] | null {
  const group = groups.find((g) => g.sessions.some((s) => s.id === targetId));
  if (!group) return null;
  const idx = group.sessions.findIndex((s) => s.id === targetId);
  const neighborIdx = direction === "left" ? idx - 1 : idx + 1;
  if (neighborIdx < 0 || neighborIdx >= group.sessions.length) return null;
  const neighborId = group.sessions[neighborIdx].id;
  const result = [...allIds];
  const a = result.indexOf(targetId);
  const b = result.indexOf(neighborId);
  if (a < 0 || b < 0) return null;
  result[a] = neighborId;
  result[b] = targetId;
  return result;
}

/**
 * Format a scope path for display in the ConfigManager header.
 * Normalizes backslashes to forward slashes and abbreviates project paths.
 */
// [CM-02] Normalize backslashes, abbreviate project-scope paths; user-scope (~/) unchanged
/** [CI-02] Format a scope path for display. Normalizes backslashes and abbreviates project paths. */
export function formatScopePath(fullPath: string): string {
  const normalized = fullPath.replace(/\\/g, "/");
  // User-scope paths (~/...) pass through as-is
  if (normalized.startsWith("~/")) return normalized;
  // Abbreviate the directory prefix for project paths
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return normalized;
  const dir = normalized.slice(0, lastSlash);
  const file = normalized.slice(lastSlash); // includes leading /
  return abbreviatePath(dir) + file;
}

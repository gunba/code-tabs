/**
 * Unified path utilities for Claude Tabs.
 *
 * All path manipulation (normalization, display formatting, filter matching)
 * lives here. Mirrors the Rust-side path_utils.rs module.
 */

import type { Session } from "../types/session";

/** Normalize a Windows path: forward slashes to backslashes, strip trailing. */
export function normalizePath(p: string): string {
  return p.replace(/\//g, "\\").replace(/\\+$/, "");
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

export interface TabGroup {
  key: string;          // normalizePath(workingDir) — stable identity
  label: string;        // dirToTabName(workingDir)
  fullPath: string;     // original workingDir (for tooltip)
  sessions: Session[];  // ordered subset preserving relative order from flat array
}

/** Group sessions by normalized workingDir. Group order = first occurrence. */
export function groupSessionsByDir(sessions: Session[]): TabGroup[] {
  const map = new Map<string, TabGroup>();
  for (const s of sessions) {
    const key = normalizePath(s.config.workingDir);
    let group = map.get(key);
    if (!group) {
      group = { key, label: dirToTabName(s.config.workingDir), fullPath: s.config.workingDir, sessions: [] };
      map.set(key, group);
    }
    group.sessions.push(s);
  }
  return [...map.values()];
}

/** Swap a session with its neighbor within its group. Returns new ID order, or null at boundary. */
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

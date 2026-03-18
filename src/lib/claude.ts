import { invoke } from "@tauri-apps/api/core";
import type { Session, SessionConfig } from "../types/session";

export async function buildClaudeArgs(
  config: SessionConfig
): Promise<string[]> {
  return invoke<string[]>("build_claude_args", { config });
}

/** Resume target: chains through revivals to find the original CLI session ID. */
export function getResumeId(session: Session): string {
  return session.config.resumeSession || session.config.sessionId || session.id;
}

/** Derive a short tab name from the working directory */
export function dirToTabName(dir: string): string {
  const parts = dir.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || dir;
}

/** Model display label */
export function modelLabel(model: string | null): string {
  if (!model) return "Default";
  if (model.includes("opus")) return "Opus";
  if (model.includes("sonnet")) return "Sonnet";
  if (model.includes("haiku")) return "Haiku";
  return model;
}

/** Session colors — assigned sequentially, no collisions until wrap-around. */
export const SESSION_COLORS = [
  "#d4744a", // clay/orange (accent)
  "#6ea8e0", // blue (accent-secondary)
  "#bc8cff", // purple (accent-tertiary)
  "#5cb85c", // green (success)
  "#e08b67", // peach
  "#e06e9a", // pink
  "#7ecfcf", // teal
  "#c4b55a", // gold
];

/** Map of session ID → assigned color index. Stable across the session's lifetime. */
const colorAssignments = new Map<string, number>();
let nextColorIndex = 0;

/** Assign a color to a session. Picks the next sequential color, avoiding
 *  colors currently in use by other sessions when possible. */
export function assignSessionColor(sessionId: string, allSessionIds: string[]): void {
  if (colorAssignments.has(sessionId)) return;
  // Find colors currently in use
  const usedIndices = new Set<number>();
  for (const id of allSessionIds) {
    const idx = colorAssignments.get(id);
    if (idx !== undefined) usedIndices.add(idx);
  }
  // Try to find an unused color
  let assigned = nextColorIndex % SESSION_COLORS.length;
  for (let i = 0; i < SESSION_COLORS.length; i++) {
    const candidate = (nextColorIndex + i) % SESSION_COLORS.length;
    if (!usedIndices.has(candidate)) {
      assigned = candidate;
      break;
    }
  }
  colorAssignments.set(sessionId, assigned);
  nextColorIndex = (assigned + 1) % SESSION_COLORS.length;
}

/** Get the color for a session (must have been assigned first). Falls back to hash. */
export function sessionColor(sessionId: string): string {
  const idx = colorAssignments.get(sessionId);
  if (idx !== undefined) return SESSION_COLORS[idx];
  // Fallback for unassigned (e.g. activity feed entries from before assignment)
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = ((hash << 5) - hash + sessionId.charCodeAt(i)) | 0;
  }
  return SESSION_COLORS[Math.abs(hash) % SESSION_COLORS.length];
}

/** Remove a color assignment (frees the color for reuse). */
export function releaseSessionColor(sessionId: string): void {
  colorAssignments.delete(sessionId);
}

/** Get the saved color index for a session so it can be restored after close+create. */
export function getSessionColorIndex(sessionId: string): number {
  return colorAssignments.get(sessionId) ?? -1;
}

/** Force-assign a specific color index to a session. */
export function forceSessionColor(sessionId: string, colorIndex: number): void {
  colorAssignments.set(sessionId, colorIndex % SESSION_COLORS.length);
}

/** Format token count compactly: 0, 42, 2.3K, 36K, 1.2M */
export function formatTokenCount(n: number): string {
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Session, SessionConfig } from "../types/session";

// Re-export path utilities so existing imports from claude.ts keep working
export { dirToTabName } from "./paths";

export async function buildClaudeArgs(
  config: SessionConfig
): Promise<string[]> {
  return invoke<string[]>("build_claude_args", { config });
}

/** Resume target: chains through revivals to find the original CLI session ID. */
export function getResumeId(session: Session): string {
  return session.config.resumeSession || session.config.sessionId || session.id;
}

/** Whether a session has a conversation that can be resumed. */
export function canResumeSession(session: Session): boolean {
  return !!session.config.sessionId || !!session.config.resumeSession || !!session.metadata.nodeSummary;
}

/** Strip -w / --worktree from extra flags (used on resume to avoid creating a new worktree). */
export function stripWorktreeFlags(flags: string | null): string | null {
  if (!flags) return null;
  const stripped = flags.replace(/\s*--?w(?:orktree)?\b/g, "").trim();
  return stripped || null;
}

/** Effective model: user-configured model, falling back to runtime-detected model. */
export function effectiveModel(session: Session): string | null {
  return session.config.model || session.metadata.runtimeModel || null;
}

/** Known model families: keyword → display label + CSS color. */
const MODEL_FAMILIES: Array<{ keyword: string; label: string; color: string }> = [
  { keyword: "opus", label: "Opus", color: "#ff8000" },     // Legendary
  { keyword: "sonnet", label: "Sonnet", color: "#a335ee" },  // Epic
  { keyword: "haiku", label: "Haiku", color: "#4e9bff" },    // Rare
];

function resolveModelFamily(model: string | null): (typeof MODEL_FAMILIES)[number] | null {
  if (!model) return null;
  return MODEL_FAMILIES.find((f) => model.includes(f.keyword)) ?? null;
}

/** Model display label */
export function modelLabel(model: string | null): string {
  return resolveModelFamily(model)?.label ?? model ?? "Default";
}

/** CSS color for model name in tab metadata. */
export function modelColor(model: string | null): string {
  return resolveModelFamily(model)?.color ?? "var(--text-muted)";
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
  // Fallback for unassigned
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

/** Compute heat level (0–3) for command frequency visualization. */
export function computeHeatLevel(count: number, maxCount: number): 0 | 1 | 2 | 3 {
  if (count <= 0 || maxCount <= 0) return 0;
  const ratio = count / maxCount;
  if (ratio < 0.25) return 1;
  if (ratio < 0.70) return 2;
  return 3;
}

/** Inline styles for heat level — uses color-mix() for smooth gradient. */
export function getHeatStyle(level: 0 | 1 | 2 | 3): CSSProperties {
  switch (level) {
    case 1:
      return {
        color: "color-mix(in srgb, var(--accent) 30%, var(--text-muted))",
        borderColor: "var(--border)",
      };
    case 2:
      return {
        color: "color-mix(in srgb, var(--accent) 65%, var(--text-muted))",
        borderColor: "color-mix(in srgb, var(--accent) 40%, var(--border))",
      };
    case 3:
      return {
        color: "var(--accent)",
        borderColor: "color-mix(in srgb, var(--accent) 60%, var(--border))",
        background: "var(--accent-bg)",
      };
    default:
      return {};
  }
}

/** Format token count compactly: 0, 42, 2.3K, 36K, 1.2M */
export function formatTokenCount(n: number): string {
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

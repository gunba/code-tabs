import { invoke } from "@tauri-apps/api/core";
import type { Session, SessionConfig, SessionState, Subagent } from "../types/session";
import { isSessionIdle, isSubagentActive } from "../types/session";

// Re-export path utilities so existing imports from claude.ts keep working
export { dirToTabName } from "./paths";

export async function buildClaudeArgs(
  config: SessionConfig
): Promise<string[]> {
  return invoke<string[]>("build_claude_args", { config });
}

/** [RS-02] Resume target: chains through revivals to find the original CLI session ID. */
export function getResumeId(session: Session): string {
  return session.config.resumeSession || session.config.sessionId || session.id;
}

// [DS-03] canResumeSession: derived from sessionId, resumeSession, or nodeSummary (no JSONL check)
// [RS-03] Check conversation existence via nodeSummary || resumeSession (in-memory)
export function canResumeSession(session: Session): boolean {
  return !!session.config.sessionId || !!session.config.resumeSession || !!session.metadata.nodeSummary;
}

/** [DS-01] [DS-12] Find nearest non-dead tab from a given index. Falls back to any tab if all dead. */
export function findNearestLiveTab(sessions: Session[], fromIndex: number): string | null {
  // Pass 1: nearest non-dead tab
  for (let dist = 0; dist < sessions.length; dist++) {
    const right = fromIndex + dist;
    if (right < sessions.length && sessions[right].state !== "dead") return sessions[right].id;
    const left = fromIndex - dist - 1;
    if (left >= 0 && sessions[left].state !== "dead") return sessions[left].id;
  }
  // Pass 2: all dead — fall back to nearest regardless of state
  return sessions[fromIndex]?.id ?? sessions[fromIndex - 1]?.id ?? null;
}

/** [SR-08] Strip -w/--worktree from extraFlags on resume/respawn to avoid duplicate worktree. */
export function stripWorktreeFlags(flags: string | null): string | null {
  if (!flags) return null;
  const stripped = flags.replace(/\s*--?w(?:orktree)?\b/g, "").trim();
  return stripped || null;
}

/** Effective model: user-configured model, falling back to runtime-detected model. */
export function effectiveModel(session: Session): string | null {
  return session.config.model || session.metadata.runtimeModel || null;
}

/** Display-only: returns "toolUse" when session is idle but subagents are active. Not for PTY input gating. */
export function getEffectiveState(state: SessionState, subagents: Subagent[]): SessionState {
  if (isSessionIdle(state) && subagents.some(s => isSubagentActive(s.state))) return "toolUse";
  return state;
}

/** Known model families: keyword → display label + CSS color. */
export const MODEL_FAMILIES: Array<{ keyword: string; label: string; color: string }> = [
  { keyword: "opus", label: "Opus", color: "#ff8000" },     // Legendary
  { keyword: "sonnet", label: "Sonnet", color: "#a335ee" },  // Epic
  { keyword: "haiku", label: "Haiku", color: "#0070dd" },    // Rare
];

export function resolveModelFamily(model: string | null): (typeof MODEL_FAMILIES)[number] | null {
  if (!model) return null;
  return MODEL_FAMILIES.find((f) => model.includes(f.keyword)) ?? null;
}

/** Entry in the runtime model registry, populated from tap events. */
export interface ModelRegistryEntry {
  modelId: string;           // e.g. "claude-opus-4-6[1m]"
  family: string;            // e.g. "opus"
  contextWindowSize: number; // e.g. 1000000
  lastSeenAt: number;        // Date.now()
}

/** Resolve a model family + context variant to a CLI-compatible model string.
 *  For "200k": returns the short alias (CLI resolves to latest version).
 *  For "1m": looks up the registry for a confirmed full model ID with [1m] suffix.
 *  Falls back to the short alias if no registry entry exists (user gets 200k). */
export function resolveModelId(
  family: string,
  variant: "200k" | "1m",
  registry: ModelRegistryEntry[],
): string {
  if (variant === "200k") return family;
  const entry = registry.find(e => e.family === family && e.modelId.includes("[1m]"));
  if (entry) return entry.modelId;
  return family;
}

/** Extract the model family keyword from a full or short model string. */
export function extractModelFamily(model: string | null): string | null {
  return resolveModelFamily(model)?.keyword ?? null;
}

/** Whether a model string represents the 1M context variant. */
export function isModel1m(model: string | null): boolean {
  return !!model && model.includes("[1m]");
}

/** Model display label */
export function modelLabel(model: string | null): string {
  return resolveModelFamily(model)?.label ?? model ?? "Default";
}

/** CSS color for model name in tab metadata. */
export function modelColor(model: string | null): string {
  return resolveModelFamily(model)?.color ?? "var(--text-muted)";
}

/** CSS color for effort level (WoW rarity hierarchy). */
export function effortColor(effort: string | null): string {
  switch (effort) {
    case "high": return "var(--rarity-epic)";
    case "max": return "var(--rarity-legendary)";
    default: return "var(--text-muted)";
  }
}

/** Tool name → category color for tab activity display. */ // [TA-01]
export const TOOL_COLORS: Record<string, string> = {
  // Search / retrieval
  Grep: "var(--accent-secondary)", Glob: "var(--accent-secondary)", WebSearch: "var(--accent-secondary)", WebFetch: "var(--accent-secondary)",
  // File operations
  Read: "var(--accent)", Write: "var(--accent)", Edit: "var(--accent)", NotebookEdit: "var(--accent)",
  // Execution
  Bash: "var(--warning)",
  // Agent / skills
  Agent: "var(--accent-tertiary)", Skill: "var(--accent-tertiary)", RemoteTrigger: "var(--accent-tertiary)",
  // LSP
  LSP: "var(--text-secondary)",
  // Plan
  EnterPlanMode: "var(--accent-tertiary)", ExitPlanMode: "var(--accent-tertiary)",
  // User interaction
  AskUserQuestion: "var(--success)",
};

/** Color for a tool name. Falls back to muted for unknown/MCP tools. */
export function toolCategoryColor(toolName: string): string {
  return TOOL_COLORS[toolName] ?? "var(--text-muted)";
}

/** Event kind → color for tab activity display. */
export const EVENT_KIND_COLORS: Record<string, string> = {
  // Session lifecycle
  TurnStart: "var(--success)", TurnEnd: "var(--success)", SessionResume: "var(--success)", IdlePrompt: "var(--success)",
  // Thinking / planning
  ThinkingStart: "var(--accent-tertiary)", PlanModeEvent: "var(--accent-tertiary)", ModeChange: "var(--accent-tertiary)",
  // Text generation
  TextStart: "var(--text-secondary)", ConversationMessage: "var(--text-secondary)",
  // Tool execution
  ToolCallStart: "var(--accent-secondary)", ToolInput: "var(--accent-secondary)",
  // Tool results
  ToolResult: "var(--text-muted)",
  // Permission flow
  PermissionPromptShown: "var(--permission)", PermissionApproved: "var(--success)", PermissionRejected: "var(--error)",
  // User interaction
  UserInput: "var(--accent)", SlashCommand: "var(--accent)", UserInterruption: "var(--error)",
  // Errors
  ApiError: "var(--error)", ApiStreamError: "var(--error)",
  // Warnings / retries
  ApiRetry: "var(--warning)", StreamStall: "var(--warning)", RateLimit: "var(--warning)",
  // System / hooks
  HookProgress: "var(--text-muted)", HookTelemetry: "var(--text-muted)", SubprocessSpawn: "var(--text-muted)",
  // Agents / skills
  SubagentSpawn: "var(--accent-tertiary)", SubagentNotification: "var(--accent-tertiary)", SubagentLifecycle: "var(--accent-tertiary)", SkillInvocation: "var(--accent-tertiary)",
};

/** Color for an event kind. Falls back to muted for unknown kinds. */
export function eventKindColor(eventKind: string): string {
  return EVENT_KIND_COLORS[eventKind] ?? "var(--text-muted)";
}

/** Derive activity display from current event kind or tool name.
 *  Returns null when there is nothing to show. */
export function getActivityText(
  currentToolName: string | null,
  currentEventKind?: string | null,
): string | null {
  return currentEventKind ?? currentToolName ?? null;
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

/** [CB-12] Compute heat level (0-4) for command frequency (WoW rarity). Thresholds: 0.20, 0.50, 0.80. */
export function computeHeatLevel(count: number, maxCount: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || maxCount <= 0) return 0;
  const ratio = count / maxCount;
  if (ratio < 0.20) return 1;
  if (ratio < 0.50) return 2;
  if (ratio < 0.80) return 3;
  return 4;
}

/** [CB-10] CSS class for heat level -- green, blue, purple, orange (WoW rarity). */
export function heatClassName(level: 0 | 1 | 2 | 3 | 4): string {
  switch (level) {
    case 1: return "heat-1";
    case 2: return "heat-2";
    case 3: return "heat-3";
    case 4: return "heat-4";
    default: return "";
  }
}

/** Format token count compactly: 0, 42, 2.3K, 36K, 1.2M */
export function formatTokenCount(n: number): string {
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

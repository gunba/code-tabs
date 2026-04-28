import { invoke } from "@tauri-apps/api/core";
import type { PastSession, Session, SessionConfig, SessionState, Subagent } from "../types/session";
import { isSessionIdle, isSubagentActive } from "../types/session";
import { normalizePath } from "./paths";

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

/**
 * [RS-09] Auto-resolve a Claude resume id from on-disk JSONLs.
 *
 * Long-lived sessions sometimes report a sessionId via TAP that doesn't
 * match the JSONL filename Claude actually wrote — or a session crashed
 * before TAP captured anything, in which case `getResumeId` falls back
 * to the Code Tabs app id which is never a valid CLI session id. Either
 * way `claude --resume <bad-id>` fails silently.
 *
 * The picker side handles this by listing every JSONL on disk; we can
 * borrow that index. Filter to the dead tab's cwd, prefer an exact id
 * match, otherwise tie-break by the JSONL whose `lastModified` is
 * closest to the dead tab's `lastActive`. Returns null when no JSONL
 * exists in the cwd at all — caller should open the picker so the user
 * can choose manually.
 */
export function resolveResumeId(
  session: Session,
  pastSessions: PastSession[]
): string | null {
  const cwd = normalizePath(session.config.workingDir).toLowerCase();
  if (!cwd) return null;

  // Same-cwd, Claude-only candidates. Codex sessions live elsewhere on
  // disk and use a separate resume mechanism, so they shouldn't apply.
  const candidates = pastSessions.filter(
    (p) => normalizePath(p.directory).toLowerCase() === cwd && p.cli !== "codex"
  );
  if (candidates.length === 0) return null;

  // Fast path: stored id is a real JSONL in this cwd.
  const storedId = session.config.resumeSession || session.config.sessionId;
  if (storedId) {
    const exact = candidates.find((p) => p.id === storedId);
    if (exact) return exact.id;
  }

  if (candidates.length === 1) return candidates[0].id;

  // Multiple candidates — pick whichever JSONL was most recently active
  // around the dead tab's lastActive. Falls back to the first entry
  // (Rust returns them sorted by lastModified desc) when timestamps
  // are missing.
  const anchor = Date.parse(session.lastActive) || Date.parse(session.createdAt) || 0;
  if (!anchor) return candidates[0].id;

  let best = candidates[0];
  let bestDelta = Math.abs(Date.parse(best.lastModified) - anchor);
  if (!Number.isFinite(bestDelta)) bestDelta = Infinity;
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    const t = Date.parse(c.lastModified);
    if (!Number.isFinite(t)) continue;
    const delta = Math.abs(t - anchor);
    if (delta < bestDelta) {
      best = c;
      bestDelta = delta;
    }
  }
  return best.id;
}

// [DS-03] canResumeSession: resumable only with actual conversation evidence
// [RS-03] Check conversation existence via resumeSession || nodeSummary || assistantMessageCount
export function canResumeSession(session: Session): boolean {
  return !!session.config.resumeSession || !!session.metadata.nodeSummary || session.metadata.assistantMessageCount > 0;
}

export function getLaunchWorkingDir(session: Session): string {
  return session.config.launchWorkingDir || session.config.workingDir;
}

/** Find nearest non-dead tab from a given index. Returns null when no live tabs remain. */
export function findNearestLiveTab(sessions: Session[], fromIndex: number): string | null {
  for (let dist = 0; dist < sessions.length; dist++) {
    const right = fromIndex + dist;
    if (right < sessions.length && sessions[right].state !== "dead") return sessions[right].id;
    const left = fromIndex - dist - 1;
    if (left >= 0 && sessions[left].state !== "dead") return sessions[left].id;
  }
  return null;
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
  { keyword: "opus", label: "Opus", color: "var(--rarity-legendary)" },
  { keyword: "sonnet", label: "Sonnet", color: "var(--rarity-epic)" },
  { keyword: "haiku", label: "Haiku", color: "var(--rarity-rare)" },
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
    case "xhigh":
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
  // Agent / skills (tool execution → blue, not action-needed)
  Agent: "var(--accent-secondary)", Skill: "var(--accent-secondary)", RemoteTrigger: "var(--accent-secondary)",
  // LSP
  LSP: "var(--text-secondary)",
  // Plan / user-action-needed (these trigger actionNeeded state → purple)
  EnterPlanMode: "var(--accent-tertiary)", ExitPlanMode: "var(--accent-tertiary)",
  // User interaction (triggers actionNeeded state → purple)
  AskUserQuestion: "var(--accent-tertiary)",
};

/** Color for a tool name. Falls back to muted for unknown/MCP tools. */
export function toolCategoryColor(toolName: string): string {
  return TOOL_COLORS[toolName] ?? "var(--text-muted)";
}

/** Event kind → color for tab activity display. */
export const EVENT_KIND_COLORS: Record<string, string> = {
  // Session lifecycle
  TurnStart: "var(--success)", TurnEnd: "var(--success)", SessionResume: "var(--success)", IdlePrompt: "var(--success)",
  CodexTaskStarted: "var(--accent)", CodexTaskComplete: "var(--success)", CodexTurnContext: "var(--success)",
  // Thinking (matches thinking state → orange/clay)
  ThinkingStart: "var(--accent)",
  // Plan / mode (action-needed signal → purple)
  PlanModeEvent: "var(--accent-tertiary)", ModeChange: "var(--accent-tertiary)",
  // Text generation
  TextStart: "var(--text-secondary)", ConversationMessage: "var(--text-secondary)",
  // Tool execution
  ToolCallStart: "var(--accent-secondary)", ToolInput: "var(--accent-secondary)",
  // Tool results
  ToolResult: "var(--text-muted)", CodexToolCallComplete: "var(--text-muted)",
  // Accounting / context updates
  CodexTokenCount: "var(--text-muted)",
  // Permission flow
  PermissionPromptShown: "var(--accent-tertiary)", PermissionApproved: "var(--success)", PermissionRejected: "var(--error)",
  // User interaction
  UserInput: "var(--accent)", SlashCommand: "var(--accent)", UserInterruption: "var(--error)",
  // Errors
  ApiError: "var(--error)", ApiStreamError: "var(--error)",
  // Warnings / retries
  ApiRetry: "var(--warning)", StreamStall: "var(--warning)", RateLimit: "var(--warning)",
  // System / hooks
  HookProgress: "var(--text-muted)", HookTelemetry: "var(--text-muted)", SubprocessSpawn: "var(--text-muted)",
  // Agents / skills (tool execution → blue)
  SubagentSpawn: "var(--accent-secondary)", SubagentNotification: "var(--accent-secondary)", SubagentLifecycle: "var(--accent-secondary)", SkillInvocation: "var(--accent-secondary)",
};

/** Color for an event kind. Falls back to muted for unknown kinds. */
export function eventKindColor(eventKind: string): string {
  return EVENT_KIND_COLORS[eventKind] ?? "var(--text-muted)";
}

const EMPTY_NOISY_EVENT_KINDS: ReadonlySet<string> = new Set();

/** Derive activity display from current event kind or tool name.
 *  Returns null when there is nothing to show. */
export function getActivityText(
  currentToolName: string | null,
  currentEventKind?: string | null,
  noisyEventKinds: ReadonlySet<string> = EMPTY_NOISY_EVENT_KINDS,
): string | null {
  if (currentEventKind && !noisyEventKinds.has(currentEventKind)) return currentEventKind;
  return currentToolName ?? null;
}

/** Color matching getActivityText(): event phase first, tool category as fallback. */
export function getActivityColor(
  currentToolName: string | null,
  currentEventKind?: string | null,
  noisyEventKinds: ReadonlySet<string> = EMPTY_NOISY_EVENT_KINDS,
): string | null {
  if (currentEventKind && !noisyEventKinds.has(currentEventKind)) return eventKindColor(currentEventKind);
  if (currentToolName) return toolCategoryColor(currentToolName);
  return null;
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

export type HeatLevel = -1 | 0 | 1 | 2 | 3 | 4;

/** [CB-12] Compute heat level for command frequency (WoW rarity).
 * Rank-based quintiles over used commands; unused = poor/trash grey.
 *   count == 0           -> -1 (poor/grey)
 *   top 20% of used      -> 4 (legendary/orange)
 *   next 20%             -> 3 (epic/purple)
 *   next 20%             -> 2 (rare/blue)
 *   next 20%             -> 1 (uncommon/green)
 *   bottom 20%           -> 0 (common/white)
 * For totalUsed < 5 the quintile formula would collapse some tiers, so we
 * fall back to a direct rank-to-tier mapping that keeps tiers consecutive:
 * [4], [4,3], [4,3,2], [4,3,2,1], [4,3,2,1,0].
 * rank is 0-indexed from the top of the usage-sorted list (0 = most used).
 * totalUsed is the number of commands with count > 0.
 */
export function computeHeatLevel(count: number, rank: number, totalUsed: number): HeatLevel {
  if (count <= 0 || totalUsed <= 0) return -1;
  if (totalUsed <= 5) {
    const tier = 4 - rank;
    if (tier < 0) return 0;
    if (tier > 4) return 4;
    return tier as 0 | 1 | 2 | 3 | 4;
  }
  const bucket = Math.min(4, Math.floor((rank * 5) / totalUsed));
  return (4 - bucket) as 0 | 1 | 2 | 3 | 4;
}

/** [CB-10] CSS class for heat level -- grey, white, green, blue, purple, orange (WoW rarity). */
export function heatClassName(level: HeatLevel): string {
  if (level < 0) return "heat-unused";
  return `heat-${level}`;
}

/** Format token count compactly: 0, 42, 2.3K, 36K, 1.2M */
export function formatTokenCount(n: number): string {
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

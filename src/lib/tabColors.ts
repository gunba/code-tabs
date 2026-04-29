/** Tool name -> category color for tab activity display. */ // [TA-01]
export const TOOL_COLORS: Record<string, string> = {
  // Search / retrieval
  Grep: "var(--accent-secondary)", Glob: "var(--accent-secondary)", WebSearch: "var(--accent-secondary)", WebFetch: "var(--accent-secondary)",
  // File operations
  Read: "var(--accent)", Write: "var(--accent)", Edit: "var(--accent)", NotebookEdit: "var(--accent)",
  // Execution
  Bash: "var(--warning)",
  // Agent / skills (tool execution -> blue, not action-needed)
  Agent: "var(--accent-secondary)", Skill: "var(--accent-secondary)", RemoteTrigger: "var(--accent-secondary)",
  // LSP
  LSP: "var(--text-secondary)",
  // Plan / user-action-needed (these trigger actionNeeded state -> purple)
  EnterPlanMode: "var(--accent-tertiary)", ExitPlanMode: "var(--accent-tertiary)",
  // User interaction (triggers actionNeeded state -> purple)
  AskUserQuestion: "var(--accent-tertiary)",
};

/** Color for a tool name. Falls back to muted for unknown/MCP tools. */
export function toolCategoryColor(toolName: string): string {
  return TOOL_COLORS[toolName] ?? "var(--text-muted)";
}

/** Event kind -> color for tab activity display. */
export const EVENT_KIND_COLORS: Record<string, string> = {
  // Session lifecycle
  TurnStart: "var(--success)", TurnEnd: "var(--success)", SessionResume: "var(--success)", IdlePrompt: "var(--success)",
  CodexTaskStarted: "var(--accent)", CodexTaskComplete: "var(--success)", CodexTurnContext: "var(--success)",
  // Thinking (matches thinking state -> orange/clay)
  ThinkingStart: "var(--accent)",
  // Plan / mode (action-needed signal -> purple)
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
  // Agents / skills (tool execution -> blue)
  SubagentSpawn: "var(--accent-secondary)", SubagentNotification: "var(--accent-secondary)", SubagentLifecycle: "var(--accent-secondary)", SkillInvocation: "var(--accent-secondary)",
};

/** Color for an event kind. Falls back to muted for unknown kinds. */
export function eventKindColor(eventKind: string): string {
  return EVENT_KIND_COLORS[eventKind] ?? "var(--text-muted)";
}

const EMPTY_NOISY_EVENT_KINDS: ReadonlySet<string> = new Set();

/** Derive activity display from current event kind or tool name. */
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

/** Session colors assigned sequentially with no collisions until wrap-around. */
export const SESSION_COLORS = [
  "#d4744a",
  "#6ea8e0",
  "#bc8cff",
  "#5cb85c",
  "#e08b67",
  "#e06e9a",
  "#7ecfcf",
  "#c4b55a",
];

/** Map of session ID to assigned color index. Stable across the session's lifetime. */
const colorAssignments = new Map<string, number>();
let nextColorIndex = 0;

/** Assign a color to a session, avoiding colors currently in use when possible. */
export function assignSessionColor(sessionId: string, allSessionIds: string[]): void {
  if (colorAssignments.has(sessionId)) return;
  const usedIndices = new Set<number>();
  for (const id of allSessionIds) {
    const idx = colorAssignments.get(id);
    if (idx !== undefined) usedIndices.add(idx);
  }
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

/** Get the color for a session. Falls back to a stable hash when unassigned. */
export function sessionColor(sessionId: string): string {
  const idx = colorAssignments.get(sessionId);
  if (idx !== undefined) return SESSION_COLORS[idx];
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = ((hash << 5) - hash + sessionId.charCodeAt(i)) | 0;
  }
  return SESSION_COLORS[Math.abs(hash) % SESSION_COLORS.length];
}

/** Remove a color assignment, freeing the color for reuse. */
export function releaseSessionColor(sessionId: string): void {
  colorAssignments.delete(sessionId);
}

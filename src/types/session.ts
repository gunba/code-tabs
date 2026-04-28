// [DR-02] TypeScript types in src/types/ mirror Rust types using camelCase via serde rename_all="camelCase". This file is the canonical front-end shape for SessionState/SessionConfig/SessionMetadata.
export type SessionState =
  | "starting"
  | "idle"
  | "thinking"
  | "toolUse"
  | "actionNeeded"
  | "waitingPermission"
  | "error"
  | "interrupted"
  | "dead";

/** True if the session is idle or interrupted (functionally awaiting input). */
export function isSessionIdle(state: SessionState): boolean {
  return state === "idle" || state === "interrupted";
}

/** True if a subagent state indicates active work (not dead/idle/interrupted). */
export function isSubagentActive(state: SessionState): boolean {
  return state !== "dead" && state !== "idle" && state !== "interrupted";
}

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "dontAsk"
  | "planMode"
  | "auto";

/** Codex `--sandbox` enum (mirrors SandboxMode in codex_schema.json). */
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** Codex `--ask-for-approval` enum (mirrors AskForApproval in codex_schema.json,
 *  excluding deprecated `on-failure` and complex `granular`). */
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";

/** Which CLI a session runs. Per-session, no global mode. */
export type CliKind = "claude" | "codex";

export interface SessionConfig {
  workingDir: string;
  launchWorkingDir?: string;
  cli: CliKind;
  model: string | null;
  permissionMode: PermissionMode;
  /** Codex `--sandbox` selection. null = leave Codex default (workspace-write). Claude-only sessions ignore. */
  codexSandboxMode: CodexSandboxMode | null;
  /** Codex `--ask-for-approval` selection. null = leave Codex default (on-request). Claude-only sessions ignore. */
  codexApprovalPolicy: CodexApprovalPolicy | null;
  dangerouslySkipPermissions: boolean;
  systemPrompt: string | null;
  appendSystemPrompt: string | null;
  allowedTools: string[];
  disallowedTools: string[];
  additionalDirs: string[];
  mcpConfig: string | null;
  agent: string | null;
  effort: string | null;
  verbose: boolean;
  debug: boolean;
  maxBudget: number | null;
  resumeSession: string | null;
  forkSession: boolean;
  continueSession: boolean;
  projectDir: boolean;
  extraFlags: string | null;
  sessionId: string | null;
  runMode: boolean;
}

export interface SessionMetadata {
  costUsd: number;
  /** Raw token counts from last turn */
  contextDebug?: {
    inputTokens: number;
    cacheRead: number;
    cacheCreation: number;
    totalContextTokens: number;
    model: string | null;
    source: "statusLine" | "turnStart" | "codexTokenCount";
  } | null;
  durationSecs: number;
  currentAction: string | null;
  nodeSummary: string | null;
  currentToolName: string | null;
  currentEventKind: string | null;
  inputTokens: number;
  outputTokens: number;
  assistantMessageCount: number;
  choiceHint: boolean;
  runtimeModel: string | null;
  // Tap-derived enrichments
  apiRegion: string | null;
  lastRequestId: string | null;
  subscriptionType: string | null;
  hookStatus: string | null;
  lastTurnCostUsd: number;
  lastTurnTtftMs: number;
  systemPromptLength: number;
  toolCount: number;
  conversationLength: number;
  activeSubprocess: string | null;
  filesTouched: string[];
  rateLimitRemaining: string | null;
  rateLimitReset: string | null;
  apiLatencyMs: number;
  /** Network round-trip time in ms (EMA-smoothed, server processing subtracted) */
  pingRttMs: number;
  /** Server-side processing time in ms (EMA-smoothed, from x-envoy-upstream-service-time) */
  serverTimeMs: number;
  /** Output tokens per second (EMA-smoothed, from ApiTelemetry outputTokens/durationMs) */
  tokPerSec: number;
  // Unified rate limit data from API response headers
  fiveHourPercent: number | null;
  fiveHourResetsAt: number | null;
  sevenDayPercent: number | null;
  sevenDayResetsAt: number | null;
  // TAP pipeline expansion
  linesAdded: number;
  linesRemoved: number;
  lastToolDurationMs: number | null;
  lastToolResultSize: number | null;
  lastToolError: string | null;
  apiRetryCount: number;
  apiErrorStatus: number | null;
  apiRetryInfo: { attempt: number; delayMs: number; status: number } | null;
  stallDurationMs: number;
  stallCount: number;
  contextBudget: {
    claudeMdSize: number;
    totalContextSize: number;
    mcpToolsCount: number;
    mcpToolsTokens: number;
    nonMcpToolsCount: number;
    nonMcpToolsTokens: number;
    projectFileCount: number;
  } | null;
  hookTelemetry: {
    hookName: string;
    numCommands: number;
    numSuccess: number;
    numErrors: number;
    durationMs: number;
  } | null;
  planOutcome: string | null;
  effortLevel: string | null;
  capturedSystemPrompt: string | null;
  capturedSystemBlocks?: SystemPromptBlock[] | null;
  capturedMessages?: CapturedMessage[] | null;
  worktreeInfo: {
    originalCwd: string;
    worktreePath: string;
    worktreeName: string;
    worktreeBranch: string;
  } | null;
  /** User-authored scratchpad scoped to this session. Persists across app restarts via sessions.json. */
  notes?: string;
  // [SI-25] Flattened Status hook snapshot captured from the TAP pipeline.
  statusLine: {
    cliVersion: string;
    outputStyle: string;
    totalDurationMs: number;
    totalApiDurationMs: number;
    totalLinesAdded: number;
    totalLinesRemoved: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
    contextWindowSize: number;
    contextUsedPercent: number;
    contextRemainingPercent: number;
    exceeds200kTokens: boolean;
    currentInputTokens: number;
    currentOutputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    fiveHourUsedPercent: number;
    fiveHourResetsAt: number;
    sevenDayUsedPercent: number;
    sevenDayResetsAt: number;
    vimMode: string;
  } | null;
}

export interface Session {
  id: string;
  name: string;
  config: SessionConfig;
  state: SessionState;
  metadata: SessionMetadata;
  createdAt: string;
  lastActive: string;
  isMetaAgent?: boolean;
}

export interface LaunchPreset {
  id: string;
  name: string;
  config: Partial<SessionConfig>;
}

export interface SubagentMessage {
  role: "assistant" | "tool";
  text: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  timestamp: number;
}

export interface Subagent {
  id: string;           // agent-{hex}
  parentSessionId: string;
  state: SessionState;
  description: string;  // from Agent tool_use input.description
  tokenCount: number;
  currentAction: string | null;
  currentToolName: string | null;
  currentEventKind: string | null;
  messages: SubagentMessage[];
  createdAt: number;    // tap event ts when first seen (for chronological bar ordering)
  subagentType?: string;  // from Agent tool input (e.g., "Explore", "plan-critic")
  agentType?: string;     // from SubagentLifecycle telemetry
  isAsync?: boolean;
  totalToolUses?: number;
  durationMs?: number;
  model?: string;
  costUsd?: number;
  promptText?: string;    // full prompt text from SubagentSpawn event
  resultText?: string;    // final result from SubagentNotification summary
  completed?: boolean;    // true = finished successfully (vs dead = killed/errored)
}

export interface SkillInvocation {
  id: string;            // skill-{timestamp}
  skill: string;         // e.g. "keybindings-help"
  success: boolean;
  allowedTools: string[];
  timestamp: number;
}

export interface CommandHistoryEntry {
  cmd: string;    // normalized lowercase command (e.g. "/context")
  ts: number;     // tap event timestamp for chronological ordering
}

export interface PastSession {
  id: string;
  cli?: CliKind;
  path: string;
  directory: string;
  lastModified: string;
  sizeBytes: number;
  firstMessage: string;
  lastMessage: string;
  parentId: string | null;
  model: string;
  filePath: string;
  dirExists: boolean;
}

export interface ContentSearchMatch {
  sessionId: string;
  snippet: string;
}

// ── System-prompt rule (used by the slimmed proxy + PromptsTab) ────

export interface ProviderEffort {
  value: string;         // effort value sent to CLI (e.g., "low", "xhigh")
  label: string;         // display label (e.g., "Low", "xHigh")
}

export interface ProviderModel {
  id: string;
  label: string;
  family?: string;
  contextWindow?: number;
  color?: string;
}

export const ANTHROPIC_MODELS: ProviderModel[] = [
  { id: "best",       label: "best",       family: "opus",   contextWindow: 200000, color: "var(--rarity-legendary)" },
  { id: "opus",       label: "opus",       family: "opus",   contextWindow: 200000, color: "var(--rarity-legendary)" },
  { id: "opus[1m]",   label: "opus[1m]",   family: "opus",   contextWindow: 1000000, color: "var(--rarity-legendary)" },
  { id: "opusplan",   label: "opusplan",   family: "opus",   contextWindow: 200000, color: "var(--rarity-legendary)" },
  { id: "sonnet",     label: "sonnet",     family: "sonnet", contextWindow: 200000, color: "var(--rarity-epic)" },
  { id: "sonnet[1m]", label: "sonnet[1m]", family: "sonnet", contextWindow: 1000000, color: "var(--rarity-epic)" },
  { id: "haiku",      label: "haiku",      family: "haiku",  contextWindow: 200000, color: "var(--rarity-rare)" },
];

export const ANTHROPIC_EFFORTS: ProviderEffort[] = [
  { value: "low",    label: "low" },
  { value: "medium", label: "medium" },
  { value: "high",   label: "high" },
  { value: "xhigh",  label: "xhigh" },
  { value: "max",    label: "max" },
];

export const CODEX_SANDBOX_OPTIONS: Array<{ value: CodexSandboxMode; label: string }> = [
  { value: "read-only",          label: "Read Only" },
  { value: "workspace-write",    label: "Workspace" },
  { value: "danger-full-access", label: "Full Access" },
];

export const CODEX_APPROVAL_OPTIONS: Array<{ value: CodexApprovalPolicy; label: string }> = [
  { value: "untrusted",  label: "Untrusted" },
  { value: "on-request", label: "On Request" },
  { value: "never",      label: "Never" },
];

export interface SystemPromptBlock {
  text: string;
  cacheControl?: { type: string };
}

export interface CapturedContentBlock {
  type: string;            // text | tool_use | tool_result | image | reasoning | compaction_summary
  id?: string;             // tool_use id (for pairing with tool_result)
  text?: string;           // text, tool_result, compaction_summary
  name?: string;           // tool_use
  input?: unknown;         // tool_use (full input object)
  toolUseId?: string;      // tool_result
  isError?: boolean;       // tool_result
  mediaType?: string;      // image
  summary?: string[];      // reasoning: optional summary array (often empty)
}

export interface CapturedMessage {
  role: string;
  content: CapturedContentBlock[];
}

export interface SystemPromptRule {
  id: string;
  name: string;
  pattern: string;
  replacement: string;
  flags: string;
  enabled: boolean;
}

// ── Session Config ──────────────────────────────────────────────────

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  workingDir: "",
  launchWorkingDir: "",
  cli: "claude",
  model: null,
  permissionMode: "default",
  codexSandboxMode: null,
  codexApprovalPolicy: null,
  dangerouslySkipPermissions: false,
  systemPrompt: null,
  appendSystemPrompt: null,
  allowedTools: [],
  disallowedTools: [],
  additionalDirs: [],
  mcpConfig: null,
  agent: null,
  effort: null,
  verbose: false,
  debug: false,
  maxBudget: null,
  resumeSession: null,
  forkSession: false,
  continueSession: false,
  projectDir: false,
  extraFlags: null,
  sessionId: null,
  runMode: false,
};

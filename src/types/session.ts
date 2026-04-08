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

export interface SessionConfig {
  workingDir: string;
  model: string | null;
  permissionMode: PermissionMode;
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
  providerId: string | null;
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
    source: "statusLine" | "turnStart";
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

// ── Provider / Proxy types ──────────────────────────────────────────

export type ProviderKind = "anthropic_compatible" | "openai_codex";

export interface ModelMapping {
  id: string;
  pattern: string;       // glob pattern matching model name (e.g., "claude-haiku-*")
  rewriteModel?: string; // rewrite to this model name (undefined = keep original)
}

export interface ModelProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  predefined: boolean;
  modelMappings: ModelMapping[];

  // anthropic_compatible fields
  baseUrl?: string;
  apiKey?: string | null;
  socks5Proxy?: string | null;

  // openai_codex fields
  codexPrimaryModel?: string;
  codexSmallModel?: string;
}

export interface ProviderConfig {
  providers: ModelProvider[];
  defaultProviderId: string;
}

// [PR-02] Predefined OpenAI Codex provider maps Claude families onto
// primary/small Codex models and ships in the default provider config.
export const CODEX_PROVIDER: ModelProvider = {
  id: "openai-codex",
  name: "ChatGPT",
  kind: "openai_codex",
  predefined: true,
  codexPrimaryModel: "gpt-5.4",
  codexSmallModel: "gpt-5.4-mini",
  modelMappings: [
    { id: "codex-opus", pattern: "claude-opus-*", rewriteModel: "gpt-5.4" },
    { id: "codex-sonnet", pattern: "claude-sonnet-*", rewriteModel: "gpt-5.4" },
    { id: "codex-haiku", pattern: "claude-haiku-*", rewriteModel: "gpt-5.4-mini" },
    { id: "codex-catchall", pattern: "*", rewriteModel: "gpt-5.4" },
  ],
};

export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      kind: "anthropic_compatible",
      predefined: false,
      modelMappings: [],
      baseUrl: "https://api.anthropic.com",
      apiKey: null,
    },
    CODEX_PROVIDER,
  ],
  defaultProviderId: "anthropic",
};

export interface SystemPromptBlock {
  text: string;
  cacheControl?: { type: string };
}

export interface CapturedContentBlock {
  type: string;
  id?: string;             // tool_use id (for pairing with tool_result)
  text?: string;
  name?: string;           // tool_use
  input?: unknown;         // tool_use (full input object)
  toolUseId?: string;      // tool_result
  isError?: boolean;       // tool_result
  mediaType?: string;      // image
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
  model: null,
  permissionMode: "default",
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
  providerId: null,
};

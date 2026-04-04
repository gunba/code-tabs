import type { SystemPromptBlock, CapturedMessage } from "./session";

// ── Tap Entry (raw from hooked process) ──

export interface TapEntry {
  ts: number;
  cat: string;
  len?: number;
  snap?: string;
  [key: string]: unknown;
}

// ── Tap Event (classified, typed) ──

// Base fields shared by all events
interface TapEventBase {
  ts: number;
  kind: string;
  /** Source hook category (e.g. "parse", "stringify", "envproxy"). */
  cat?: string;
}

// ── Parse (SSE) events ──

export interface TurnStart extends TapEventBase {
  kind: "TurnStart";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface ThinkingStart extends TapEventBase {
  kind: "ThinkingStart";
  index: number;
}

export interface TextStart extends TapEventBase {
  kind: "TextStart";
  index: number;
}

export interface ToolCallStart extends TapEventBase {
  kind: "ToolCallStart";
  index: number;
  toolName: string;
  toolId: string;
}

export interface BlockStop extends TapEventBase {
  kind: "BlockStop";
  index: number;
}

export interface TurnEnd extends TapEventBase {
  kind: "TurnEnd";
  stopReason: string;
  outputTokens: number;
}

export interface MessageStop extends TapEventBase {
  kind: "MessageStop";
}

// ── Stringify (outgoing) events ──

export interface UserInput extends TapEventBase {
  kind: "UserInput";
  display: string;
  sessionId: string;
}

export interface ConversationMessage extends TapEventBase {
  kind: "ConversationMessage";
  messageType: "user" | "assistant" | "result";
  isSidechain: boolean;
  agentId: string | null;
  uuid: string | null;
  parentUuid: string | null;
  promptId: string | null;
  stopReason: string | null;
  toolNames: string[];
  toolAction: string | null;
  textSnippet: string | null;
  cwd: string | null;
  hasToolError: boolean;
  toolErrorText: string | null;
}

export interface ApiTelemetry extends TapEventBase {
  kind: "ApiTelemetry";
  model: string;
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  durationMs: number;
  ttftMs: number;
  queryChainId: string | null;
  queryDepth: number;
  stopReason: string | null;
}

export interface SubagentSpawn extends TapEventBase {
  kind: "SubagentSpawn";
  description: string;
  prompt: string;
  subagentType?: string;  // from Agent tool input.subagent_type
  model?: string;         // from Agent tool input.model
}

export interface SubagentNotification extends TapEventBase {
  kind: "SubagentNotification";
  status: "completed" | "killed";
  summary: string;
}

export interface PermissionPromptShown extends TapEventBase {
  kind: "PermissionPromptShown";
  toolName: string | null;
}

export interface PermissionApproved extends TapEventBase {
  kind: "PermissionApproved";
  toolName: string | null;
}

export interface PermissionRejected extends TapEventBase {
  kind: "PermissionRejected";
}

export interface ModeChange extends TapEventBase {
  kind: "ModeChange";
  to: string;
}

export interface SessionRegistration extends TapEventBase {
  kind: "SessionRegistration";
  pid: number;
  sessionId: string;
  cwd: string;
  name: string | null;
}

export interface CustomTitle extends TapEventBase {
  kind: "CustomTitle";
  title: string;
  sessionId: string;
}

export interface ProcessHealth extends TapEventBase {
  kind: "ProcessHealth";
  rss: number;
  heapUsed: number;
  heapTotal: number;
  uptime: number;
  cpuPercent: number;
}

export interface RateLimit extends TapEventBase {
  kind: "RateLimit";
  status: string;
  hoursTillReset: number;
}

export interface HookProgress extends TapEventBase {
  kind: "HookProgress";
  hookEvent: string;
  hookName: string;
  command: string;
  statusMessage: string;
}

export interface ToolInput extends TapEventBase {
  kind: "ToolInput";
  toolName: string;
  input: Record<string, unknown>;
}

export interface UserInterruption extends TapEventBase {
  kind: "UserInterruption";
  forToolUse: boolean;
}

export interface SlashCommand extends TapEventBase {
  kind: "SlashCommand";
  command: string;
  display: string;
}

export interface SessionResume extends TapEventBase {
  kind: "SessionResume";
}

// ── Fetch events ──

export interface ApiFetch extends TapEventBase {
  kind: "ApiFetch";
  url: string;
  method: string;
  status: number | null;
  bodyLen: number;
  durationMs: number;
  /** All response headers (raw key-value pairs) */
  headers: Record<string, string>;
  contentType?: string;
  contentLength?: number;
  responseSnap?: string | null;
  /** Distinguishes https.request response entries ('https-resp') from fetch entries */
  op?: string;
}

// [IN-18] HttpPing: dedicated HTTP ping to Anthropic origin
export interface HttpPing extends TapEventBase {
  kind: "HttpPing";
  durationMs: number;
  status: number | null;
}

// ── Spawn events ──

export interface SubprocessSpawn extends TapEventBase {
  kind: "SubprocessSpawn";
  cmd: string;
  cwd: string | null;
  pid: number | null;
}

export interface ApiRequestInfo extends TapEventBase {
  kind: "ApiRequestInfo";
  model: string;
  systemLength: number;
  toolCount: number;
  messageCount: number;
}

export interface AccountInfo extends TapEventBase {
  kind: "AccountInfo";
  subscriptionType: string | null;
  rateLimitTier: string;
  billingType: string;
  displayName: string;
}

export interface FileHistorySnapshot extends TapEventBase {
  kind: "FileHistorySnapshot";
  messageId: string;
  filePaths: string[];
}

export interface TurnDuration extends TapEventBase {
  kind: "TurnDuration";
  durationMs: number;
  messageCount: number;
}

// ── TAP pipeline expansion events ──

export interface ApiStreamError extends TapEventBase {
  kind: "ApiStreamError";
  type: string;
  message: string;
  status: number | null;
}

export interface ToolResult extends TapEventBase {
  kind: "ToolResult";
  toolName: string;
  durationMs: number;
  toolResultSizeBytes: number;
  error: string | null;
}

export interface ApiError extends TapEventBase {
  kind: "ApiError";
  status: number;
  message: string;
  retryAttempt: number | null;
  retryInMs: number | null;
}

export interface ApiRetry extends TapEventBase {
  kind: "ApiRetry";
  attempt: number;
  delayMs: number;
  status: number;
}

export interface StreamStall extends TapEventBase {
  kind: "StreamStall";
  stallDurationMs: number;
  stallCount: number;
  totalStallTimeMs: number;
}

export interface LinesChanged extends TapEventBase {
  kind: "LinesChanged";
  linesAdded: number;
  linesRemoved: number;
}

export interface ContextBudget extends TapEventBase {
  kind: "ContextBudget";
  claudeMdSize: number;
  totalContextSize: number;
  mcpToolsCount: number;
  mcpToolsTokens: number;
  nonMcpToolsCount: number;
  nonMcpToolsTokens: number;
  projectFileCount: number;
}

export interface SubagentLifecycle extends TapEventBase {
  kind: "SubagentLifecycle";
  variant: "start" | "end" | "killed";
  agentType: string | null;
  isAsync: boolean | null;
  model: string | null;
  totalTokens: number | null;
  totalToolUses: number | null;
  durationMs: number | null;
  reason: string | null;
}

export interface PlanModeEvent extends TapEventBase {
  kind: "PlanModeEvent";
  planLengthChars: number;
  outcome: string;
}

export interface WorktreeState extends TapEventBase {
  kind: "WorktreeState";
  originalCwd: string;
  worktreePath: string;
  worktreeName: string;
  worktreeBranch: string;
}

export interface WorktreeCleared extends TapEventBase {
  kind: "WorktreeCleared";
}

export interface HookTelemetry extends TapEventBase {
  kind: "HookTelemetry";
  hookName: string;
  totalDurationMs: number;
  numCommands: number;
  numSuccess: number;
  numErrors: number;
}

export interface SystemPromptCapture extends TapEventBase {
  kind: "SystemPromptCapture";
  text: string;
  model: string;
  messageCount: number;
  blocks?: SystemPromptBlock[];
  messages?: CapturedMessage[];
}

export interface IdlePrompt extends TapEventBase {
  kind: "IdlePrompt";
}

export interface EffortLevel extends TapEventBase {
  kind: "EffortLevel";
  level: string;
}

export interface StatusLineUpdate extends TapEventBase {
  kind: "StatusLineUpdate";
  sessionId: string;
  cwd: string;
  modelId: string;
  modelDisplayName: string;
  cliVersion: string;
  outputStyle: string;
  totalCostUsd: number;
  totalDurationMs: number;
  totalApiDurationMs: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  contextWindowSize: number;
  currentInputTokens: number;
  currentOutputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  contextUsedPercent: number;
  contextRemainingPercent: number;
  exceeds200kTokens: boolean;
  fiveHourUsedPercent: number;
  fiveHourResetsAt: number;
  sevenDayUsedPercent: number;
  sevenDayResetsAt: number;
  vimMode: string;
}

export interface SkillInvocationEvent extends TapEventBase {
  kind: "SkillInvocation";
  skill: string;
  success: boolean;
  allowedTools: string[];
}

// ── New TAP category events (MISSED-HOOKS) ──

export interface AsyncFileOp extends TapEventBase {
  kind: "AsyncFileOp";
  op: string;
  path: string;
  size: number;
  durationMs: number;
  error: string | null;
}

export interface BunFileOp extends TapEventBase {
  kind: "BunFileOp";
  op: string;
  path: string;
  durationMs: number;
}

export interface AbortSignal extends TapEventBase {
  kind: "AbortSignal";
  reason: string;
}

export interface FileWatch extends TapEventBase {
  kind: "FileWatch";
  op: string;
  path: string;
}

export interface TextDecoderChunk extends TapEventBase {
  kind: "TextDecoderChunk";
  length: number;
  snap: string;
}

export interface EmitterEvent extends TapEventBase {
  kind: "EmitterEvent";
  eventType: string;
  source: string;
}

export interface EnvAccess extends TapEventBase {
  kind: "EnvAccess";
  key: string;
  hasValue: boolean;
}

export interface ConsoleOutput extends TapEventBase {
  kind: "ConsoleOutput";
  op: string;       // log, warn, error
  msg: string;
}

export interface SyncFileOp extends TapEventBase {
  kind: "SyncFileOp";
  op: string;        // read, write, exists, stat, readdir
  path: string;
  size: number;
  content: string | null;
  result: boolean | null;  // exists result
}

export interface TimerOp extends TapEventBase {
  kind: "TimerOp";
  op: string;        // setTimeout, clearTimeout, setInterval, clearInterval
  id: number;
  delay: number;
  caller: string;
}

export interface BunOp extends TapEventBase {
  kind: "BunOp";
  op: string;        // write, spawn, spawnSync
  path: string;
  cmd: string;
  cwd: string | null;
  pid: number | null;
  code: number | null;
  size: number;
  durationMs: number;
}

export interface WebSocketOp extends TapEventBase {
  kind: "WebSocketOp";
  op: string;        // open, close, send
  url: string;
  code: number | null;
  reason: string;
  length: number;
}

export interface StreamOp extends TapEventBase {
  kind: "StreamOp";
  op: string;        // pipe
  src: string;
  dest: string;
}

// ── Hook events (captured only when Claude Code emits hook payloads) ──

export interface SessionEndEvent extends TapEventBase {
  kind: "SessionEndEvent";
  reason: string;
}

export interface StopEvent extends TapEventBase {
  kind: "StopEvent";
  stopHookActive: boolean;
}

export interface PreCompactEvent extends TapEventBase {
  kind: "PreCompactEvent";
  trigger: string;
}

export interface PostCompactEvent extends TapEventBase {
  kind: "PostCompactEvent";
  trigger: string;
  summary: string;
}

export interface InstructionsLoadedEvent extends TapEventBase {
  kind: "InstructionsLoadedEvent";
  filePath: string;
  memoryType: string;
  loadReason: string;
}

export interface ConfigChangeEvent extends TapEventBase {
  kind: "ConfigChangeEvent";
  source: string;
  filePath: string;
}

export interface CwdChangedEvent extends TapEventBase {
  kind: "CwdChangedEvent";
  oldCwd: string;
  newCwd: string;
}

export interface FileChangedEvent extends TapEventBase {
  kind: "FileChangedEvent";
  filePath: string;
  event: string;
}

export interface TaskCreatedEvent extends TapEventBase {
  kind: "TaskCreatedEvent";
  taskId: string;
  taskSubject: string;
}

export interface TaskCompletedEvent extends TapEventBase {
  kind: "TaskCompletedEvent";
  taskId: string;
  taskSubject: string;
}

export interface ElicitationEvent extends TapEventBase {
  kind: "ElicitationEvent";
  mcpServerName: string;
  message: string;
}

export interface NotificationHookEvent extends TapEventBase {
  kind: "NotificationHookEvent";
  message: string;
  title: string;
}

export interface SubagentStopEvent extends TapEventBase {
  kind: "SubagentStopEvent";
  agentId: string;
  agentType: string;
}

export interface SetupEvent extends TapEventBase {
  kind: "SetupEvent";
  trigger: string;
}

// ── Discriminated union ──

export type TapEvent =
  // Parse (SSE)
  | TurnStart
  | ThinkingStart
  | TextStart
  | ToolCallStart
  | BlockStop
  | TurnEnd
  | MessageStop
  // Stringify (outgoing)
  | UserInput
  | ConversationMessage
  | ApiTelemetry
  | ApiRequestInfo
  | AccountInfo
  | SubagentSpawn
  | SubagentNotification
  | PermissionPromptShown
  | PermissionApproved
  | PermissionRejected
  | ModeChange
  | SessionRegistration
  | CustomTitle
  | ProcessHealth
  | RateLimit
  | HookProgress
  | ToolInput
  | UserInterruption
  | SlashCommand
  | SessionResume
  // Fetch
  | ApiFetch
  | HttpPing
  // Spawn
  | SubprocessSpawn
  // Classified metadata
  | FileHistorySnapshot
  | TurnDuration
  // TAP pipeline expansion
  | ApiStreamError
  | ToolResult
  | ApiError
  | ApiRetry
  | StreamStall
  | LinesChanged
  | ContextBudget
  | SubagentLifecycle
  | PlanModeEvent
  | WorktreeState
  | WorktreeCleared
  | HookTelemetry
  | SystemPromptCapture
  | EffortLevel
  | StatusLineUpdate
  | IdlePrompt
  | SkillInvocationEvent
  // New TAP categories (MISSED-HOOKS)
  | AsyncFileOp
  | BunFileOp
  | AbortSignal
  | FileWatch
  | TextDecoderChunk
  | EmitterEvent
  | EnvAccess
  | ConsoleOutput
  | SyncFileOp
  | TimerOp
  | BunOp
  | WebSocketOp
  | StreamOp
  // Hook events
  | SessionEndEvent
  | StopEvent
  | PreCompactEvent
  | PostCompactEvent
  | InstructionsLoadedEvent
  | ConfigChangeEvent
  | CwdChangedEvent
  | FileChangedEvent
  | TaskCreatedEvent
  | TaskCompletedEvent
  | ElicitationEvent
  | NotificationHookEvent
  | SubagentStopEvent
  | SetupEvent;

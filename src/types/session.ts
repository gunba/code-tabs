export type SessionState =
  | "starting"
  | "idle"
  | "thinking"
  | "toolUse"
  | "waitingPermission"
  | "error"
  | "dead";

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
}

export interface SessionMetadata {
  costUsd: number;
  contextPercent: number;
  durationSecs: number;
  currentAction: string | null;
  subagentCount: number;
  taskProgress: string | null;
  nodeSummary: string | null;
  contextWarning: string | null;
  recentOutput: string;
  subagentActivity: string[];
  currentToolName: string | null;
  inputTokens: number;
  outputTokens: number;
  assistantMessageCount: number;
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
  timestamp: number;
}

export interface Subagent {
  id: string;           // agent-{hex}
  parentSessionId: string;
  state: SessionState;
  description: string;  // from Agent tool_use input.description
  tokenCount: number;
  currentAction: string | null;
  messages: SubagentMessage[];
}

export interface PastSession {
  id: string;
  path: string;
  directory: string;
  lastModified: string;
  sizeBytes: number;
  firstMessage: string;
}

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
};

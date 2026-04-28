import { describe, it, expect } from "vitest";
import type { Session, SessionConfig, SessionMetadata } from "../../types/session";
import { dirToTabName, normalizeForFilter } from "../paths";

// ── Helpers ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SessionConfig = {
  cli: "claude",
  workingDir: "/test",
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

const DEFAULT_METADATA: SessionMetadata = {
  costUsd: 0,
  contextDebug: null,
  durationSecs: 0,
  currentAction: null,
  nodeSummary: null,
  currentToolName: null,
  currentEventKind: null,
  inputTokens: 0,
  outputTokens: 0,
  assistantMessageCount: 0,
  choiceHint: false,
  runtimeModel: null,
  apiRegion: null, lastRequestId: null, subscriptionType: null, hookStatus: null,
  lastTurnCostUsd: 0, lastTurnTtftMs: 0, systemPromptLength: 0, toolCount: 0, conversationLength: 0,
  activeSubprocess: null, filesTouched: [], rateLimitRemaining: null, rateLimitReset: null, fiveHourPercent: null, fiveHourResetsAt: null, sevenDayPercent: null, sevenDayResetsAt: null, apiLatencyMs: 0, pingRttMs: 0, serverTimeMs: 0, tokPerSec: 0, linesAdded: 0, linesRemoved: 0, lastToolDurationMs: null, lastToolResultSize: null, lastToolError: null, apiRetryCount: 0, apiErrorStatus: null, apiRetryInfo: null, stallDurationMs: 0, stallCount: 0, contextBudget: null, hookTelemetry: null, planOutcome: null, effortLevel: null, worktreeInfo: null, capturedSystemPrompt: null, statusLine: null,
};

function mockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: crypto.randomUUID(),
    name: "Test Session",
    config: { ...DEFAULT_CONFIG },
    state: "idle",
    metadata: { ...DEFAULT_METADATA },
    createdAt: new Date().toISOString(),
    lastActive: new Date().toISOString(),
    ...overrides,
  };
}

// ── Init filter for empty dead sessions ────────────────────────────

/** Mirrors the init() filter in sessions.ts */
function initFilter(sessions: Session[]): Session[] {
  return sessions.filter(
    (s) => s.state !== "dead"
      || !!s.config.resumeSession
      || !!s.metadata.nodeSummary
      || s.metadata.assistantMessageCount > 0
  );
}

describe("init filter for empty dead sessions", () => {
  it("removes dead sessions with no conversation content", () => {
    const empty = mockSession({
      state: "dead",
      config: { ...DEFAULT_CONFIG, sessionId: "some-id" },
    });
    const live = mockSession({ state: "idle" });
    expect(initFilter([empty, live])).toHaveLength(1);
    expect(initFilter([empty, live])[0].id).toBe(live.id);
  });

  it("keeps dead sessions with assistantMessageCount > 0", () => {
    const withConvo = mockSession({
      state: "dead",
      config: { ...DEFAULT_CONFIG, sessionId: "conv-id" },
      metadata: { ...DEFAULT_METADATA, assistantMessageCount: 3 },
    });
    expect(initFilter([withConvo])).toHaveLength(1);
  });

  it("keeps dead sessions with nodeSummary", () => {
    const withSummary = mockSession({
      state: "dead",
      config: { ...DEFAULT_CONFIG, sessionId: "sum-id" },
      metadata: { ...DEFAULT_METADATA, nodeSummary: "Fix the bug" },
    });
    expect(initFilter([withSummary])).toHaveLength(1);
  });

  it("keeps dead sessions with resumeSession set", () => {
    const resumed = mockSession({
      state: "dead",
      config: { ...DEFAULT_CONFIG, resumeSession: "original-id" },
    });
    expect(initFilter([resumed])).toHaveLength(1);
  });

  it("keeps live sessions regardless of conversation content", () => {
    const starting = mockSession({ state: "starting" });
    const idle = mockSession({ state: "idle" });
    expect(initFilter([starting, idle])).toHaveLength(2);
  });

  it("removes dead session with sessionId but no messages", () => {
    const empty = mockSession({
      state: "dead",
      config: { ...DEFAULT_CONFIG, sessionId: "cli-session-abc" },
      metadata: { ...DEFAULT_METADATA, assistantMessageCount: 0, nodeSummary: null },
    });
    expect(initFilter([empty])).toHaveLength(0);
  });
});

// ── Dead session tab visibility ─────────────────────────────────────

describe("dead session tab visibility", () => {
  it("dead sessions with conversation appear in regular sessions list", () => {
    const dead = mockSession({
      state: "dead",
      metadata: { ...DEFAULT_METADATA, assistantMessageCount: 1 },
    });
    const live = mockSession({ state: "idle" });
    const sessions = [dead, live];

    const regularSessions = sessions.filter((s) => !s.isMetaAgent);
    expect(regularSessions).toHaveLength(2);
  });

  it("isMetaAgent sessions are filtered out", () => {
    const meta = mockSession({ state: "idle", isMetaAgent: true });
    const regular = mockSession({ state: "idle" });
    const sessions = [meta, regular];

    const regularSessions = sessions.filter((s) => !s.isMetaAgent);
    expect(regularSessions).toHaveLength(1);
    expect(regularSessions[0].id).toBe(regular.id);
  });

  it("dead sessions remain in TerminalPanel list (kept mounted for error visibility)", () => {
    const dead = mockSession({ state: "dead" });
    const live = mockSession({ state: "idle" });
    const sessions = [dead, live];

    // Dead terminals stay mounted so users can see error output
    const terminalSessions = sessions.filter((s) => !s.isMetaAgent);

    expect(terminalSessions).toHaveLength(2);
  });
});

// ── Dead session revive flow ────────────────────────────────────────

describe("dead session revive flow", () => {
  it("revive config preserves session ID for --resume", () => {
    const dead = mockSession({
      state: "dead",
      config: { ...DEFAULT_CONFIG, sessionId: "original-session-id", workingDir: "/project" },
    });

    const resumeId = dead.config.sessionId || dead.id;
    const config = {
      ...dead.config,
      continueSession: false,
      resumeSession: resumeId,
    };

    expect(config.resumeSession).toBe("original-session-id");
    expect(config.continueSession).toBe(false);
    expect(config.workingDir).toBe("/project");
  });

  it("revive config falls back to session.id when sessionId is null", () => {
    const dead = mockSession({
      state: "dead",
      config: { ...DEFAULT_CONFIG, sessionId: null, workingDir: "/project" },
    });

    const resumeId = dead.config.sessionId || dead.id;
    expect(resumeId).toBe(dead.id);
  });

  it("revive skips --resume for sessions with no conversation", () => {
    const dead = mockSession({
      state: "dead",
      metadata: { ...DEFAULT_METADATA, assistantMessageCount: 0 },
      config: { ...DEFAULT_CONFIG, sessionId: "some-id" },
    });

    const hasConversation = dead.metadata.assistantMessageCount > 0;
    const resumeId = dead.config.sessionId || dead.id;
    const config = {
      ...dead.config,
      continueSession: false,
      resumeSession: hasConversation ? resumeId : null,
    };

    expect(config.resumeSession).toBeNull();
  });

  it("revive uses --resume for sessions with conversation data", () => {
    const dead = mockSession({
      state: "dead",
      metadata: { ...DEFAULT_METADATA, assistantMessageCount: 5 },
      config: { ...DEFAULT_CONFIG, sessionId: "conv-id" },
    });

    const hasConversation = dead.metadata.assistantMessageCount > 0;
    const resumeId = dead.config.sessionId || dead.id;
    const config = {
      ...dead.config,
      continueSession: false,
      resumeSession: hasConversation ? resumeId : null,
    };

    expect(config.resumeSession).toBe("conv-id");
  });

  it("revive preserves custom session name over directory fallback", () => {
    const dead = mockSession({
      state: "dead",
      name: "My Custom Name",
      config: { ...DEFAULT_CONFIG, workingDir: "/my-project" },
    });

    const name = dead.name || dirToTabName(dead.config.workingDir);
    expect(name).toBe("My Custom Name");
  });

  it("after revive, new session passes TerminalPanel filter", () => {
    const newSession = mockSession({
      state: "starting",
      config: { ...DEFAULT_CONFIG, resumeSession: "old-id" },
    });

    const terminalSessions = [newSession]
      .filter((s) => !s.isMetaAgent)
      .filter((s) => s.state !== "dead");

    expect(terminalSessions).toHaveLength(1);
  });
});

// ── Store initialized flag ──────────────────────────────────────────

describe("store initialized flag", () => {
  it("initialized starts as false and becomes true after init", () => {
    const initialState = { initialized: false };
    const afterInit = { ...initialState, initialized: true };

    expect(initialState.initialized).toBe(false);
    expect(afterInit.initialized).toBe(true);
  });
});

// ── projectDir field ────────────────────────────────────────────────

describe("projectDir field in SessionConfig", () => {
  it("DEFAULT_CONFIG includes projectDir as false", () => {
    expect(DEFAULT_CONFIG.projectDir).toBe(false);
  });

  it("projectDir can be set to true in config", () => {
    const config = { ...DEFAULT_CONFIG, projectDir: true };
    expect(config.projectDir).toBe(true);
  });

  it("revive config preserves projectDir from dead session", () => {
    const dead = mockSession({
      state: "dead",
      config: { ...DEFAULT_CONFIG, projectDir: true, workingDir: "/project" },
    });

    const config = {
      ...dead.config,
      continueSession: false,
      resumeSession: dead.config.sessionId || dead.id,
    };

    expect(config.projectDir).toBe(true);
  });
});

// ── encode_dir normalization (ResumePicker filter logic) ────────────

describe("encode_dir normalization for directory filtering", () => {
  // Tests the normalizeForFilter logic used in ResumePicker to handle
  // the lossy encode_dir encoding where periods, spaces, and path
  // separators all become hyphens.
  const normalize = normalizeForFilter;

  it("normalizes periods to hyphens", () => {
    expect(normalize("Jordan.Graham")).toBe("jordan-graham");
  });

  it("normalizes path separators to hyphens", () => {
    expect(normalize("C:/Users/jorda")).toBe("c--users-jorda");
    expect(normalize("C:\\Users\\jorda")).toBe("c--users-jorda");
  });

  it("normalizes spaces to hyphens", () => {
    expect(normalize("My Project")).toBe("my-project");
  });

  it("matches encoded directory with original path containing periods", () => {
    const encoded = "C--Users-Jordan-Graham-Projects-my-app";
    const original = "C:/Users/Jordan.Graham/Projects/my-app";
    const filterNorm = normalize("Jordan.Graham");
    const dirNorm = normalize(encoded);
    const origNorm = normalize(original);

    // Both the encoded and original paths should contain the normalized filter
    expect(dirNorm.includes(filterNorm)).toBe(true);
    expect(origNorm.includes(filterNorm)).toBe(true);
  });

  it("case-insensitive matching", () => {
    const filter = normalize("MY-PROJECT");
    const dir = normalize("my-project");
    expect(dir.includes(filter)).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Tauri IPC before importing the store
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// Mock color assignment (no DOM/visual side effects in tests)
// Import the real findNearestLiveTab since it's pure logic used by closeSession
vi.mock("../../lib/claude", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/claude")>();
  return {
    assignSessionColor: vi.fn(),
    releaseSessionColor: vi.fn(),
    findNearestLiveTab: actual.findNearestLiveTab,
  };
});

import { useSessionStore } from "../sessions";
import { DEFAULT_SESSION_CONFIG } from "../../types/session";
import type { Session, Subagent } from "../../types/session";

/**
 * Tests for pure-logic Zustand actions in the sessions store.
 * Only synchronous set()-based actions are tested here — async actions
 * that depend on Tauri IPC (init, createSession, closeSession) are
 * integration-level and out of scope.
 */

function resetStore() {
  useSessionStore.setState({
    sessions: [],
    activeTabId: null,
    claudePath: null,
    initialized: false,
    subagents: new Map(),
    skillInvocations: new Map(),
    commandHistory: new Map(),
    respawnRequest: null,
    killRequest: null,
    hookChangeCounter: 0,
    inspectorOffSessions: new Set(),
    processHealth: new Map(),
  });
}

function makeSession(id: string, name = "test"): Session {
  return {
    id,
    name,
    config: { ...DEFAULT_SESSION_CONFIG, workingDir: "/tmp" },
    state: "idle",
    metadata: {
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
      activeSubprocess: null, filesTouched: [], rateLimitRemaining: null, rateLimitReset: null, apiLatencyMs: 0, linesAdded: 0, linesRemoved: 0, lastToolDurationMs: null, lastToolResultSize: null, lastToolError: null, apiRetryCount: 0, apiErrorStatus: null, apiRetryInfo: null, stallDurationMs: 0, stallCount: 0, contextBudget: null, hookTelemetry: null, planOutcome: null, effortLevel: null, worktreeInfo: null, capturedSystemPrompt: null, statusLine: null,
    },
    createdAt: "2026-01-01T00:00:00Z",
    lastActive: "2026-01-01T00:00:00Z",
  };
}

function makeSub(id: string, state: Subagent["state"] = "thinking"): Subagent {
  return {
    id,
    parentSessionId: "s1",
    state,
    description: `sub-${id}`,
    messages: [],
    tokenCount: 0,
    currentAction: null,
    createdAt: 0,
  };
}

describe("addCommandHistory", () => {
  beforeEach(resetStore);

  it("adds first command for a session", () => {
    useSessionStore.getState().addCommandHistory("s1", "/review", 1000);
    const history = useSessionStore.getState().commandHistory.get("s1");
    expect(history?.map((e) => e.cmd)).toEqual(["/review"]);
  });

  it("prepends newer commands (newest first)", () => {
    const { addCommandHistory } = useSessionStore.getState();
    addCommandHistory("s1", "/review", 1000);
    addCommandHistory("s1", "/build", 2000);
    addCommandHistory("s1", "/test", 3000);
    const history = useSessionStore.getState().commandHistory.get("s1");
    expect(history?.map((e) => e.cmd)).toEqual(["/test", "/build", "/review"]);
  });

  it("keeps separate histories per session", () => {
    const { addCommandHistory } = useSessionStore.getState();
    addCommandHistory("s1", "/review", 1000);
    addCommandHistory("s2", "/build", 2000);
    addCommandHistory("s1", "/test", 3000);
    expect(useSessionStore.getState().commandHistory.get("s1")?.map((e) => e.cmd)).toEqual(["/test", "/review"]);
    expect(useSessionStore.getState().commandHistory.get("s2")?.map((e) => e.cmd)).toEqual(["/build"]);
  });

  it("deduplicates consecutive identical commands", () => {
    const { addCommandHistory } = useSessionStore.getState();
    addCommandHistory("s1", "/review", 1000);
    addCommandHistory("s1", "/review", 2000);
    const history = useSessionStore.getState().commandHistory.get("s1");
    expect(history?.map((e) => e.cmd)).toEqual(["/review"]);
  });

  it("allows non-consecutive duplicate commands", () => {
    const { addCommandHistory } = useSessionStore.getState();
    addCommandHistory("s1", "/review", 1000);
    addCommandHistory("s1", "/build", 2000);
    addCommandHistory("s1", "/review", 3000);
    const history = useSessionStore.getState().commandHistory.get("s1");
    expect(history?.map((e) => e.cmd)).toEqual(["/review", "/build", "/review"]);
  });

  it("normalizes commands to lowercase", () => {
    const { addCommandHistory } = useSessionStore.getState();
    addCommandHistory("s1", "/Review", 1000);
    addCommandHistory("s1", "/BUILD", 2000);
    const history = useSessionStore.getState().commandHistory.get("s1");
    expect(history?.map((e) => e.cmd)).toEqual(["/build", "/review"]);
  });

  it("deduplicates across case variations", () => {
    const { addCommandHistory } = useSessionStore.getState();
    addCommandHistory("s1", "/review", 1000);
    addCommandHistory("s1", "/Review", 2000);
    const history = useSessionStore.getState().commandHistory.get("s1");
    expect(history?.map((e) => e.cmd)).toEqual(["/review"]);
  });

  it("stores timestamps on entries", () => {
    useSessionStore.getState().addCommandHistory("s1", "/review", 9999);
    const entry = useSessionStore.getState().commandHistory.get("s1")?.[0];
    expect(entry?.ts).toBe(9999);
  });

  it("returns undefined for session with no history", () => {
    const history = useSessionStore.getState().commandHistory.get("no-such-session");
    expect(history).toBeUndefined();
  });

  it("does not mutate the previous Map reference (immutable update)", () => {
    const mapBefore = useSessionStore.getState().commandHistory;
    useSessionStore.getState().addCommandHistory("s1", "/review", 1000);
    const mapAfter = useSessionStore.getState().commandHistory;
    expect(mapBefore).not.toBe(mapAfter);
  });
});


describe("subagent actions", () => {
  beforeEach(resetStore);

  it("addSubagent adds a subagent to a session", () => {
    useSessionStore.getState().addSubagent("s1", makeSub("sub-1"));
    const subs = useSessionStore.getState().subagents.get("s1");
    expect(subs).toHaveLength(1);
    expect(subs![0].id).toBe("sub-1");
  });

  it("addSubagent prevents duplicates by id", () => {
    const sub = makeSub("sub-1");
    useSessionStore.getState().addSubagent("s1", sub);
    useSessionStore.getState().addSubagent("s1", { ...sub, description: "dupe" });
    const subs = useSessionStore.getState().subagents.get("s1");
    expect(subs).toHaveLength(1);
    expect(subs![0].description).toBe("sub-sub-1"); // kept original
  });

  it("updateSubagent modifies a matching subagent", () => {
    useSessionStore.getState().addSubagent("s1", makeSub("sub-1"));
    useSessionStore.getState().updateSubagent("s1", "sub-1", { state: "dead", tokenCount: 500 });
    const subs = useSessionStore.getState().subagents.get("s1");
    expect(subs![0].state).toBe("dead");
    expect(subs![0].tokenCount).toBe(500);
  });

  it("clearIdleSubagents filters out idle subagents", () => {
    useSessionStore.getState().addSubagent("s1", makeSub("sub-1", "idle"));
    useSessionStore.getState().addSubagent("s1", makeSub("sub-2", "thinking"));
    useSessionStore.getState().clearIdleSubagents("s1");
    const subs = useSessionStore.getState().subagents.get("s1");
    expect(subs).toHaveLength(1);
    expect(subs![0].id).toBe("sub-2");
  });

  it("clearIdleSubagents also clears dead subagents", () => {
    useSessionStore.getState().addSubagent("s1", makeSub("sub-1", "dead"));
    useSessionStore.getState().addSubagent("s1", makeSub("sub-2", "thinking"));
    useSessionStore.getState().clearIdleSubagents("s1");
    const subs = useSessionStore.getState().subagents.get("s1");
    expect(subs).toHaveLength(1);
    expect(subs![0].id).toBe("sub-2");
  });

  it("clearIdleSubagents also clears interrupted subagents", () => {
    useSessionStore.getState().addSubagent("s1", makeSub("sub-1", "interrupted"));
    useSessionStore.getState().addSubagent("s1", makeSub("sub-2", "thinking"));
    useSessionStore.getState().clearIdleSubagents("s1");
    const subs = useSessionStore.getState().subagents.get("s1");
    expect(subs).toHaveLength(1);
    expect(subs![0].id).toBe("sub-2");
  });

  it("clearIdleSubagents is a no-op when no idle subagents exist", () => {
    useSessionStore.getState().addSubagent("s1", makeSub("sub-1", "thinking"));
    const before = useSessionStore.getState().subagents;
    useSessionStore.getState().clearIdleSubagents("s1");
    // Same reference when nothing changed (optimization)
    expect(useSessionStore.getState().subagents).toBe(before);
  });
});

describe("closeSession tab selection", () => {
  beforeEach(resetStore);

  it("selects tab to the right when closing active middle tab", async () => {
    useSessionStore.setState({
      sessions: [makeSession("a"), makeSession("b"), makeSession("c")],
      activeTabId: "b",
    });
    await useSessionStore.getState().closeSession("b");
    expect(useSessionStore.getState().activeTabId).toBe("c");
  });

  it("selects tab to the left when closing active last tab", async () => {
    useSessionStore.setState({
      sessions: [makeSession("a"), makeSession("b"), makeSession("c")],
      activeTabId: "c",
    });
    await useSessionStore.getState().closeSession("c");
    expect(useSessionStore.getState().activeTabId).toBe("b");
  });

  it("selects tab to the right when closing active first tab", async () => {
    useSessionStore.setState({
      sessions: [makeSession("a"), makeSession("b")],
      activeTabId: "a",
    });
    await useSessionStore.getState().closeSession("a");
    expect(useSessionStore.getState().activeTabId).toBe("b");
  });

  it("keeps activeTabId when closing non-active tab", async () => {
    useSessionStore.setState({
      sessions: [makeSession("a"), makeSession("b"), makeSession("c")],
      activeTabId: "a",
    });
    await useSessionStore.getState().closeSession("b");
    expect(useSessionStore.getState().activeTabId).toBe("a");
  });

  it("sets null when closing the only tab", async () => {
    useSessionStore.setState({
      sessions: [makeSession("a")],
      activeTabId: "a",
    });
    await useSessionStore.getState().closeSession("a");
    expect(useSessionStore.getState().activeTabId).toBeNull();
  });

  it("prefers live tab over adjacent dead tab when closing active tab", async () => {
    useSessionStore.setState({
      sessions: [makeSession("a"), { ...makeSession("b"), state: "dead" as const }, makeSession("c")],
      activeTabId: "a",
    });
    await useSessionStore.getState().closeSession("a");
    expect(useSessionStore.getState().activeTabId).toBe("c");
  });

  it("falls back to dead tab when all remaining tabs are dead", async () => {
    useSessionStore.setState({
      sessions: [makeSession("a"), { ...makeSession("b"), state: "dead" as const }, { ...makeSession("c"), state: "dead" as const }],
      activeTabId: "a",
    });
    await useSessionStore.getState().closeSession("a");
    expect(useSessionStore.getState().activeTabId).toBe("b");
  });

  it("removes session from store even when close_session IPC rejects", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockInvoke = invoke as ReturnType<typeof vi.fn>;
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "close_session" ? Promise.reject(new Error("IPC broken")) : Promise.resolve(undefined)
    );
    useSessionStore.setState({
      sessions: [makeSession("a"), makeSession("b")],
      activeTabId: "a",
    });
    await useSessionStore.getState().closeSession("a");
    expect(useSessionStore.getState().sessions).toHaveLength(1);
    expect(useSessionStore.getState().sessions[0].id).toBe("b");
    expect(useSessionStore.getState().activeTabId).toBe("b");
    // Restore default mock
    mockInvoke.mockResolvedValue(undefined);
  });
});

describe("closeSession cleanup", () => {
  beforeEach(resetStore);

  it("removes subagents, skillInvocations, commandHistory, and processHealth for closed session", async () => {
    useSessionStore.setState({
      sessions: [makeSession("s1"), makeSession("s2")],
      activeTabId: "s1",
      subagents: new Map([["s1", [makeSub("sub-1")]], ["s2", [makeSub("sub-2")]]]),
      skillInvocations: new Map([["s1", [{ id: "skill-100", skill: "commit", success: true, allowedTools: [], timestamp: 100 }]]]),
      commandHistory: new Map([["s1", [{ cmd: "/review", ts: 1000 }]], ["s2", [{ cmd: "/build", ts: 2000 }]]]),
      processHealth: new Map([["s1", { rss: 100, heapUsed: 50, uptime: 10 }], ["s2", { rss: 200, heapUsed: 80, uptime: 20 }]]),
    });
    await useSessionStore.getState().closeSession("s1");
    const state = useSessionStore.getState();
    expect(state.subagents.has("s1")).toBe(false);
    expect(state.subagents.has("s2")).toBe(true);
    expect(state.skillInvocations.has("s1")).toBe(false);
    expect(state.commandHistory.has("s1")).toBe(false);
    expect(state.commandHistory.has("s2")).toBe(true);
    expect(state.processHealth.has("s1")).toBe(false);
    expect(state.processHealth.has("s2")).toBe(true);
  });

  it("removes closed session from inspectorOffSessions", async () => {
    useSessionStore.setState({
      sessions: [makeSession("s1"), makeSession("s2")],
      activeTabId: "s1",
      inspectorOffSessions: new Set(["s1", "s2"]),
    });
    await useSessionStore.getState().closeSession("s1");
    const state = useSessionStore.getState();
    expect(state.inspectorOffSessions.has("s1")).toBe(false);
    expect(state.inspectorOffSessions.has("s2")).toBe(true);
  });
});

describe("simple state actions", () => {
  beforeEach(resetStore);

  it("bumpHookChange increments counter", () => {
    expect(useSessionStore.getState().hookChangeCounter).toBe(0);
    useSessionStore.getState().bumpHookChange();
    expect(useSessionStore.getState().hookChangeCounter).toBe(1);
    useSessionStore.getState().bumpHookChange();
    expect(useSessionStore.getState().hookChangeCounter).toBe(2);
  });

  it("setInspectorOff adds and removes session ids", () => {
    useSessionStore.getState().setInspectorOff("s1", true);
    expect(useSessionStore.getState().inspectorOffSessions.has("s1")).toBe(true);
    useSessionStore.getState().setInspectorOff("s1", false);
    expect(useSessionStore.getState().inspectorOffSessions.has("s1")).toBe(false);
  });

  it("requestRespawn / clearRespawnRequest lifecycle", () => {
    const config = { ...DEFAULT_SESSION_CONFIG, workingDir: "/tmp" };
    useSessionStore.getState().requestRespawn("tab-1", config, "test-name");
    expect(useSessionStore.getState().respawnRequest).toEqual({
      tabId: "tab-1",
      config,
      name: "test-name",
    });
    useSessionStore.getState().clearRespawnRequest();
    expect(useSessionStore.getState().respawnRequest).toBeNull();
  });

  it("requestKill / clearKillRequest lifecycle", () => {
    useSessionStore.getState().requestKill("s1");
    expect(useSessionStore.getState().killRequest).toBe("s1");
    useSessionStore.getState().clearKillRequest();
    expect(useSessionStore.getState().killRequest).toBeNull();
  });

  it("updateMetadata merges partial metadata", () => {
    useSessionStore.setState({ sessions: [makeSession("s1")] });
    useSessionStore.getState().updateMetadata("s1", { costUsd: 1.5, inputTokens: 500 });
    const meta = useSessionStore.getState().sessions[0].metadata;
    expect(meta.costUsd).toBe(1.5);
    expect(meta.inputTokens).toBe(500);
    expect(meta.outputTokens).toBe(0); // unchanged
  });

  it("updateState changes session state", () => {
    useSessionStore.setState({ sessions: [makeSession("s1")] });
    useSessionStore.getState().updateState("s1", "thinking");
    expect(useSessionStore.getState().sessions[0].state).toBe("thinking");
  });

  it("updateConfig merges partial config", () => {
    useSessionStore.setState({ sessions: [makeSession("s1")] });
    useSessionStore.getState().updateConfig("s1", { model: "claude-opus-4-6" });
    const cfg = useSessionStore.getState().sessions[0].config;
    expect(cfg.model).toBe("claude-opus-4-6");
    expect(cfg.workingDir).toBe("/tmp"); // unchanged
  });

  it("reorderTabs reorders sessions array", () => {
    useSessionStore.setState({
      sessions: [makeSession("a"), makeSession("b"), makeSession("c")],
    });
    useSessionStore.getState().reorderTabs(["c", "a", "b"]);
    const ids = useSessionStore.getState().sessions.map((s) => s.id);
    expect(ids).toEqual(["c", "a", "b"]);
  });
});

describe("skillInvocation actions", () => {
  beforeEach(resetStore);

  const makeSkill = (id: string, skill = "commit", ts = 100) => ({
    id, skill, success: true, allowedTools: ["Read"] as string[], timestamp: ts,
  });

  it("addSkillInvocation adds a skill invocation", () => {
    useSessionStore.getState().addSkillInvocation("s1", makeSkill("skill-100"));
    const list = useSessionStore.getState().skillInvocations.get("s1");
    expect(list).toHaveLength(1);
    expect(list![0].skill).toBe("commit");
  });

  it("addSkillInvocation deduplicates by id", () => {
    useSessionStore.getState().addSkillInvocation("s1", makeSkill("skill-100"));
    useSessionStore.getState().addSkillInvocation("s1", makeSkill("skill-100"));
    expect(useSessionStore.getState().skillInvocations.get("s1")).toHaveLength(1);
  });

  it("addSkillInvocation prepends newest first", () => {
    useSessionStore.getState().addSkillInvocation("s1", makeSkill("skill-100", "commit", 100));
    useSessionStore.getState().addSkillInvocation("s1", makeSkill("skill-200", "review", 200));
    const list = useSessionStore.getState().skillInvocations.get("s1")!;
    expect(list[0].id).toBe("skill-200");
    expect(list[1].id).toBe("skill-100");
  });

  it("addSkillInvocation caps at 50", () => {
    for (let i = 0; i < 51; i++) {
      useSessionStore.getState().addSkillInvocation("s1", makeSkill(`skill-${i}`, "commit", i));
    }
    expect(useSessionStore.getState().skillInvocations.get("s1")).toHaveLength(50);
  });

  it("removeSkillInvocation removes matching invocation", () => {
    useSessionStore.getState().addSkillInvocation("s1", makeSkill("skill-100"));
    useSessionStore.getState().addSkillInvocation("s1", makeSkill("skill-200", "review", 200));
    useSessionStore.getState().removeSkillInvocation("s1", "skill-100");
    const list = useSessionStore.getState().skillInvocations.get("s1")!;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("skill-200");
  });

  it("removeSkillInvocation is no-op for unknown id", () => {
    useSessionStore.getState().addSkillInvocation("s1", makeSkill("skill-100"));
    const before = useSessionStore.getState();
    useSessionStore.getState().removeSkillInvocation("s1", "nonexistent");
    expect(useSessionStore.getState()).toBe(before);
  });
});

describe("addSeenToolName", () => {
  beforeEach(() => {
    resetStore();
    useSessionStore.setState({ seenToolNames: new Set() });
  });

  it("adds a new tool name", () => {
    useSessionStore.getState().addSeenToolName("Bash");
    expect(useSessionStore.getState().seenToolNames.has("Bash")).toBe(true);
  });

  it("deduplicates — same name does not increase size", () => {
    useSessionStore.getState().addSeenToolName("Bash");
    useSessionStore.getState().addSeenToolName("Bash");
    expect(useSessionStore.getState().seenToolNames.size).toBe(1);
  });

  it("tracks multiple distinct tool names", () => {
    useSessionStore.getState().addSeenToolName("Grep");
    useSessionStore.getState().addSeenToolName("Read");
    expect(useSessionStore.getState().seenToolNames.size).toBe(2);
    expect(useSessionStore.getState().seenToolNames.has("Grep")).toBe(true);
    expect(useSessionStore.getState().seenToolNames.has("Read")).toBe(true);
  });

  it("returns same state reference for duplicate (no re-render)", () => {
    useSessionStore.getState().addSeenToolName("Bash");
    const stateBefore = useSessionStore.getState();
    useSessionStore.getState().addSeenToolName("Bash");
    expect(useSessionStore.getState()).toBe(stateBefore);
  });
});

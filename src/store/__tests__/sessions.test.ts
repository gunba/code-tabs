import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Tauri IPC before importing the store
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// Mock color assignment (no DOM/visual side effects in tests)
vi.mock("../../lib/claude", () => ({
  assignSessionColor: vi.fn(),
  releaseSessionColor: vi.fn(),
}));

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
    commandHistory: new Map(),
    respawnRequest: null,
    killRequest: null,
    hookChangeCounter: 0,
    inspectorOffSessions: new Set(),
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
      contextPercent: 0,
      durationSecs: 0,
      currentAction: null,
      nodeSummary: null,
      currentToolName: null,
      inputTokens: 0,
      outputTokens: 0,
      assistantMessageCount: 0,
      choiceHint: false,
      runtimeModel: null,
      apiRegion: null, lastRequestId: null, subscriptionType: null, hookStatus: null,
      lastTurnCostUsd: 0, lastTurnTtftMs: 0, systemPromptLength: 0, toolCount: 0, conversationLength: 0,
      activeSubprocess: null, filesTouched: [], rateLimitRemaining: null, rateLimitReset: null, linesAdded: 0, linesRemoved: 0, lastToolDurationMs: null, lastToolResultSize: null, lastToolError: null, apiRetryCount: 0, apiErrorStatus: null, apiRetryInfo: null, stallDurationMs: 0, stallCount: 0, contextBudget: null, hookTelemetry: null, planOutcome: null, worktreeInfo: null,
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
  };
}

describe("addCommandHistory", () => {
  beforeEach(resetStore);

  it("adds first command for a session", () => {
    useSessionStore.getState().addCommandHistory("s1", "/review");
    const history = useSessionStore.getState().commandHistory.get("s1");
    expect(history).toEqual(["/review"]);
  });

  it("prepends newer commands (newest first)", () => {
    const { addCommandHistory } = useSessionStore.getState();
    addCommandHistory("s1", "/review");
    addCommandHistory("s1", "/build");
    addCommandHistory("s1", "/test");
    const history = useSessionStore.getState().commandHistory.get("s1");
    expect(history).toEqual(["/test", "/build", "/review"]);
  });

  it("keeps separate histories per session", () => {
    const { addCommandHistory } = useSessionStore.getState();
    addCommandHistory("s1", "/review");
    addCommandHistory("s2", "/build");
    addCommandHistory("s1", "/test");
    expect(useSessionStore.getState().commandHistory.get("s1")).toEqual(["/test", "/review"]);
    expect(useSessionStore.getState().commandHistory.get("s2")).toEqual(["/build"]);
  });

  it("allows duplicate commands (history, not unique set)", () => {
    const { addCommandHistory } = useSessionStore.getState();
    addCommandHistory("s1", "/review");
    addCommandHistory("s1", "/review");
    const history = useSessionStore.getState().commandHistory.get("s1");
    expect(history).toEqual(["/review", "/review"]);
  });

  it("returns undefined for session with no history", () => {
    const history = useSessionStore.getState().commandHistory.get("no-such-session");
    expect(history).toBeUndefined();
  });

  it("does not mutate the previous Map reference (immutable update)", () => {
    const mapBefore = useSessionStore.getState().commandHistory;
    useSessionStore.getState().addCommandHistory("s1", "/review");
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

  it("renameSession updates session name", () => {
    useSessionStore.setState({ sessions: [makeSession("s1", "old")] });
    useSessionStore.getState().renameSession("s1", "new-name");
    expect(useSessionStore.getState().sessions[0].name).toBe("new-name");
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

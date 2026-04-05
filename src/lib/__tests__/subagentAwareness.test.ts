import { describe, it, expect } from "vitest";
import { isSubagentActive } from "../../types/session";
import type { SessionState, Subagent } from "../../types/session";
import { getEffectiveState } from "../claude";
import { TapSubagentTracker } from "../tapSubagentTracker";
import { TapMetadataAccumulator } from "../tapMetadataAccumulator";
import type { TapEvent } from "../../types/tapEvents";

// ── isSubagentActive ──

describe("isSubagentActive", () => {
  it("returns true for active states", () => {
    expect(isSubagentActive("thinking")).toBe(true);
    expect(isSubagentActive("toolUse")).toBe(true);
    expect(isSubagentActive("starting")).toBe(true);
    expect(isSubagentActive("actionNeeded")).toBe(true);
    expect(isSubagentActive("waitingPermission")).toBe(true);
    expect(isSubagentActive("error")).toBe(true);
  });

  it("returns false for inactive states", () => {
    expect(isSubagentActive("dead")).toBe(false);
    expect(isSubagentActive("idle")).toBe(false);
    expect(isSubagentActive("interrupted")).toBe(false);
  });
});

// ── getEffectiveState ──

function makeSub(state: SessionState): Subagent {
  return { id: "a1", parentSessionId: "s1", state, description: "", tokenCount: 0, currentAction: null, currentToolName: null, currentEventKind: null, messages: [], createdAt: 0 };
}

describe("getEffectiveState", () => {
  it("returns raw state when no subagents", () => {
    expect(getEffectiveState("idle", [])).toBe("idle");
    expect(getEffectiveState("thinking", [])).toBe("thinking");
  });

  it("returns 'toolUse' when idle but subagents active", () => {
    expect(getEffectiveState("idle", [makeSub("thinking")])).toBe("toolUse");
    expect(getEffectiveState("idle", [makeSub("toolUse")])).toBe("toolUse");
    expect(getEffectiveState("idle", [makeSub("starting")])).toBe("toolUse");
  });

  it("returns 'toolUse' when interrupted but subagents active", () => {
    expect(getEffectiveState("interrupted", [makeSub("thinking")])).toBe("toolUse");
  });

  it("returns raw state when idle and all subagents done", () => {
    expect(getEffectiveState("idle", [makeSub("idle"), makeSub("dead")])).toBe("idle");
  });

  it("passes through non-idle states regardless of subagents", () => {
    expect(getEffectiveState("thinking", [makeSub("thinking")])).toBe("thinking");
    expect(getEffectiveState("toolUse", [makeSub("thinking")])).toBe("toolUse");
    expect(getEffectiveState("dead", [makeSub("thinking")])).toBe("dead");
    expect(getEffectiveState("error", [makeSub("thinking")])).toBe("error");
    expect(getEffectiveState("waitingPermission", [makeSub("thinking")])).toBe("waitingPermission");
  });
});

// ── TapSubagentTracker.hasActiveAgents ──

describe("TapSubagentTracker.hasActiveAgents", () => {
  it("returns false when no agents tracked", () => {
    const tracker = new TapSubagentTracker("s1");
    expect(tracker.hasActiveAgents()).toBe(false);
  });

  it("returns true when agents are active", () => {
    const tracker = new TapSubagentTracker("s1");
    // Spawn + first sidechain message creates a subagent
    tracker.process({ kind: "SubagentSpawn", ts: 1, description: "test", prompt: "do stuff" } as TapEvent);
    const actions = tracker.process({
      kind: "ConversationMessage", ts: 2, messageType: "assistant",
      isSidechain: true, agentId: "agent-1", uuid: null, parentUuid: null, promptId: null,
      stopReason: "tool_use", toolNames: ["Bash"], toolAction: "Bash: ls",
      textSnippet: null, cwd: null, hasToolError: false, toolErrorText: null, toolResultSnippets: null,
    } as TapEvent);
    expect(actions.some(a => a.type === "add")).toBe(true);
    expect(tracker.hasActiveAgents()).toBe(true);
  });

  it("returns false after agents go idle", () => {
    const tracker = new TapSubagentTracker("s1");
    tracker.process({ kind: "SubagentSpawn", ts: 1, description: "test", prompt: "do stuff" } as TapEvent);
    tracker.process({
      kind: "ConversationMessage", ts: 2, messageType: "assistant",
      isSidechain: true, agentId: "agent-1", uuid: null, parentUuid: null, promptId: null,
      stopReason: "end_turn", toolNames: [], toolAction: null,
      textSnippet: "done", cwd: null, hasToolError: false, toolErrorText: null, toolResultSnippets: null,
    } as TapEvent);
    expect(tracker.hasActiveAgents()).toBe(false);
  });
});

// ── Stale agent cleanup on UserInput ──

describe("TapSubagentTracker stale cleanup", () => {
  it("marks active agents idle on UserInput", () => {
    const tracker = new TapSubagentTracker("s1");
    tracker.process({ kind: "SubagentSpawn", ts: 1, description: "test", prompt: "do stuff" } as TapEvent);
    tracker.process({
      kind: "ConversationMessage", ts: 2, messageType: "assistant",
      isSidechain: true, agentId: "agent-1", uuid: null, parentUuid: null, promptId: null,
      stopReason: "tool_use", toolNames: ["Bash"], toolAction: "Bash: ls",
      textSnippet: null, cwd: null, hasToolError: false, toolErrorText: null, toolResultSnippets: null,
    } as TapEvent);
    expect(tracker.hasActiveAgents()).toBe(true);

    const actions = tracker.process({
      kind: "UserInput", ts: 3, display: "hello", sessionId: "s1",
    } as TapEvent);
    expect(tracker.hasActiveAgents()).toBe(false);
    expect(actions.some(a => a.type === "update" && a.updates?.state === "idle")).toBe(true);
  });
});

// ── SubagentLifecycle "end" marks all active dead ──

describe("TapSubagentTracker SubagentLifecycle", () => {
  function spawnAgent(tracker: TapSubagentTracker, agentId: string, desc: string) {
    tracker.process({ kind: "SubagentSpawn", ts: 1, description: desc, prompt: "p" } as TapEvent);
    tracker.process({
      kind: "ConversationMessage", ts: 2, messageType: "assistant",
      isSidechain: true, agentId, uuid: null, parentUuid: null, promptId: null,
      stopReason: "tool_use", toolNames: ["Bash"], toolAction: "Bash: ls",
      textSnippet: null, cwd: null, hasToolError: false, toolErrorText: null, toolResultSnippets: null,
    } as TapEvent);
  }

  it("marks all active subagents dead on SubagentLifecycle end", () => {
    const tracker = new TapSubagentTracker("s1");
    spawnAgent(tracker, "agent-a", "A");
    spawnAgent(tracker, "agent-b", "B");
    expect(tracker.hasActiveAgents()).toBe(true);

    const actions = tracker.process({
      kind: "SubagentLifecycle", ts: 10, variant: "end",
      agentType: null, isAsync: null, model: null,
      totalTokens: null, totalToolUses: 5, durationMs: 3000, reason: null,
    } as TapEvent);
    expect(tracker.hasActiveAgents()).toBe(false);
    const deadUpdates = actions.filter(a => a.type === "update" && a.updates?.state === "dead");
    expect(deadUpdates).toHaveLength(2);
  });

  it("enriches lastActiveAgent with metadata on end", () => {
    const tracker = new TapSubagentTracker("s1");
    spawnAgent(tracker, "agent-x", "X");

    const actions = tracker.process({
      kind: "SubagentLifecycle", ts: 10, variant: "end",
      agentType: null, isAsync: null, model: null,
      totalTokens: null, totalToolUses: 7, durationMs: 4500, reason: null,
    } as TapEvent);
    const metaUpdate = actions.find(a => a.type === "update" && a.updates?.totalToolUses === 7);
    expect(metaUpdate).toBeDefined();
    expect(metaUpdate!.updates!.durationMs).toBe(4500);
  });

  it("marks all active dead on SubagentLifecycle killed", () => {
    const tracker = new TapSubagentTracker("s1");
    spawnAgent(tracker, "agent-1", "A");

    const actions = tracker.process({
      kind: "SubagentLifecycle", ts: 10, variant: "killed",
      agentType: null, isAsync: null, model: null,
      totalTokens: null, totalToolUses: null, durationMs: null, reason: "interrupted",
    } as TapEvent);
    expect(tracker.hasActiveAgents()).toBe(false);
    expect(actions.some(a => a.updates?.state === "dead")).toBe(true);
  });
});

// ── SubagentNotification marks dead ──

describe("TapSubagentTracker SubagentNotification", () => {
  it("marks active subagents dead regardless of status", () => {
    const tracker = new TapSubagentTracker("s1");
    tracker.process({ kind: "SubagentSpawn", ts: 1, description: "test", prompt: "p" } as TapEvent);
    tracker.process({
      kind: "ConversationMessage", ts: 2, messageType: "assistant",
      isSidechain: true, agentId: "agent-1", uuid: null, parentUuid: null, promptId: null,
      stopReason: "tool_use", toolNames: ["Bash"], toolAction: "Bash: ls",
      textSnippet: null, cwd: null, hasToolError: false, toolErrorText: null, toolResultSnippets: null,
    } as TapEvent);
    expect(tracker.hasActiveAgents()).toBe(true);

    const actions = tracker.process({
      kind: "SubagentNotification", ts: 5, status: "completed", summary: "",
    } as TapEvent);
    expect(tracker.hasActiveAgents()).toBe(false);
    expect(actions.some(a => a.updates?.state === "dead")).toBe(true);
  });
});

// ── TapMetadataAccumulator queryDepth filtering ──

describe("TapMetadataAccumulator queryDepth filtering", () => {
  it("accumulates tokens from SSE (TurnEnd), not ApiTelemetry", () => {
    const acc = new TapMetadataAccumulator();
    // ApiTelemetry no longer accumulates tokens (only cost)
    const diff = acc.process({
      kind: "ApiTelemetry", ts: 1, model: "opus", costUSD: 0.01,
      inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, uncachedInputTokens: 100,
      durationMs: 500, ttftMs: 100, queryChainId: null, queryDepth: 0, stopReason: "end_turn",
    } as TapEvent);
    expect(diff).not.toBeNull();
    expect(diff!.inputTokens).toBe(0); // tokens come from TurnEnd now
    expect(diff!.outputTokens).toBe(0);
    expect(diff!.costUsd).toBe(0.01); // cost still from ApiTelemetry
  });

  it("does NOT accumulate cost for queryDepth > 0", () => {
    const acc = new TapMetadataAccumulator();
    const diff = acc.process({
      kind: "ApiTelemetry", ts: 1, model: "haiku", costUSD: 0.001,
      inputTokens: 5000, outputTokens: 2000, cachedInputTokens: 0, uncachedInputTokens: 5000,
      durationMs: 200, ttftMs: 50, queryChainId: null, queryDepth: 1, stopReason: "end_turn",
    } as TapEvent);
    expect(diff).not.toBeNull();
    expect(diff!.inputTokens).toBe(0);
    expect(diff!.outputTokens).toBe(0);
    expect(diff!.costUsd).toBe(0); // queryDepth > 0 → no cost accumulation
  });

  it("does not let subagent TurnStart overwrite runtimeModel", () => {
    const acc = new TapMetadataAccumulator();
    // First TurnStart sets model (initializer)
    const diff1 = acc.process({
      kind: "TurnStart", ts: 1, model: "claude-opus-4-6",
      inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0,
    } as TapEvent);
    expect(diff1!.runtimeModel).toBe("claude-opus-4-6");
    // Second TurnStart (subagent) should NOT overwrite — model already set
    acc.process({
      kind: "TurnStart", ts: 2, model: "claude-haiku-4-5-20251001",
      inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0,
    } as TapEvent);
    // Force a new diff by changing something else
    const diff3 = acc.process({
      kind: "ApiTelemetry", ts: 3, model: "", costUSD: 0.01,
      inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, uncachedInputTokens: 10,
      durationMs: 100, ttftMs: 50, queryChainId: null, queryDepth: 0, stopReason: "end_turn",
    } as TapEvent);
    expect(diff3!.runtimeModel).toBe("claude-opus-4-6");
  });
});

// ── Tool name prefix stripping ──

describe("TapSubagentTracker tool name prefix stripping", () => {
  it("strips known tool prefix from message text", () => {
    const tracker = new TapSubagentTracker("s1");
    tracker.process({ kind: "SubagentSpawn", ts: 1, description: "test", prompt: "x" } as TapEvent);
    const actions = tracker.process({
      kind: "ConversationMessage", ts: 2, messageType: "assistant",
      isSidechain: true, agentId: "agent-1", uuid: null, parentUuid: null, promptId: null,
      stopReason: "tool_use", toolNames: ["Read"], toolAction: "Read: /path/to/file",
      textSnippet: null, cwd: null, hasToolError: false, toolErrorText: null, toolResultSnippets: null,
    } as TapEvent);
    const update = actions.find(a => a.type === "update" && a.updates?.messages);
    const msgs = update!.updates!.messages!;
    const toolMsg = msgs.find(m => m.role === "tool");
    expect(toolMsg!.toolName).toBe("Read");
    expect(toolMsg!.text).toBe("/path/to/file");
  });

  it("preserves text when no matching prefix", () => {
    const tracker = new TapSubagentTracker("s1");
    tracker.process({ kind: "SubagentSpawn", ts: 1, description: "test", prompt: "x" } as TapEvent);
    const actions = tracker.process({
      kind: "ConversationMessage", ts: 2, messageType: "assistant",
      isSidechain: true, agentId: "agent-1", uuid: null, parentUuid: null, promptId: null,
      stopReason: "tool_use", toolNames: ["CustomTool"], toolAction: "some other format",
      textSnippet: null, cwd: null, hasToolError: false, toolErrorText: null, toolResultSnippets: null,
    } as TapEvent);
    const update = actions.find(a => a.type === "update" && a.updates?.messages);
    const toolMsg = update!.updates!.messages!.find(m => m.role === "tool");
    expect(toolMsg!.text).toBe("some other format");
  });

  it("handles bare tool name (no value after prefix)", () => {
    const tracker = new TapSubagentTracker("s1");
    tracker.process({ kind: "SubagentSpawn", ts: 1, description: "test", prompt: "x" } as TapEvent);
    const actions = tracker.process({
      kind: "ConversationMessage", ts: 2, messageType: "assistant",
      isSidechain: true, agentId: "agent-1", uuid: null, parentUuid: null, promptId: null,
      stopReason: "tool_use", toolNames: ["Agent"], toolAction: "Agent",
      textSnippet: null, cwd: null, hasToolError: false, toolErrorText: null, toolResultSnippets: null,
    } as TapEvent);
    const update = actions.find(a => a.type === "update" && a.updates?.messages);
    const toolMsg = update!.updates!.messages!.find(m => m.role === "tool");
    expect(toolMsg!.toolName).toBe("Agent");
    expect(toolMsg!.text).toBe("Agent"); // no prefix to strip, text unchanged
  });
});

// ── Cost accumulation ──

describe("TapSubagentTracker costUsd accumulation", () => {
  it("accumulates costUsd from ApiTelemetry for subagents", () => {
    const tracker = new TapSubagentTracker("s1");
    tracker.process({ kind: "SubagentSpawn", ts: 1, description: "test", prompt: "x" } as TapEvent);
    tracker.process({
      kind: "ConversationMessage", ts: 2, messageType: "assistant",
      isSidechain: true, agentId: "agent-1", uuid: null, parentUuid: null, promptId: null,
      stopReason: "tool_use", toolNames: ["Bash"], toolAction: "Bash: ls",
      textSnippet: null, cwd: null, hasToolError: false, toolErrorText: null, toolResultSnippets: null,
    } as TapEvent);

    const actions1 = tracker.process({
      kind: "ApiTelemetry", ts: 3, model: "haiku", costUSD: 0.05,
      inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, uncachedInputTokens: 100,
      durationMs: 200, ttftMs: 50, queryChainId: null, queryDepth: 1, stopReason: "end_turn",
    } as TapEvent);
    const update1 = actions1.find(a => a.type === "update" && a.updates?.costUsd != null);
    expect(update1).toBeDefined();
    expect(update1!.updates!.costUsd).toBe(0.05);
    expect(update1!.updates!.tokenCount).toBe(150);

    // Second telemetry event — cost should accumulate
    const actions2 = tracker.process({
      kind: "ApiTelemetry", ts: 4, model: "haiku", costUSD: 0.03,
      inputTokens: 80, outputTokens: 20, cachedInputTokens: 0, uncachedInputTokens: 80,
      durationMs: 150, ttftMs: 40, queryChainId: null, queryDepth: 1, stopReason: "end_turn",
    } as TapEvent);
    const update2 = actions2.find(a => a.type === "update" && a.updates?.costUsd != null);
    expect(update2!.updates!.costUsd).toBeCloseTo(0.08);
    expect(update2!.updates!.tokenCount).toBe(250);
  });
});

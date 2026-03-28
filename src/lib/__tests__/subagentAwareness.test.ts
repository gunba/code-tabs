import { describe, it, expect } from "vitest";
import { isSubagentActive, isSessionIdle } from "../../types/session";
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
  return { id: "a1", parentSessionId: "s1", state, description: "", tokenCount: 0, currentAction: null, messages: [] };
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
      textSnippet: null, cwd: null, hasToolError: false, toolErrorText: null,
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
      textSnippet: "done", cwd: null, hasToolError: false, toolErrorText: null,
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
      textSnippet: null, cwd: null, hasToolError: false, toolErrorText: null,
    } as TapEvent);
    expect(tracker.hasActiveAgents()).toBe(true);

    const actions = tracker.process({
      kind: "UserInput", ts: 3, display: "hello", sessionId: "s1",
    } as TapEvent);
    expect(tracker.hasActiveAgents()).toBe(false);
    expect(actions.some(a => a.type === "update" && a.updates?.state === "idle")).toBe(true);
  });
});

// ── TapMetadataAccumulator queryDepth filtering ──

describe("TapMetadataAccumulator queryDepth filtering", () => {
  it("accumulates tokens for queryDepth 0", () => {
    const acc = new TapMetadataAccumulator();
    const diff = acc.process({
      kind: "ApiTelemetry", ts: 1, model: "opus", costUSD: 0.01,
      inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, uncachedInputTokens: 100,
      durationMs: 500, ttftMs: 100, queryChainId: null, queryDepth: 0, stopReason: "end_turn",
    } as TapEvent);
    expect(diff).not.toBeNull();
    expect(diff!.inputTokens).toBe(100);
    expect(diff!.outputTokens).toBe(50);
    expect(diff!.costUsd).toBe(0.01);
  });

  it("does NOT accumulate tokens for queryDepth > 0", () => {
    const acc = new TapMetadataAccumulator();
    const diff = acc.process({
      kind: "ApiTelemetry", ts: 1, model: "haiku", costUSD: 0.001,
      inputTokens: 5000, outputTokens: 2000, cachedInputTokens: 0, uncachedInputTokens: 5000,
      durationMs: 200, ttftMs: 50, queryChainId: null, queryDepth: 1, stopReason: "end_turn",
    } as TapEvent);
    expect(diff).not.toBeNull();
    expect(diff!.inputTokens).toBe(0);
    expect(diff!.outputTokens).toBe(0);
    expect(diff!.costUsd).toBe(0);
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

import { describe, it, expect } from "vitest";
import { reduceTapEvent, reduceTapBatch, isCompletionEvent } from "../tapStateReducer";
import type { TapEvent } from "../../types/tapEvents";

describe("reduceTapEvent", () => {
  it("TurnStart → thinking", () => {
    const event: TapEvent = { kind: "TurnStart", ts: 0, model: "opus", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 };
    expect(reduceTapEvent("idle", event)).toBe("thinking");
  });

  it("ThinkingStart → thinking", () => {
    expect(reduceTapEvent("idle", { kind: "ThinkingStart", ts: 0, index: 0 })).toBe("thinking");
  });

  it("ToolCallStart → thinking (still streaming)", () => {
    expect(reduceTapEvent("thinking", { kind: "ToolCallStart", ts: 0, index: 1, toolName: "Bash", toolId: "t1" })).toBe("thinking");
  });

  it("ToolCallStart ExitPlanMode → actionNeeded", () => {
    expect(reduceTapEvent("thinking", { kind: "ToolCallStart", ts: 0, index: 1, toolName: "ExitPlanMode", toolId: "t1" })).toBe("actionNeeded");
  });

  it("TurnEnd tool_use → toolUse", () => {
    expect(reduceTapEvent("thinking", { kind: "TurnEnd", ts: 0, stopReason: "tool_use", outputTokens: 100 })).toBe("toolUse");
  });

  it("TurnEnd tool_use preserves actionNeeded (ExitPlanMode race)", () => {
    expect(reduceTapEvent("actionNeeded", { kind: "TurnEnd", ts: 0, stopReason: "tool_use", outputTokens: 100 })).toBe("actionNeeded");
  });

  it("TurnEnd end_turn → idle", () => {
    expect(reduceTapEvent("thinking", { kind: "TurnEnd", ts: 0, stopReason: "end_turn", outputTokens: 100 })).toBe("idle");
  });

  it("PermissionPromptShown → waitingPermission", () => {
    expect(reduceTapEvent("toolUse", { kind: "PermissionPromptShown", ts: 0, toolName: "Bash" })).toBe("waitingPermission");
  });

  it("PermissionApproved → toolUse", () => {
    expect(reduceTapEvent("waitingPermission", { kind: "PermissionApproved", ts: 0, toolName: "Bash" })).toBe("toolUse");
  });

  it("PermissionRejected → idle", () => {
    expect(reduceTapEvent("waitingPermission", { kind: "PermissionRejected", ts: 0 })).toBe("idle");
  });

  it("UserInterruption → interrupted", () => {
    expect(reduceTapEvent("thinking", { kind: "UserInterruption", ts: 0, forToolUse: true })).toBe("interrupted");
  });

  it("interrupted → thinking on UserInput", () => {
    expect(reduceTapEvent("interrupted", { kind: "UserInput", ts: 0, display: "test", sessionId: "s1" })).toBe("thinking");
  });

  it("UserInput → thinking", () => {
    expect(reduceTapEvent("idle", { kind: "UserInput", ts: 0, display: "test", sessionId: "s1" })).toBe("thinking");
  });

  it("SlashCommand → thinking", () => {
    expect(reduceTapEvent("idle", { kind: "SlashCommand", ts: 0, command: "/rj", display: "/rj" })).toBe("thinking");
  });

  it("ConversationMessage result → no state change (dead path removed)", () => {
    expect(reduceTapEvent("toolUse", {
      kind: "ConversationMessage", ts: 0, messageType: "result",
      isSidechain: false, agentId: null, uuid: null, parentUuid: null,
      promptId: null, stopReason: null, toolNames: [], toolAction: null,
      textSnippet: null, cwd: null, hasToolError: false, toolErrorText: null,
    })).toBe("toolUse");
  });

  it("ConversationMessage assistant end_turn → idle", () => {
    expect(reduceTapEvent("thinking", {
      kind: "ConversationMessage", ts: 0, messageType: "assistant",
      isSidechain: false, agentId: null, uuid: null, parentUuid: null,
      promptId: null, stopReason: "end_turn", toolNames: [], toolAction: null,
      textSnippet: "done", cwd: null, hasToolError: false, toolErrorText: null,
    })).toBe("idle");
  });

  it("ConversationMessage assistant tool_use → toolUse", () => {
    expect(reduceTapEvent("thinking", {
      kind: "ConversationMessage", ts: 0, messageType: "assistant",
      isSidechain: false, agentId: null, uuid: null, parentUuid: null,
      promptId: null, stopReason: "tool_use", toolNames: ["Bash"], toolAction: "Bash: ls",
      textSnippet: null, cwd: null, hasToolError: false, toolErrorText: null,
    })).toBe("toolUse");
  });

  it("ConversationMessage with ExitPlanMode → actionNeeded", () => {
    expect(reduceTapEvent("thinking", {
      kind: "ConversationMessage", ts: 0, messageType: "assistant",
      isSidechain: false, agentId: null, uuid: null, parentUuid: null,
      promptId: null, stopReason: null, toolNames: ["ExitPlanMode"], toolAction: null,
      textSnippet: null, cwd: null, hasToolError: false, toolErrorText: null,
    })).toBe("actionNeeded");
  });

  it("informational events don't change state", () => {
    expect(reduceTapEvent("idle", { kind: "ProcessHealth", ts: 0, rss: 100, heapUsed: 50, heapTotal: 60, uptime: 10, cpuPercent: 0 })).toBe("idle");
    expect(reduceTapEvent("thinking", { kind: "ApiTelemetry", ts: 0, model: "opus", costUSD: 0.01, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, durationMs: 100, ttftMs: 50, queryChainId: null, queryDepth: 0, stopReason: null })).toBe("thinking");
  });
});

describe("reduceTapBatch", () => {
  it("folds events in order", () => {
    const events: TapEvent[] = [
      { kind: "TurnStart", ts: 0, model: "opus", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 },
      { kind: "TurnEnd", ts: 1, stopReason: "end_turn", outputTokens: 100 },
    ];
    expect(reduceTapBatch("idle", events)).toBe("idle");
  });

  it("ExitPlanMode + TurnEnd(tool_use) batch → actionNeeded", () => {
    const events: TapEvent[] = [
      { kind: "ToolCallStart", ts: 0, index: 0, toolName: "ExitPlanMode", toolId: "t1" },
      { kind: "TurnEnd", ts: 1, stopReason: "tool_use", outputTokens: 50 },
    ];
    expect(reduceTapBatch("thinking", events)).toBe("actionNeeded");
  });

  it("ExitPlanMode + TurnEnd + UserInterruption → interrupted (escape works)", () => {
    const events: TapEvent[] = [
      { kind: "ToolCallStart", ts: 0, index: 0, toolName: "ExitPlanMode", toolId: "t1" },
      { kind: "TurnEnd", ts: 1, stopReason: "tool_use", outputTokens: 50 },
      { kind: "UserInterruption", ts: 2, forToolUse: false },
    ];
    expect(reduceTapBatch("thinking", events)).toBe("interrupted");
  });

  it("waitingPermission wins if any event triggers it", () => {
    const events: TapEvent[] = [
      { kind: "TurnEnd", ts: 0, stopReason: "tool_use", outputTokens: 100 },
      { kind: "PermissionPromptShown", ts: 1, toolName: "Bash" },
      // Even if later events change state
      { kind: "ToolCallStart", ts: 2, index: 0, toolName: "Bash", toolId: "t1" },
    ];
    expect(reduceTapBatch("idle", events)).toBe("waitingPermission");
  });
});

describe("isCompletionEvent", () => {
  it("TurnEnd end_turn is completion", () => {
    expect(isCompletionEvent({ kind: "TurnEnd", ts: 0, stopReason: "end_turn", outputTokens: 100 })).toBe(true);
  });

  it("TurnEnd tool_use is not completion", () => {
    expect(isCompletionEvent({ kind: "TurnEnd", ts: 0, stopReason: "tool_use", outputTokens: 100 })).toBe(false);
  });

  it("ConversationMessage result is not completion (dead path removed)", () => {
    expect(isCompletionEvent({
      kind: "ConversationMessage", ts: 0, messageType: "result",
      isSidechain: false, agentId: null, uuid: null, parentUuid: null,
      promptId: null, stopReason: null, toolNames: [], toolAction: null,
      textSnippet: null, cwd: null, hasToolError: false, toolErrorText: null,
    })).toBe(false);
  });

  it("ThinkingStart is not completion", () => {
    expect(isCompletionEvent({ kind: "ThinkingStart", ts: 0, index: 0 })).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { reduceTapEvent, reduceTapBatch, isCompletionEvent } from "../tapStateReducer";
import type { TapEvent } from "../../types/tapEvents";

/** Helper to build a ConversationMessage event with defaults. */
function convMsg(overrides: Partial<Extract<TapEvent, { kind: "ConversationMessage" }>>): TapEvent {
  return {
    kind: "ConversationMessage", ts: 0, messageType: "assistant",
    isSidechain: false, agentId: null, uuid: null, parentUuid: null,
    promptId: null, stopReason: null, toolNames: [], toolAction: null,
    textSnippet: null, cwd: null, hasToolError: false, toolErrorText: null,
    ...overrides,
  };
}

describe("reduceTapEvent", () => {
  it("TurnStart → thinking", () => {
    const event: TapEvent = { kind: "TurnStart", ts: 0, model: "opus", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 };
    expect(reduceTapEvent("idle", event)).toBe("thinking");
  });

  it("WorktreeCleared is informational — no state change", () => {
    expect(reduceTapEvent("idle", { kind: "WorktreeCleared", ts: 0 })).toBe("idle");
    expect(reduceTapEvent("thinking", { kind: "WorktreeCleared", ts: 0 })).toBe("thinking");
  });

  it("SystemPromptCapture is informational — no state change", () => {
    expect(reduceTapEvent("thinking", { kind: "SystemPromptCapture", ts: 0, text: "...", model: "opus", messageCount: 1 })).toBe("thinking");
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

  it("TurnEnd tool_use preserves actionNeeded (early-return guard)", () => {
    expect(reduceTapEvent("actionNeeded", { kind: "TurnEnd", ts: 0, stopReason: "tool_use", outputTokens: 100 })).toBe("actionNeeded");
  });

  it("TurnEnd end_turn does NOT transition to idle (SSE has no agentId)", () => {
    expect(reduceTapEvent("thinking", { kind: "TurnEnd", ts: 0, stopReason: "end_turn", outputTokens: 100 })).toBe("thinking");
    expect(reduceTapEvent("toolUse", { kind: "TurnEnd", ts: 0, stopReason: "end_turn", outputTokens: 100 })).toBe("toolUse");
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
    expect(reduceTapEvent("toolUse", convMsg({ messageType: "result" }))).toBe("toolUse");
  });

  // ── ConversationMessage: main agent (isSidechain=false) ──

  it("ConversationMessage assistant end_turn → idle (main agent)", () => {
    expect(reduceTapEvent("thinking", convMsg({ stopReason: "end_turn" }))).toBe("idle");
  });

  it("ConversationMessage assistant tool_use → toolUse (main agent)", () => {
    expect(reduceTapEvent("thinking", convMsg({
      stopReason: "tool_use", toolNames: ["Bash"], toolAction: "Bash: ls",
    }))).toBe("toolUse");
  });

  it("ConversationMessage with ExitPlanMode → actionNeeded", () => {
    expect(reduceTapEvent("thinking", convMsg({ toolNames: ["ExitPlanMode"] }))).toBe("actionNeeded");
  });

  it("ConversationMessage user → thinking", () => {
    expect(reduceTapEvent("idle", convMsg({ messageType: "user" }))).toBe("thinking");
  });

  // ── ConversationMessage: sidechain (isSidechain=true) — no state change ──

  it("ConversationMessage sidechain assistant end_turn → no state change", () => {
    expect(reduceTapEvent("actionNeeded", convMsg({ isSidechain: true, agentId: "a1", stopReason: "end_turn" }))).toBe("actionNeeded");
    expect(reduceTapEvent("thinking", convMsg({ isSidechain: true, agentId: "a1", stopReason: "end_turn" }))).toBe("thinking");
    expect(reduceTapEvent("toolUse", convMsg({ isSidechain: true, agentId: "a1", stopReason: "end_turn" }))).toBe("toolUse");
  });

  it("ConversationMessage sidechain assistant tool_use → no state change", () => {
    expect(reduceTapEvent("actionNeeded", convMsg({ isSidechain: true, agentId: "a1", stopReason: "tool_use", toolNames: ["Read"] }))).toBe("actionNeeded");
  });

  it("ConversationMessage sidechain assistant with ExitPlanMode → no state change", () => {
    // Subagents cannot call ExitPlanMode, but even if they did, it should not affect parent state
    expect(reduceTapEvent("thinking", convMsg({ isSidechain: true, agentId: "a1", toolNames: ["ExitPlanMode"] }))).toBe("thinking");
  });

  it("ConversationMessage sidechain user → no state change", () => {
    expect(reduceTapEvent("toolUse", convMsg({ messageType: "user", isSidechain: true, agentId: "a1" }))).toBe("toolUse");
  });

  it("ConversationMessage(assistant, tool_use) preserves actionNeeded from ToolCallStart", () => {
    // ToolCallStart(ExitPlanMode) sets actionNeeded; subsequent ConversationMessage
    // with tool_use stop reason must not clobber it back to toolUse.
    expect(reduceTapEvent("actionNeeded", {
      kind: "ConversationMessage", ts: 0, messageType: "assistant",
      isSidechain: false, agentId: null, uuid: null, parentUuid: null,
      promptId: null, stopReason: "tool_use", toolNames: ["Bash"], toolAction: "Bash: ls",
      textSnippet: null, cwd: null, hasToolError: false, toolErrorText: null,
    })).toBe("actionNeeded");
  });

  // Sticky actionNeeded guard tests: all non-user events preserve actionNeeded
  it("TurnEnd(end_turn) when actionNeeded → actionNeeded (sticky guard)", () => {
    expect(reduceTapEvent("actionNeeded", { kind: "TurnEnd", ts: 0, stopReason: "end_turn", outputTokens: 100 })).toBe("actionNeeded");
  });

  it("TurnStart when actionNeeded → actionNeeded (sticky guard)", () => {
    expect(reduceTapEvent("actionNeeded", { kind: "TurnStart", ts: 0, model: "opus", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 })).toBe("actionNeeded");
  });

  it("ThinkingStart when actionNeeded → actionNeeded (sticky guard)", () => {
    expect(reduceTapEvent("actionNeeded", { kind: "ThinkingStart", ts: 0, index: 0 })).toBe("actionNeeded");
  });

  it("TextStart when actionNeeded → actionNeeded (sticky guard)", () => {
    // TextStart is thinking in the main switch, but sticky guard preserves actionNeeded
    expect(reduceTapEvent("actionNeeded", { kind: "TextStart", ts: 0, index: 0 })).toBe("actionNeeded");
  });

  it("ConversationMessage(user) when actionNeeded → actionNeeded (sticky guard)", () => {
    expect(reduceTapEvent("actionNeeded", {
      kind: "ConversationMessage", ts: 0, messageType: "user",
      isSidechain: false, agentId: null, uuid: null, parentUuid: null,
      promptId: null, stopReason: null, toolNames: [], toolAction: null,
      textSnippet: null, cwd: null, hasToolError: false, toolErrorText: null,
    })).toBe("actionNeeded");
  });

  it("ToolCallStart(non-ExitPlanMode) when actionNeeded → actionNeeded (sticky guard)", () => {
    expect(reduceTapEvent("actionNeeded", { kind: "ToolCallStart", ts: 0, index: 1, toolName: "Bash", toolId: "t1" })).toBe("actionNeeded");
  });

  // Sticky guard exit: user actions clear actionNeeded
  it("UserInput when actionNeeded → thinking (user approved plan)", () => {
    expect(reduceTapEvent("actionNeeded", { kind: "UserInput", ts: 0, display: "yes", sessionId: "s1" })).toBe("thinking");
  });

  it("SlashCommand when actionNeeded → thinking (user ran command)", () => {
    expect(reduceTapEvent("actionNeeded", { kind: "SlashCommand", ts: 0, command: "/rj", display: "/rj" })).toBe("thinking");
  });

  it("UserInterruption when actionNeeded → interrupted (user cancelled plan)", () => {
    expect(reduceTapEvent("actionNeeded", { kind: "UserInterruption", ts: 0, forToolUse: false })).toBe("interrupted");
  });

  it("PermissionPromptShown when actionNeeded → waitingPermission (edge case)", () => {
    expect(reduceTapEvent("actionNeeded", { kind: "PermissionPromptShown", ts: 0, toolName: "Bash" })).toBe("waitingPermission");
  });

  it("informational events preserve actionNeeded (default branch)", () => {
    expect(reduceTapEvent("actionNeeded", { kind: "ApiTelemetry", ts: 0, model: "opus", costUSD: 0.01, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, durationMs: 100, ttftMs: 50, queryChainId: null, queryDepth: 0, stopReason: null })).toBe("actionNeeded");
  });

  it("content-based plan detection: numbered list in textSnippet → actionNeeded", () => {
    // Mirrors old terminal buffer scan for "> 1." — detects plan content
    // from the assistant's ConversationMessage text.
    expect(reduceTapEvent("thinking", {
      kind: "ConversationMessage", ts: 0, messageType: "assistant",
      isSidechain: false, agentId: null, uuid: null, parentUuid: null,
      promptId: null, stopReason: "tool_use", toolNames: [], toolAction: null,
      textSnippet: "Here is my plan:\n\n1. Read the file\n2. Make changes\n3. Run tests",
      cwd: null, hasToolError: false, toolErrorText: null,
    })).toBe("actionNeeded");
  });

  it("content-based plan detection requires both 1. and 2. patterns", () => {
    // Single numbered item is not a plan (avoids false positives)
    expect(reduceTapEvent("thinking", {
      kind: "ConversationMessage", ts: 0, messageType: "assistant",
      isSidechain: false, agentId: null, uuid: null, parentUuid: null,
      promptId: null, stopReason: "tool_use", toolNames: [], toolAction: null,
      textSnippet: "Step 1. Do something",
      cwd: null, hasToolError: false, toolErrorText: null,
    })).toBe("toolUse");
  });

  it("content-based plan detection requires tool_use stop reason", () => {
    // end_turn with numbered list is not a plan (normal conversation)
    expect(reduceTapEvent("thinking", {
      kind: "ConversationMessage", ts: 0, messageType: "assistant",
      isSidechain: false, agentId: null, uuid: null, parentUuid: null,
      promptId: null, stopReason: "end_turn", toolNames: [], toolAction: null,
      textSnippet: "Here are the steps:\n1. First thing\n2. Second thing",
      cwd: null, hasToolError: false, toolErrorText: null,
    })).toBe("idle");
  });

  it("IdlePrompt → idle", () => {
    expect(reduceTapEvent("thinking", { kind: "IdlePrompt", ts: 0 })).toBe("idle");
  });

  it("IdlePrompt → idle from toolUse", () => {
    expect(reduceTapEvent("toolUse", { kind: "IdlePrompt", ts: 0 })).toBe("idle");
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
      convMsg({ stopReason: "end_turn" }),
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

  it("IdlePrompt in batch drives state back to idle", () => {
    const events: TapEvent[] = [
      { kind: "ThinkingStart", ts: 0, index: 0 },
      { kind: "IdlePrompt", ts: 1 },
    ];
    expect(reduceTapBatch("idle", events)).toBe("idle");
  });
});

describe("isCompletionEvent", () => {
  it("ConversationMessage assistant end_turn !sidechain is completion", () => {
    expect(isCompletionEvent(convMsg({ stopReason: "end_turn" }))).toBe(true);
  });

  it("ConversationMessage sidechain end_turn is NOT completion", () => {
    expect(isCompletionEvent(convMsg({ isSidechain: true, agentId: "a1", stopReason: "end_turn" }))).toBe(false);
  });

  it("TurnEnd end_turn is NOT completion (SSE lacks agentId)", () => {
    expect(isCompletionEvent({ kind: "TurnEnd", ts: 0, stopReason: "end_turn", outputTokens: 100 })).toBe(false);
  });

  it("TurnEnd tool_use is not completion", () => {
    expect(isCompletionEvent({ kind: "TurnEnd", ts: 0, stopReason: "tool_use", outputTokens: 100 })).toBe(false);
  });

  it("ConversationMessage result is not completion (dead path removed)", () => {
    expect(isCompletionEvent(convMsg({ messageType: "result" }))).toBe(false);
  });

  it("ThinkingStart is not completion", () => {
    expect(isCompletionEvent({ kind: "ThinkingStart", ts: 0, index: 0 })).toBe(false);
  });

  it("StatusLineUpdate is informational — no state change", () => {
    expect(reduceTapEvent("thinking", {
      kind: "StatusLineUpdate", ts: 0,
      sessionId: "", cwd: "", modelId: "", modelDisplayName: "",
      cliVersion: "", outputStyle: "",
      totalCostUsd: 0, totalDurationMs: 0, totalApiDurationMs: 0,
      totalLinesAdded: 0, totalLinesRemoved: 0,
      totalInputTokens: 0, totalOutputTokens: 0,
      contextWindowSize: 0,
      currentInputTokens: 0, currentOutputTokens: 0,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      contextUsedPercent: 0, contextRemainingPercent: 0,
      exceeds200kTokens: false,
      fiveHourUsedPercent: 0, fiveHourResetsAt: 0,
      sevenDayUsedPercent: 0, sevenDayResetsAt: 0,
      vimMode: "",
    })).toBe("thinking");
  });

  it("IdlePrompt is completion", () => {
    expect(isCompletionEvent({ kind: "IdlePrompt", ts: 0 })).toBe(true);
  });
  });
});

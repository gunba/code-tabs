import { describe, it, expect } from "vitest";
import { reduceTapEvent, reduceTapBatch, isCompletionEvent } from "../tapStateReducer";
import type { TapEvent } from "../../types/tapEvents";
import type { SessionState } from "../../types/session";

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

  it("ToolCallStart AskUserQuestion → actionNeeded", () => {
    expect(reduceTapEvent("thinking", { kind: "ToolCallStart", ts: 0, index: 1, toolName: "AskUserQuestion", toolId: "t1" })).toBe("actionNeeded");
  });

  it("TurnEnd tool_use → toolUse", () => {
    expect(reduceTapEvent("thinking", { kind: "TurnEnd", ts: 0, stopReason: "tool_use", outputTokens: 100 })).toBe("toolUse");
  });

  it("TurnEnd tool_use preserves actionNeeded (early-return guard)", () => {
    expect(reduceTapEvent("actionNeeded", { kind: "TurnEnd", ts: 0, stopReason: "tool_use", outputTokens: 100 })).toBe("actionNeeded");
  });

  it("TurnEnd end_turn → idle", () => {
    expect(reduceTapEvent("thinking", { kind: "TurnEnd", ts: 0, stopReason: "end_turn", outputTokens: 100 })).toBe("idle");
    expect(reduceTapEvent("toolUse", { kind: "TurnEnd", ts: 0, stopReason: "end_turn", outputTokens: 100 })).toBe("idle");
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

  it("ConversationMessage with ExitPlanMode → no longer sets actionNeeded (plan detection moved to ToolCallStart)", () => {
    // ConversationMessage arrives async from stringify hook and can race with UserInput.
    // Plan detection now relies solely on ToolCallStart(ExitPlanMode) which fires during SSE.
    // stopReason is null → falls through to state passthrough.
    expect(reduceTapEvent("thinking", convMsg({ toolNames: ["ExitPlanMode"] }))).toBe("thinking");
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

  it("TurnStart when actionNeeded → thinking (bug 003 fallback: agent continued after user answered)", () => {
    // Bug 003: AskUserQuestion answers don't fire ConversationMessage(user) or UserInput.
    // TurnStart is the fallback clearing event. Risk: background subagent TurnStart
    // (no agentId field) may prematurely clear — cosmetic, not functional.
    expect(reduceTapEvent("actionNeeded", { kind: "TurnStart", ts: 0, model: "opus", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 })).toBe("thinking");
  });

  it("ThinkingStart when actionNeeded → actionNeeded (sticky guard)", () => {
    expect(reduceTapEvent("actionNeeded", { kind: "ThinkingStart", ts: 0, index: 0 })).toBe("actionNeeded");
  });

  it("TextStart when actionNeeded → actionNeeded (sticky guard)", () => {
    // TextStart is thinking in the main switch, but sticky guard preserves actionNeeded
    expect(reduceTapEvent("actionNeeded", { kind: "TextStart", ts: 0, index: 0 })).toBe("actionNeeded");
  });

  it("ConversationMessage(user, !isSidechain) when actionNeeded → thinking (plan approval clears guard)", () => {
    expect(reduceTapEvent("actionNeeded", {
      kind: "ConversationMessage", ts: 0, messageType: "user",
      isSidechain: false, agentId: null, uuid: null, parentUuid: null,
      promptId: null, stopReason: null, toolNames: [], toolAction: null,
      textSnippet: null, cwd: null, hasToolError: false, toolErrorText: null,
    })).toBe("thinking");
  });

  it("ConversationMessage(user, isSidechain) when actionNeeded → actionNeeded (subagent doesn't clear guard)", () => {
    expect(reduceTapEvent("actionNeeded", {
      kind: "ConversationMessage", ts: 0, messageType: "user",
      isSidechain: true, agentId: "sub-1", uuid: null, parentUuid: null,
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

  // Bug 003: ToolResult clears actionNeeded for interactive tools only
  it("ToolResult(AskUserQuestion) when actionNeeded → thinking (bug 003 primary)", () => {
    expect(reduceTapEvent("actionNeeded", { kind: "ToolResult", ts: 0, toolName: "AskUserQuestion", durationMs: 5000, toolResultSizeBytes: 50, error: null })).toBe("thinking");
  });

  it("ToolResult(ExitPlanMode) when actionNeeded → thinking (bug 003 primary)", () => {
    expect(reduceTapEvent("actionNeeded", { kind: "ToolResult", ts: 0, toolName: "ExitPlanMode", durationMs: 1000, toolResultSizeBytes: 20, error: null })).toBe("thinking");
  });

  it("ToolResult(Bash) when actionNeeded → actionNeeded (non-interactive tool, no clear)", () => {
    expect(reduceTapEvent("actionNeeded", { kind: "ToolResult", ts: 0, toolName: "Bash", durationMs: 100, toolResultSizeBytes: 500, error: null })).toBe("actionNeeded");
  });

  it("informational events preserve actionNeeded (default branch)", () => {
    expect(reduceTapEvent("actionNeeded", { kind: "ApiTelemetry", ts: 0, model: "opus", costUSD: 0.01, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, durationMs: 100, ttftMs: 50, queryChainId: null, queryDepth: 0, stopReason: null })).toBe("actionNeeded");
  });

  it("content-based plan detection removed: numbered list in textSnippet → toolUse (not actionNeeded)", () => {
    // Content-based detection was removed because ConversationMessage fires async and
    // can arrive after UserInput, re-setting actionNeeded while the agent is already working.
    // tool_use stop reason → toolUse (normal path).
    expect(reduceTapEvent("thinking", {
      kind: "ConversationMessage", ts: 0, messageType: "assistant",
      isSidechain: false, agentId: null, uuid: null, parentUuid: null,
      promptId: null, stopReason: "tool_use", toolNames: [], toolAction: null,
      textSnippet: "Here is my plan:\n\n1. Read the file\n2. Make changes\n3. Run tests",
      cwd: null, hasToolError: false, toolErrorText: null,
    })).toBe("toolUse");
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

  it("TurnDuration from toolUse → idle", () => {
    expect(reduceTapEvent("toolUse", { kind: "TurnDuration", ts: 0, durationMs: 10000, messageCount: 5 })).toBe("idle");
  });

  it("TurnDuration from thinking → idle", () => {
    expect(reduceTapEvent("thinking", { kind: "TurnDuration", ts: 0, durationMs: 10000, messageCount: 5 })).toBe("idle");
  });

  it("TurnDuration from idle → idle (no change)", () => {
    expect(reduceTapEvent("idle", { kind: "TurnDuration", ts: 0, durationMs: 10000, messageCount: 5 })).toBe("idle");
  });

  it("TurnDuration from waitingPermission → waitingPermission (preserved)", () => {
    expect(reduceTapEvent("waitingPermission", { kind: "TurnDuration", ts: 0, durationMs: 10000, messageCount: 5 })).toBe("waitingPermission");
  });

  it("TurnDuration from actionNeeded → actionNeeded (sticky guard)", () => {
    expect(reduceTapEvent("actionNeeded", { kind: "TurnDuration", ts: 0, durationMs: 10000, messageCount: 5 })).toBe("actionNeeded");
  });

  it("informational events don't change state", () => {
    expect(reduceTapEvent("idle", { kind: "ProcessHealth", ts: 0, rss: 100, heapUsed: 50, heapTotal: 60, uptime: 10, cpuPercent: 0 })).toBe("idle");
    expect(reduceTapEvent("thinking", { kind: "ApiTelemetry", ts: 0, model: "opus", costUSD: 0.01, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, durationMs: 100, ttftMs: 50, queryChainId: null, queryDepth: 0, stopReason: null })).toBe("thinking");
  });

  it("SkillInvocation does not change state", () => {
    expect(reduceTapEvent("thinking", { kind: "SkillInvocation", ts: 0, skill: "commit", success: true, allowedTools: [] })).toBe("thinking");
    expect(reduceTapEvent("idle", { kind: "SkillInvocation", ts: 0, skill: "review", success: false, allowedTools: ["Read"] })).toBe("idle");
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

  it("AskUserQuestion + TurnEnd(tool_use) batch → actionNeeded", () => {
    const events: TapEvent[] = [
      { kind: "ToolCallStart", ts: 0, index: 0, toolName: "AskUserQuestion", toolId: "t1" },
      { kind: "TurnEnd", ts: 1, stopReason: "tool_use", outputTokens: 50 },
    ];
    expect(reduceTapBatch("thinking", events)).toBe("actionNeeded");
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

  it("actionNeeded + TurnStart + ConversationMessage(user) batch → thinking (plan approval)", () => {
    const events: TapEvent[] = [
      { kind: "TurnStart", ts: 0, model: "opus", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 },
      convMsg({ messageType: "user" }),
    ];
    expect(reduceTapBatch("actionNeeded", events)).toBe("thinking");
  });

  it("PermissionPromptShown + TurnDuration in same batch → waitingPermission wins", () => {
    const events: TapEvent[] = [
      { kind: "PermissionPromptShown", ts: 0, toolName: "Bash" },
      { kind: "TurnDuration", ts: 1, durationMs: 10000, messageCount: 5 },
    ];
    expect(reduceTapBatch("toolUse", events)).toBe("waitingPermission");
  });
});

// ── Event sequence replays ──
// Full event sequences from real bugs, replayed step-by-step through reduceTapEvent.
// Each sequence documents what state should be at every step.

describe("sequence replays", () => {
  it("001: AskUserQuestion actionNeeded survives async ConversationMessage", () => {
    // Agent calls AskUserQuestion during plan mode. The stringify hook fires a
    // ConversationMessage(assistant, tool_use) ~4s after ToolCallStart already
    // set actionNeeded. Without the sticky guard, this clobbers actionNeeded → toolUse
    // and the tab appears active while actually waiting for user input.
    const steps: Array<{ event: TapEvent; expected: string }> = [
      // Agent is doing tool work, turn ends with tool_use
      { event: { kind: "TurnStart", ts: 1, model: "opus", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 }, expected: "thinking" },
      // Agent calls AskUserQuestion → actionNeeded
      { event: { kind: "ToolCallStart", ts: 2, index: 0, toolName: "AskUserQuestion", toolId: "t1" }, expected: "actionNeeded" },
      // SSE turn ends with tool_use — sticky guard preserves
      { event: { kind: "TurnEnd", ts: 3, stopReason: "tool_use", outputTokens: 50 }, expected: "actionNeeded" },
      // Async stringify hook fires ConversationMessage — was the bug: clobbered to toolUse
      { event: convMsg({ stopReason: "tool_use", toolNames: ["AskUserQuestion"], toolAction: "AskUserQuestion" }), expected: "actionNeeded" },
      // Informational events while waiting — must not disturb
      { event: { kind: "ProcessHealth", ts: 5, rss: 100, heapUsed: 50, heapTotal: 60, uptime: 10, cpuPercent: 0 } as TapEvent, expected: "actionNeeded" },
      // User answers the question → thinking
      { event: convMsg({ messageType: "user" }), expected: "thinking" },
      // New turn starts, agent proceeds
      { event: { kind: "TurnStart", ts: 7, model: "opus", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 }, expected: "thinking" },
      // Agent now calls ExitPlanMode → actionNeeded again
      { event: { kind: "ToolCallStart", ts: 8, index: 0, toolName: "ExitPlanMode", toolId: "t2" }, expected: "actionNeeded" },
      // Async ConversationMessage again — must not clobber
      { event: convMsg({ stopReason: "tool_use", toolNames: ["ExitPlanMode"] }), expected: "actionNeeded" },
      // User approves plan → thinking
      { event: convMsg({ messageType: "user" }), expected: "thinking" },
    ];

    let state: SessionState = "toolUse";
    for (const { event, expected } of steps) {
      state = reduceTapEvent(state, event);
      expect(state, `after ${event.kind}${("toolName" in event) ? `(${event.toolName})` : ""}`).toBe(expected);
    }
  });

  it("002: TurnEnd(end_turn) reaches idle even without ConversationMessage", () => {
    // Agent completes its final turn. The CLI does not always serialize the final
    // assistant message, so ConversationMessage(assistant, end_turn) never arrives.
    // TurnEnd(end_turn) from the SSE stream is the only completion signal.
    //
    // Previously TurnEnd(end_turn) was a no-op (returned state) to avoid subagent
    // false idles. This left the state stuck at "thinking" permanently.
    // Fix: TurnEnd(end_turn) → idle. Subagent false idles are transient — the main
    // agent's next TurnStart immediately corrects them, and tab flash debounce (2s)
    // suppresses the UI notification.
    const steps: Array<{ event: TapEvent; expected: string }> = [
      // Previous turn ended with tool_use
      { event: { kind: "TurnEnd", ts: 1, stopReason: "tool_use", outputTokens: 100 }, expected: "toolUse" },
      // Async ConvMsg(assistant, tool_use) from stringify hook
      { event: convMsg({ stopReason: "tool_use", toolNames: ["Bash"], toolAction: "Bash: ls" }), expected: "toolUse" },
      // Tool result injected as user message → agent will continue
      { event: convMsg({ messageType: "user" }), expected: "thinking" },
      // Agent starts final turn
      { event: { kind: "ApiFetch", ts: 4, url: "", method: "POST", status: null } as TapEvent, expected: "thinking" },
      { event: { kind: "TurnStart", ts: 5, model: "opus", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 }, expected: "thinking" },
      { event: { kind: "TextStart", ts: 6, index: 0 }, expected: "thinking" },
      // Text completes
      { event: { kind: "BlockStop", ts: 7, index: 0 } as TapEvent, expected: "thinking" },
      // TurnEnd(end_turn) → idle (no ConversationMessage follows, this is the only signal)
      { event: { kind: "TurnEnd", ts: 8, stopReason: "end_turn", outputTokens: 200 }, expected: "idle" },
      // Informational events don't disturb idle
      { event: { kind: "ProcessHealth", ts: 9, rss: 100, heapUsed: 50, heapTotal: 60, uptime: 10, cpuPercent: 0 } as TapEvent, expected: "idle" },
    ];

    let state: SessionState = "thinking";
    for (const { event, expected } of steps) {
      state = reduceTapEvent(state, event);
      expect(state, `after ${event.kind}`).toBe(expected);
    }
  });

  it("003: AskUserQuestion actionNeeded clears on ToolResult (no ConversationMessage(user) fires)", () => {
    // Agent calls AskUserQuestion. The user answers, but no ConversationMessage(user)
    // or UserInput fires — the tool result goes directly to the API without being
    // serialized as a standalone conversation message. ToolResult(AskUserQuestion)
    // is the primary clearing event; TurnStart is the fallback.
    const steps: Array<{ event: TapEvent; expected: string }> = [
      // Agent starts turn
      { event: { kind: "TurnStart", ts: 1, model: "opus", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 }, expected: "thinking" },
      // Agent calls AskUserQuestion → actionNeeded
      { event: { kind: "ToolCallStart", ts: 2, index: 0, toolName: "AskUserQuestion", toolId: "t1" }, expected: "actionNeeded" },
      // SSE turn ends with tool_use — sticky guard preserves
      { event: { kind: "TurnEnd", ts: 3, stopReason: "tool_use", outputTokens: 50 }, expected: "actionNeeded" },
      // Async stringify fires ConversationMessage(assistant, tool_use) — preserved
      { event: convMsg({ stopReason: "tool_use", toolNames: ["AskUserQuestion"], toolAction: "AskUserQuestion" }), expected: "actionNeeded" },
      // Informational events while waiting
      { event: { kind: "ProcessHealth", ts: 5, rss: 100, heapUsed: 50, heapTotal: 60, uptime: 10, cpuPercent: 0 } as TapEvent, expected: "actionNeeded" },
      { event: { kind: "ApiTelemetry", ts: 6, model: "opus", costUSD: 0.01, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, durationMs: 100, ttftMs: 50, queryChainId: null, queryDepth: 0, stopReason: null } as TapEvent, expected: "actionNeeded" },
      // User answers — ToolResult fires (primary clearing event)
      { event: { kind: "ToolResult", ts: 7, toolName: "AskUserQuestion", durationMs: 5000, toolResultSizeBytes: 50, error: null } as TapEvent, expected: "thinking" },
      // New turn starts — already thinking, no regression
      { event: { kind: "TurnStart", ts: 8, model: "opus", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 }, expected: "thinking" },
      // Agent completes
      { event: { kind: "TurnEnd", ts: 9, stopReason: "end_turn", outputTokens: 200 }, expected: "idle" },
    ];

    let state: SessionState = "toolUse";
    for (const { event, expected } of steps) {
      state = reduceTapEvent(state, event);
      expect(state, `after ${event.kind}${("toolName" in event) ? `(${event.toolName})` : ""}`).toBe(expected);
    }
  });

  it("003b: AskUserQuestion actionNeeded clears on TurnStart fallback (no ToolResult fires)", () => {
    // Same scenario as 003, but ToolResult does NOT fire for AskUserQuestion.
    // TurnStart is the fallback clearing event.
    const steps: Array<{ event: TapEvent; expected: string }> = [
      { event: { kind: "TurnStart", ts: 1, model: "opus", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 }, expected: "thinking" },
      { event: { kind: "ToolCallStart", ts: 2, index: 0, toolName: "AskUserQuestion", toolId: "t1" }, expected: "actionNeeded" },
      { event: { kind: "TurnEnd", ts: 3, stopReason: "tool_use", outputTokens: 50 }, expected: "actionNeeded" },
      { event: convMsg({ stopReason: "tool_use", toolNames: ["AskUserQuestion"] }), expected: "actionNeeded" },
      { event: { kind: "ProcessHealth", ts: 5, rss: 100, heapUsed: 50, heapTotal: 60, uptime: 10, cpuPercent: 0 } as TapEvent, expected: "actionNeeded" },
      // No ToolResult — user answered but CLI didn't emit rh-telemetry for AskUserQuestion
      // TurnStart is the fallback (agent's next turn started)
      { event: { kind: "TurnStart", ts: 7, model: "opus", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 }, expected: "thinking" },
      { event: { kind: "TurnEnd", ts: 8, stopReason: "end_turn", outputTokens: 200 }, expected: "idle" },
    ];

    let state: SessionState = "toolUse";
    for (const { event, expected } of steps) {
      state = reduceTapEvent(state, event);
      expect(state, `after ${event.kind}`).toBe(expected);
    }
  });

  it("004: Permission prompt during compound Bash command (d2b6535c pattern)", () => {
    // Compound Bash command (cd && git commit) triggers a permission prompt.
    // Multiple auto-approved Bash cycles, then final cycle hits permission.
    // Without value-side notification_type detection in INSTALL_TAPS,
    // PermissionPromptShown never fires and state stays toolUse for minutes.
    const steps: Array<{ event: TapEvent; expected: string }> = [
      // Auto-approved Bash cycle 1
      { event: { kind: "TurnStart", ts: 1, model: "opus", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 }, expected: "thinking" },
      { event: { kind: "ToolCallStart", ts: 2, index: 0, toolName: "Bash", toolId: "t1" }, expected: "thinking" },
      { event: { kind: "TurnEnd", ts: 3, stopReason: "tool_use", outputTokens: 50 }, expected: "toolUse" },
      { event: convMsg({ stopReason: "tool_use", toolNames: ["Bash"], toolAction: "Bash: ls" }), expected: "toolUse" },
      { event: convMsg({ messageType: "user" }), expected: "thinking" },
      // Auto-approved Bash cycle 2
      { event: { kind: "TurnStart", ts: 6, model: "opus", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 }, expected: "thinking" },
      { event: { kind: "ToolCallStart", ts: 7, index: 0, toolName: "Bash", toolId: "t2" }, expected: "thinking" },
      { event: { kind: "TurnEnd", ts: 8, stopReason: "tool_use", outputTokens: 60 }, expected: "toolUse" },
      { event: convMsg({ stopReason: "tool_use", toolNames: ["Bash"], toolAction: "Bash: git status" }), expected: "toolUse" },
      { event: convMsg({ messageType: "user" }), expected: "thinking" },
      // Final cycle: compound Bash command triggers permission prompt
      { event: { kind: "TurnStart", ts: 11, model: "opus", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 }, expected: "thinking" },
      { event: { kind: "ToolCallStart", ts: 12, index: 0, toolName: "Bash", toolId: "t3" }, expected: "thinking" },
      { event: { kind: "TurnEnd", ts: 13, stopReason: "tool_use", outputTokens: 80 }, expected: "toolUse" },
      { event: convMsg({ stopReason: "tool_use", toolNames: ["Bash"], toolAction: "Bash: cd ... && git commit ..." }), expected: "toolUse" },
      // Permission prompt shown (now detected via value-side notification_type)
      { event: { kind: "PermissionPromptShown", ts: 14, toolName: null }, expected: "waitingPermission" },
      // User approves → toolUse
      { event: { kind: "PermissionApproved", ts: 15, toolName: "Bash" }, expected: "toolUse" },
      // Tool result injected as user message
      { event: convMsg({ messageType: "user" }), expected: "thinking" },
      // Agent completes
      { event: { kind: "TurnEnd", ts: 17, stopReason: "end_turn", outputTokens: 200 }, expected: "idle" },
    ];

    let state: SessionState = "idle";
    for (const { event, expected } of steps) {
      state = reduceTapEvent(state, event);
      expect(state, `after ${event.kind}${("toolName" in event) ? `(${event.toolName})` : ""}`).toBe(expected);
    }
  });

  it("005: TurnDuration as independent idle signal (b77703f6 pattern)", () => {
    // Agent finishes work but primary idle signals (TurnEnd(end_turn),
    // ConversationMessage(assistant, end_turn)) don't reach the reducer.
    // Cause unknown — events exist in taps.jsonl but weren't processed.
    // TurnDuration provides an independent recovery path to idle.
    const steps: Array<{ event: TapEvent; expected: string }> = [
      // Bash tool cycles — agent doing work
      { event: { kind: "TurnStart", ts: 1, model: "opus", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 }, expected: "thinking" },
      { event: { kind: "ToolCallStart", ts: 2, index: 0, toolName: "Bash", toolId: "t1" }, expected: "thinking" },
      { event: { kind: "TurnEnd", ts: 3, stopReason: "tool_use", outputTokens: 50 }, expected: "toolUse" },
      { event: convMsg({ stopReason: "tool_use", toolNames: ["Bash"], toolAction: "Bash: git merge" }), expected: "toolUse" },
      { event: convMsg({ messageType: "user" }), expected: "thinking" },
      // Another Bash cycle
      { event: { kind: "TurnStart", ts: 6, model: "opus", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 }, expected: "thinking" },
      { event: { kind: "ToolCallStart", ts: 7, index: 0, toolName: "Bash", toolId: "t2" }, expected: "thinking" },
      { event: { kind: "TurnEnd", ts: 8, stopReason: "tool_use", outputTokens: 60 }, expected: "toolUse" },
      { event: convMsg({ stopReason: "tool_use", toolNames: ["Bash"], toolAction: "Bash: git log" }), expected: "toolUse" },
      // Primary idle signals absent — TurnEnd(end_turn) and ConversationMessage(assistant, end_turn)
      // exist in taps.jsonl but never reached the reducer in the live session.
      // TurnDuration fires as the final event of the completed turn → idle
      { event: { kind: "TurnDuration", ts: 9, durationMs: 524421, messageCount: 277 }, expected: "idle" },
    ];

    let state: SessionState = "idle";
    for (const { event, expected } of steps) {
      state = reduceTapEvent(state, event);
      expect(state, `after ${event.kind}`).toBe(expected);
    }
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

  it("TurnDuration is NOT completion (queued input dispatch uses ConversationMessage/IdlePrompt)", () => {
    expect(isCompletionEvent({ kind: "TurnDuration", ts: 0, durationMs: 10000, messageCount: 5 })).toBe(false);
  });
});

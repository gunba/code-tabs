import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { INSTALL_HOOK, POLL_STATE } from "../inspectorHooks";
import { deriveStateFromPoll } from "../../hooks/useInspectorState";

// Mock @tauri-apps/api/core — allocateInspectorPort calls invoke("check_port_available")
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(true),
}));

import { allocateInspectorPort } from "../inspectorPort";

// The INSTALL_HOOK IIFE uses real globalThis, so tests that check install/idempotency
// must operate on the real globalThis and clean up after themselves.
function cleanupGlobalHook() {
  const g = globalThis as unknown as Record<string, unknown>;
  // Remove stdin handler to prevent listener accumulation across tests.
  // Use globalThis.process to avoid TS2580 in DOM-only tsconfig.
  if (typeof g.__inspectorStdinHandler === "function") {
    try {
      const proc = (globalThis as unknown as { process?: { stdin?: { removeListener(e: string, fn: unknown): void } } }).process;
      proc?.stdin?.removeListener("data", g.__inspectorStdinHandler);
    } catch {}
    delete g.__inspectorStdinHandler;
  }
  delete g.__inspectorInstalled;
  delete g.__inspectorState;
}

describe("INSTALL_HOOK", () => {
  beforeEach(cleanupGlobalHook);
  afterEach(cleanupGlobalHook);

  it("returns 'ok' on first install", () => {
    const fn = new Function(`return ${INSTALL_HOOK}`);
    expect(fn()).toBe("ok");
  });

  it("returns 'already' on second install", () => {
    const fn = new Function(`return ${INSTALL_HOOK}`);
    fn();
    expect(fn()).toBe("already");
  });

  it("sets __inspectorInstalled flag", () => {
    const fn = new Function(`return ${INSTALL_HOOK}`);
    fn();
    const g = globalThis as unknown as Record<string, unknown>;
    expect(g.__inspectorInstalled).toBe(true);
  });

  it("initializes __inspectorState with expected shape", () => {
    const fn = new Function(`return ${INSTALL_HOOK}`);
    fn();
    const g = globalThis as unknown as Record<string, unknown>;
    const state = g.__inspectorState as Record<string, unknown>;
    expect(state).toBeDefined();
    expect(state.n).toBe(0);
    expect(state.sid).toBeNull();
    expect(state.cost).toBe(0);
    expect(state.model).toBeNull();
    expect(state.stop).toBeNull();
    expect(state.tools).toEqual([]);
    expect(state.inTok).toBe(0);
    expect(state.outTok).toBe(0);
    expect(state.events).toEqual([]);
    expect(state.lastEvent).toBeNull();
    // New fields
    expect(state.firstMsg).toBeNull();
    expect(state.lastText).toBeNull();
    expect(state.userPrompt).toBeNull();
    expect(state.permPending).toBe(false);
    expect(state.idleDetected).toBe(false);
    expect(state.toolAction).toBeNull();
    expect(state.inputBuf).toBe("");
    expect(state.inputTs).toBe(0);
    expect(state._sealed).toBe(false);
  });
});

describe("INSTALL_HOOK JSON.stringify interception", () => {
  let savedStringify: typeof JSON.stringify;
  let savedParse: typeof JSON.parse;

  beforeEach(() => {
    savedStringify = JSON.stringify;
    savedParse = JSON.parse;
  });

  // Restore original JSON.stringify/JSON.parse and clean up after each test
  afterEach(() => {
    JSON.stringify = savedStringify;
    JSON.parse = savedParse;
    cleanupGlobalHook();
  });

  function installAndGetState(): Record<string, unknown> {
    // Use real globalThis for JSON.stringify wrapping
    const g = globalThis as unknown as Record<string, unknown>;
    cleanupGlobalHook();
    const fn = new Function(`return ${INSTALL_HOOK}`);
    fn();
    return g.__inspectorState as Record<string, unknown>;
  }

  it("intercepts assistant events", () => {
    const state = installAndGetState();
    const event = {
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Hello" }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    };
    JSON.stringify(event);
    expect(state.n).toBe(1);
    expect(state.model).toBe("claude-opus-4-6");
    expect(state.stop).toBe("end_turn");
    expect(state.inTok).toBe(100);
    expect(state.outTok).toBe(50);
    expect(state.lastEvent).toBe("assistant");
  });

  it("intercepts tool_use events", () => {
    const state = installAndGetState();
    const event = {
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", name: "Read", input: { file_path: "/foo" } },
        ],
        usage: { input_tokens: 50, output_tokens: 25 },
      },
    };
    JSON.stringify(event);
    expect(state.tools).toEqual(["Bash", "Read"]);
    expect(state.stop).toBe("tool_use");
  });

  it("intercepts result events with cost", () => {
    const state = installAndGetState();
    JSON.stringify({ type: "result", total_cost_usd: 0.042 });
    expect(state.cost).toBe(0.042);
    expect(state.stop).toBe("end_turn");
  });

  it("tracks session ID from system events", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "system",
      sessionId: "abc-123",
      permissionMode: "default",
    });
    expect(state.sid).toBe("abc-123");
  });

  it("clears tools and stop on user events", () => {
    const state = installAndGetState();
    // First an assistant event with tools
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Bash", input: {} }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    expect(state.tools).toEqual(["Bash"]);
    // Then a user event
    JSON.stringify({ type: "user", message: { content: "next prompt" } });
    expect(state.tools).toEqual([]);
    expect(state.stop).toBeNull();
  });

  it("accumulates tokens across messages", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "a" }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    });
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "b" }],
        usage: { input_tokens: 200, output_tokens: 100 },
      },
    });
    expect(state.inTok).toBe(300);
    expect(state.outTok).toBe(150);
  });

  it("includes cache_creation_input_tokens in token count", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "x" }],
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200 },
      },
    });
    expect(state.inTok).toBe(300);
  });

  it("maintains ring buffer of max 50 events", () => {
    const state = installAndGetState();
    for (let i = 0; i < 60; i++) {
      JSON.stringify({ type: "user", message: { content: `msg ${i} padding text` } });
    }
    expect((state.events as unknown[]).length).toBe(50);
    expect(state.n).toBe(60);
  });

  it("ignores short strings (< 30 chars)", () => {
    const state = installAndGetState();
    JSON.stringify({ a: 1 }); // Short string
    expect(state.n).toBe(0);
  });

  it("ignores values without type field", () => {
    const state = installAndGetState();
    JSON.stringify({ foo: "bar", data: "some longer padding string here for length" });
    expect(state.n).toBe(0);
  });

  // ── New capture tests ──────────────────────────────────────────────

  it("extracts firstMsg from first user text event", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "What is the meaning of life?" }] },
    });
    expect(state.firstMsg).toBe("What is the meaning of life?");
    // Second user message should not overwrite firstMsg
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "Follow-up question here" }] },
    });
    expect(state.firstMsg).toBe("What is the meaning of life?");
  });

  it("extracts userPrompt from every user text event", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "First prompt" }] },
    });
    expect(state.userPrompt).toBe("First prompt");
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "Second prompt" }] },
    });
    expect(state.userPrompt).toBe("Second prompt");
  });

  it("extracts userPrompt from string content", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "user",
      message: { content: "Plain string prompt here for content" },
    });
    expect(state.userPrompt).toBe("Plain string prompt here for content");
  });

  it("truncates firstMsg and userPrompt to 200 chars", () => {
    const state = installAndGetState();
    const longText = "a".repeat(300);
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: longText }] },
    });
    expect(state.firstMsg).toHaveLength(200);
    expect(state.userPrompt).toHaveLength(200);
  });

  it("does not extract text from tool_result user events", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "abc", content: "result" }] },
    });
    expect(state.firstMsg).toBeNull();
    expect(state.userPrompt).toBeNull();
  });

  it("extracts lastText from assistant text blocks", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [
          { type: "text", text: "First paragraph" },
          { type: "text", text: "Second paragraph with more detail" },
        ],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });
    // Should capture the last text block
    expect(state.lastText).toBe("Second paragraph with more detail");
  });

  it("truncates lastText to 300 chars from the end", () => {
    const state = installAndGetState();
    const longText = "x".repeat(500);
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: longText }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });
    expect(state.lastText).toHaveLength(300);
  });

  it("formats toolAction for Bash tool", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });
    expect(state.toolAction).toBe("Bash: npm test");
  });

  it("formats toolAction for Read tool", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Read", input: { file_path: "/src/main.ts" } }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });
    expect(state.toolAction).toBe("Read: /src/main.ts");
  });

  it("formats toolAction for Edit tool", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Edit", input: { file_path: "/src/app.tsx" } }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });
    expect(state.toolAction).toBe("Edit: /src/app.tsx");
  });

  it("formats toolAction for unknown tools using name only", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "CustomTool", input: { data: "test" } }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });
    expect(state.toolAction).toBe("CustomTool");
  });

  it("sets toolAction for Agent tool_use", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", name: "Agent", input: { description: "Search codebase" } },
          { type: "tool_use", name: "Agent", input: { description: "Run tests" } },
        ],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });
    expect(state.toolAction).toBe("Agent: Run tests"); // Last one wins
  });

  it("sets permPending on permission_prompt notification", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "notification",
      notification_type: "permission_prompt",
      padding: "extra text to pass length check",
    });
    expect(state.permPending).toBe(true);
    expect(state.idleDetected).toBe(false);
  });

  it("sets idleDetected on idle_prompt notification", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "notification",
      notification_type: "idle_prompt",
      padding: "extra text to pass length check",
    });
    expect(state.idleDetected).toBe(true);
    expect(state.permPending).toBe(false);
  });

  it("detects notification_type on objects without type field", () => {
    const state = installAndGetState();
    JSON.stringify({
      notification_type: "permission_prompt",
      data: "some extra padding text here to pass length check",
    });
    expect(state.permPending).toBe(true);
  });

  it("captures UserPromptSubmit hook event", () => {
    const state = installAndGetState();
    JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "Hello Claude, please help me with this task",
    });
    expect(state.userPrompt).toBe("Hello Claude, please help me with this task");
    expect(state.slashCmd).toBeNull();
  });

  it("sets slashCmd when UserPromptSubmit starts with /", () => {
    const state = installAndGetState();
    JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "/rj",
    });
    expect(state.userPrompt).toBe("/rj");
    expect(state.slashCmd).toBe("/rj");
  });

  it("extracts only the command name from slashCmd (strips args)", () => {
    const state = installAndGetState();
    JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "/r --verbose some extra text",
    });
    expect(state.slashCmd).toBe("/r");
  });

  it("slashCmd survives overwrite by user event expanded text", () => {
    const state = installAndGetState();
    // UserPromptSubmit fires first with raw input
    JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "/rj",
    });
    // Then user event fires with expanded command text
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "Review then janitor in sequence..." }] },
    });
    // userPrompt is overwritten, but slashCmd is preserved
    expect(state.userPrompt).toBe("Review then janitor in sequence...");
    expect(state.slashCmd).toBe("/rj");
  });

  it("clears inputBuf on user event", () => {
    const state = installAndGetState();
    // Simulate some typed input
    (state as Record<string, unknown>).inputBuf = "partial input";
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "submitted prompt" }] },
    });
    expect(state.inputBuf).toBe("");
  });

  it("includes txt in ring buffer events for user text", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "Hello world" }] },
    });
    const events = state.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].t).toBe("user");
    expect(events[0].txt).toBe("Hello world");
  });

  it("includes txt in ring buffer events for assistant text", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Here is my response to your question" }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });
    const events = state.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].txt).toBe("Here is my response to your question");
  });

  it("truncates ring buffer txt to 100 chars", () => {
    const state = installAndGetState();
    const longText = "z".repeat(200);
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: longText }] },
    });
    const events = state.events as Array<Record<string, unknown>>;
    expect((events[0].txt as string).length).toBe(100);
  });

  it("includes ta in ring buffer events for tool actions", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Grep", input: { pattern: "TODO" } }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });
    const events = state.events as Array<Record<string, unknown>>;
    expect(events[0].ta).toBe("Grep: TODO");
  });

  it("does not add notification events to ring buffer", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "notification",
      notification_type: "permission_prompt",
      padding: "extra text to pass length check",
    });
    const events = state.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(0);
    // But permPending flag is still set
    expect(state.permPending).toBe(true);
  });

  it("does not add system events to ring buffer", () => {
    const state = installAndGetState();
    JSON.stringify({ type: "system", sessionId: "abc-123", permissionMode: "default" });
    const events = state.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(0);
    // But system event data is still captured
    expect(state.sid).toBe("abc-123");
    expect(state.n).toBe(1);
  });

  it("does not add progress events to ring buffer", () => {
    const state = installAndGetState();
    JSON.stringify({ type: "progress", data: "some progress info with enough padding" });
    const events = state.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(0);
    expect(state.n).toBe(1);
  });

  it("does not update lastEvent for system/progress events", () => {
    const state = installAndGetState();
    // First set a real state-carrying event
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Hello response text here" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    expect(state.lastEvent).toBe("assistant");
    // System event should NOT change lastEvent
    JSON.stringify({ type: "system", sessionId: "abc-123", permissionMode: "default" });
    expect(state.lastEvent).toBe("assistant");
    // Progress event should NOT change lastEvent
    JSON.stringify({ type: "progress", data: "some progress info with enough padding" });
    expect(state.lastEvent).toBe("assistant");
  });

  it("progress events after assistant end_turn do not mask idle in ring buffer", () => {
    const state = installAndGetState();
    // Assistant with end_turn
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Done with the task completely" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    // Stop hook fires system + progress events
    JSON.stringify({ type: "system", stop_hook_summary: true, sessionId: "s1", permissionMode: "default" });
    JSON.stringify({ type: "progress", data: "stop hook running with extra padding text" });

    // Ring buffer should only have the assistant event
    const events = state.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].t).toBe("assistant");
    expect(events[0].sr).toBe("end_turn");
    // lastEvent should still be assistant
    expect(state.lastEvent).toBe("assistant");
  });

});

describe("deriveStateFromPoll", () => {
  const basePoll = {
    n: 1, sid: null, cost: 0, model: null, stop: null as string | null,
    tools: [] as string[], inTok: 0, outTok: 0,
    events: [] as Array<{ t: string; sr?: string; c?: number; txt?: string; ta?: string }>,
    lastEvent: null as string | null,
    firstMsg: null, lastText: null, userPrompt: null,
    permPending: false, idleDetected: false, choiceHint: false,
    promptDetected: false,
    toolAction: null,
    inputBuf: "", inputTs: 0, slashCmd: null as string | null, fetchBypassed: 0, fetchTimeouts: 0, httpsTimeouts: 0,
    subs: [] as Array<{ sid: string; desc: string; st: string; tok: number; act: string | null;
      msgs: Array<{ r: string; x: string; tn?: string }>; lastTs: number }>,
    cwd: null as string | null,
  };

  it("returns waitingPermission when permPending is true", () => {
    expect(deriveStateFromPoll({ ...basePoll, permPending: true }, "thinking")).toBe("waitingPermission");
  });

  it("returns idle when idleDetected is true", () => {
    expect(deriveStateFromPoll({ ...basePoll, idleDetected: true }, "thinking")).toBe("idle");
  });

  it("permPending overrides idleDetected", () => {
    expect(deriveStateFromPoll({ ...basePoll, permPending: true, idleDetected: true }, "thinking")).toBe("waitingPermission");
  });

  it("returns toolUse from stop_reason", () => {
    expect(deriveStateFromPoll({ ...basePoll, stop: "tool_use" }, "idle")).toBe("toolUse");
  });

  it("returns idle from end_turn stop_reason", () => {
    expect(deriveStateFromPoll({ ...basePoll, stop: "end_turn" }, "thinking")).toBe("idle");
  });

  it("returns thinking from user lastEvent with null stop", () => {
    expect(deriveStateFromPoll({ ...basePoll, stop: null, lastEvent: "user" }, "idle")).toBe("thinking");
  });

  it("returns idle from result lastEvent", () => {
    expect(deriveStateFromPoll({ ...basePoll, lastEvent: "result" }, "thinking")).toBe("idle");
  });

  it("keeps current state when no signals", () => {
    expect(deriveStateFromPoll({ ...basePoll, n: 0 }, "toolUse")).toBe("toolUse");
  });

  it("derives from events when available", () => {
    const poll = { ...basePoll, events: [{ t: "user" }, { t: "assistant", sr: "tool_use" }] };
    expect(deriveStateFromPoll(poll, "idle")).toBe("toolUse");
  });

  it("uses last event in array for state derivation", () => {
    const poll = { ...basePoll, events: [{ t: "assistant", sr: "tool_use" }, { t: "result", c: 0.01 }] };
    expect(deriveStateFromPoll(poll, "toolUse")).toBe("idle");
  });

  it("assistant without stop_reason means still thinking", () => {
    const poll = { ...basePoll, events: [{ t: "assistant" }] };
    expect(deriveStateFromPoll(poll, "idle")).toBe("thinking");
  });

  it("notification flags override event-derived state", () => {
    const poll = { ...basePoll, events: [{ t: "assistant", sr: "tool_use" }], permPending: true };
    expect(deriveStateFromPoll(poll, "idle")).toBe("waitingPermission");
  });

  it("returns idle for unknown stop_reason like max_tokens", () => {
    expect(deriveStateFromPoll({ ...basePoll, stop: "max_tokens" }, "thinking")).toBe("idle");
  });

  it("ExitPlanMode refines toolUse to actionNeeded", () => {
    expect(deriveStateFromPoll({ ...basePoll, stop: "tool_use", tools: ["ExitPlanMode"] }, "idle")).toBe("actionNeeded");
  });

  it("choiceHint refines idle to actionNeeded", () => {
    expect(deriveStateFromPoll({ ...basePoll, stop: "end_turn", choiceHint: true }, "thinking")).toBe("actionNeeded");
  });

  it("Bash tool_use stays toolUse (not actionNeeded)", () => {
    expect(deriveStateFromPoll({ ...basePoll, stop: "tool_use", tools: ["Bash"] }, "idle")).toBe("toolUse");
  });

  it("idleDetected + choiceHint -> actionNeeded (choiceHint refines after idleDetected)", () => {
    expect(deriveStateFromPoll({ ...basePoll, idleDetected: true, choiceHint: true }, "thinking")).toBe("actionNeeded");
  });

  it("permPending overrides actionNeeded from ExitPlanMode -> waitingPermission", () => {
    expect(deriveStateFromPoll({ ...basePoll, stop: "tool_use", tools: ["ExitPlanMode"], permPending: true }, "idle")).toBe("waitingPermission");
  });

  it("ExitPlanMode via events (not persisted stop) -> actionNeeded", () => {
    expect(deriveStateFromPoll({
      ...basePoll, tools: ["ExitPlanMode"],
      events: [{ t: "assistant", sr: "tool_use" }],
    }, "idle")).toBe("actionNeeded");
  });

  it("choiceHint without idle state has no effect (toolUse stays toolUse)", () => {
    expect(deriveStateFromPoll({ ...basePoll, stop: "tool_use", choiceHint: true }, "idle")).toBe("toolUse");
  });

  it("idleDetected alone (no choiceHint) -> idle, not actionNeeded", () => {
    expect(deriveStateFromPoll({ ...basePoll, idleDetected: true, choiceHint: false }, "thinking")).toBe("idle");
  });

  it("ExitPlanMode + idleDetected -> idle (idleDetected overrides actionNeeded)", () => {
    expect(deriveStateFromPoll({
      ...basePoll, stop: "tool_use", tools: ["ExitPlanMode"], idleDetected: true,
    }, "idle")).toBe("idle");
  });

  it("ExitPlanMode + idleDetected + choiceHint -> actionNeeded", () => {
    expect(deriveStateFromPoll({
      ...basePoll, stop: "tool_use", tools: ["ExitPlanMode"], idleDetected: true, choiceHint: true,
    }, "idle")).toBe("actionNeeded");
  });

  it("permPending overrides choiceHint actionNeeded -> waitingPermission", () => {
    expect(deriveStateFromPoll({
      ...basePoll, stop: "end_turn", choiceHint: true, permPending: true,
    }, "idle")).toBe("waitingPermission");
  });

  it("promptDetected forces thinking -> idle when no events", () => {
    expect(deriveStateFromPoll({ ...basePoll, promptDetected: true }, "thinking")).toBe("idle");
  });

  it("promptDetected forces toolUse -> idle when no events", () => {
    expect(deriveStateFromPoll({ ...basePoll, stop: null, promptDetected: true }, "toolUse")).toBe("idle");
  });

  it("promptDetected does not change idle state", () => {
    expect(deriveStateFromPoll({ ...basePoll, stop: "end_turn", promptDetected: true }, "idle")).toBe("idle");
  });

  it("promptDetected + choiceHint -> actionNeeded (prompt forces idle, choiceHint refines)", () => {
    expect(deriveStateFromPoll({
      ...basePoll, promptDetected: true, choiceHint: true,
    }, "thinking")).toBe("actionNeeded");
  });

  it("permPending overrides promptDetected -> waitingPermission", () => {
    expect(deriveStateFromPoll({
      ...basePoll, promptDetected: true, permPending: true,
    }, "thinking")).toBe("waitingPermission");
  });

  it("events take precedence over promptDetected (assistant still generating)", () => {
    expect(deriveStateFromPoll({
      ...basePoll, events: [{ t: "assistant" }], promptDetected: true,
    }, "idle")).toBe("thinking");
  });
});

describe("POLL_STATE", () => {
  afterEach(cleanupGlobalHook);

  it("returns null when no state installed", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.__inspectorState;
    const fn = new Function(`return ${POLL_STATE}`);
    expect(fn()).toBeNull();
  });

  it("returns state and drains events", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__inspectorState = {
      n: 5, sid: "test-123", cost: 0.01, model: "claude-opus-4-6",
      stop: "end_turn", tools: ["Bash"], inTok: 1000, outTok: 500,
      events: [{ t: "assistant", sr: "end_turn" }, { t: "user" }],
      lastEvent: "user", firstMsg: "Hello", lastText: "Response text",
      userPrompt: "Hello", permPending: false, idleDetected: false,
      toolAction: "Bash: ls", inputBuf: "partial", inputTs: 12345,
      subs: [], pendingDescs: [], _sealed: false,
    };
    const fn = new Function(`return ${POLL_STATE}`);
    const result = fn() as Record<string, unknown>;
    expect(result.n).toBe(5);
    expect(result.sid).toBe("test-123");
    expect(result.events).toHaveLength(2);
    expect((g.__inspectorState as Record<string, unknown[]>).events).toHaveLength(0);
  });

  it("drains slashCmd after poll", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__inspectorState = {
      n: 1, sid: null, cost: 0, model: null, stop: null,
      tools: [], inTok: 0, outTok: 0, events: [], lastEvent: null,
      firstMsg: null, lastText: null, userPrompt: "/rj",
      permPending: false, idleDetected: false, toolAction: null,
      inputBuf: "", inputTs: 0, pendingDescs: [], subs: [],
      slashCmd: "/rj", _sealed: false,
    };
    const fn = new Function(`return ${POLL_STATE}`);
    const result = fn() as Record<string, unknown>;
    expect(result.slashCmd).toBe("/rj");
    const stateObj = g.__inspectorState as Record<string, unknown>;
    expect(stateObj.slashCmd).toBeNull();
  });

  it("preserves permPending after poll (reset only by user event in INSTALL_HOOK)", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__inspectorState = {
      n: 1, sid: null, cost: 0, model: null, stop: null,
      tools: [], inTok: 0, outTok: 0, events: [], lastEvent: null,
      firstMsg: null, lastText: null, userPrompt: null,
      permPending: true, idleDetected: false, toolAction: null,
      inputBuf: "", inputTs: 0, pendingDescs: [], subs: [],
      _sealed: false,
    };
    const fn = new Function(`return ${POLL_STATE}`);
    const result = fn() as Record<string, unknown>;
    expect(result.permPending).toBe(true);
    const stateObj = g.__inspectorState as Record<string, unknown>;
    expect(stateObj.permPending).toBe(true);
  });
});

describe("allocateInspectorPort", () => {
  it("returns sequential ports (wraps at boundary)", async () => {
    const p1 = await allocateInspectorPort();
    const p2 = await allocateInspectorPort();
    // Ports are sequential, but wrap from 6499 -> 6400
    if (p1 === 6499) {
      expect(p2).toBe(6400);
    } else {
      expect(p2).toBe(p1 + 1);
    }
  });
});

// ── Subagent tracking tests ──────────────────────────────────────────

describe("INSTALL_HOOK subagent tracking", () => {
  let savedStringify: typeof JSON.stringify;
  let savedParse: typeof JSON.parse;

  beforeEach(() => {
    savedStringify = JSON.stringify;
    savedParse = JSON.parse;
  });

  afterEach(() => {
    JSON.stringify = savedStringify;
    JSON.parse = savedParse;
    cleanupGlobalHook();
  });

  function installAndGetState(): Record<string, unknown> {
    const g = globalThis as unknown as Record<string, unknown>;
    cleanupGlobalHook();
    const fn = new Function(`return ${INSTALL_HOOK}`);
    fn();
    return g.__inspectorState as Record<string, unknown>;
  }

  /** Helper: emit a main system event */
  function emitMainSystem(sid = "main-sid-1") {
    JSON.stringify({ type: "system", sessionId: sid, permissionMode: "default" });
  }

  /** Helper: emit an assistant with Agent tool_use (main context — no agentId) */
  function emitAgentToolUse(desc: string) {
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Agent", input: { description: desc } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
  }

  /** Helper: emit a subagent event (any type, tagged with agentId) */
  function emitSubEvent(agentId: string, event: Record<string, unknown>) {
    JSON.stringify({ ...event, agentId });
  }

  it("creates subagent when first event with agentId arrives", () => {
    const state = installAndGetState();
    emitMainSystem();
    emitAgentToolUse("Search codebase");
    // Subagent's first event carries agentId
    emitSubEvent("agent-a1", { type: "system", sessionId: "main-sid-1" });

    const subs = state.subs as Array<Record<string, unknown>>;
    expect(subs).toHaveLength(1);
    expect(subs[0].sid).toBe("agent-a1");
    expect(subs[0].desc).toBe("Search codebase");
    expect(subs[0].st).toBe("s"); // starting (system event doesn't change state)
  });

  it("matches parallel Agent tool_uses to agentIds in FIFO order", () => {
    const state = installAndGetState();
    emitMainSystem();
    // Two Agent tool_uses in one assistant message
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", name: "Agent", input: { description: "Task A" } },
          { type: "tool_use", name: "Agent", input: { description: "Task B" } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    // First agentId should match "Task A" (FIFO)
    emitSubEvent("agent-a", { type: "system", sessionId: "main-sid-1" });
    emitSubEvent("agent-b", { type: "system", sessionId: "main-sid-1" });

    const subs = state.subs as Array<Record<string, unknown>>;
    expect(subs).toHaveLength(2);
    expect(subs[0].desc).toBe("Task A");
    expect(subs[1].desc).toBe("Task B");
  });

  it("routes sub events without contaminating main state", () => {
    const state = installAndGetState();
    emitMainSystem();
    emitAgentToolUse("Research");
    emitSubEvent("agent-r1", { type: "system", sessionId: "main-sid-1" });

    // Sub assistant event (has agentId) — should NOT update main tokens
    emitSubEvent("agent-r1", {
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Sub response" }],
        usage: { input_tokens: 500, output_tokens: 200 },
      },
    });

    // Main tokens should only include the Agent tool_use event (10+5)
    expect(state.inTok).toBe(10);
    expect(state.outTok).toBe(5);
    // Sub should have the tokens
    const subs = state.subs as Array<Record<string, unknown>>;
    expect(subs[0].tok).toBe(700); // 500+200
  });

  it("marks subagent idle on result", () => {
    const state = installAndGetState();
    emitMainSystem();
    emitAgentToolUse("Test task");
    emitSubEvent("agent-t1", { type: "system", sessionId: "main-sid-1" });

    emitSubEvent("agent-t1", { type: "result", total_cost_usd: 0.05 });

    const subs = state.subs as Array<Record<string, unknown>>;
    expect(subs[0].st).toBe("i"); // idle
  });

  it("routes events without agentId to main after sub completes", () => {
    const state = installAndGetState();
    emitMainSystem();
    emitAgentToolUse("Sub task");
    emitSubEvent("agent-s1", { type: "system", sessionId: "main-sid-1" });
    // Complete subagent
    emitSubEvent("agent-s1", { type: "result", total_cost_usd: 0.01 });

    // Next assistant event has NO agentId → routes to main
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Main response after sub" }],
        usage: { input_tokens: 200, output_tokens: 100 },
      },
    });

    // Main tokens: 10 (Agent tool_use) + 200 = 210 in, 5 + 100 = 105 out
    expect(state.inTok).toBe(210);
    expect(state.outTok).toBe(105);
    expect(state.lastText).toBe("Main response after sub");
  });

  it("extracts messages from subagent events", () => {
    const state = installAndGetState();
    emitMainSystem();
    emitAgentToolUse("Msg test");
    emitSubEvent("agent-m1", { type: "system", sessionId: "main-sid-1" });

    // Sub assistant with text + tool_use
    emitSubEvent("agent-m1", {
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Let me check" },
          { type: "tool_use", name: "Read", input: { file_path: "/src/main.ts" } },
        ],
        usage: { input_tokens: 50, output_tokens: 25 },
      },
    });

    // Sub user with tool_result
    emitSubEvent("agent-m1", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents here" }] },
    });

    const subs = state.subs as Array<{ msgs: Array<{ r: string; x: string; tn?: string }> }>;
    const msgs = subs[0].msgs;
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toEqual({ r: "a", x: "Let me check" });
    expect(msgs[1]).toEqual({ r: "t", x: "/src/main.ts", tn: "Read" });
    expect(msgs[2]).toEqual({ r: "t", x: "file contents here", tn: "result" });
  });

  it("handles multiple concurrent subagents via direct agentId routing", () => {
    const state = installAndGetState();
    emitMainSystem();

    emitAgentToolUse("Outer agent");
    emitAgentToolUse("Inner agent");

    emitSubEvent("agent-outer", { type: "system", sessionId: "main-sid-1" });
    emitSubEvent("agent-inner", { type: "system", sessionId: "main-sid-1" });

    const subs = state.subs as Array<Record<string, unknown>>;
    expect(subs).toHaveLength(2);
    expect(subs[0].desc).toBe("Outer agent");
    expect(subs[1].desc).toBe("Inner agent");

    // Events route directly by agentId — no stack needed
    emitSubEvent("agent-inner", { type: "result", total_cost_usd: 0.01 });
    expect(subs[1].st).toBe("i");
    expect(subs[0].st).toBe("s"); // outer still active

    emitSubEvent("agent-outer", { type: "result", total_cost_usd: 0.02 });
    expect(subs[0].st).toBe("i");
  });

  it("queues pendingDescs for Agent tool_use in main context", () => {
    const state = installAndGetState();
    emitMainSystem();
    emitAgentToolUse("Pending task");

    expect((state.pendingDescs as string[])).toEqual(["Pending task"]);
  });
});

// ── Sealed flag tests ──────────────────────────────────────────

describe("INSTALL_HOOK sealed flag", () => {
  let savedStringify: typeof JSON.stringify;
  let savedParse: typeof JSON.parse;

  beforeEach(() => {
    savedStringify = JSON.stringify;
    savedParse = JSON.parse;
  });

  afterEach(() => {
    JSON.stringify = savedStringify;
    JSON.parse = savedParse;
    cleanupGlobalHook();
  });

  function installAndGetState(): Record<string, unknown> {
    const g = globalThis as unknown as Record<string, unknown>;
    cleanupGlobalHook();
    const fn = new Function(`return ${INSTALL_HOOK}`);
    fn();
    return g.__inspectorState as Record<string, unknown>;
  }

  it("result event sets _sealed = true and blocks subsequent assistant from updating stop", () => {
    const state = installAndGetState();
    // Assistant with tool_use
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "tool_use", content: [], usage: { input_tokens: 10, output_tokens: 5 } },
    });
    expect(state.stop).toBe("tool_use");

    // Result seals
    JSON.stringify({ type: "result", total_cost_usd: 0.01 });
    expect(state.stop).toBe("end_turn");
    expect(state._sealed).toBe(true);

    // Post-completion re-serialized assistant — stop should NOT change
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }], usage: { input_tokens: 0, output_tokens: 0 } },
    });
    expect(state.stop).toBe("end_turn");
  });

  it("sealed assistant events don't enter ring buffer", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "end_turn", content: [], usage: { input_tokens: 10, output_tokens: 5 } },
    });
    JSON.stringify({ type: "result", total_cost_usd: 0.01 });
    const eventsAfterResult = (state.events as unknown[]).length;

    // Sealed assistant — should NOT add to events
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "tool_use", content: [], usage: { input_tokens: 0, output_tokens: 0 } },
    });
    expect((state.events as unknown[]).length).toBe(eventsAfterResult);
  });

  it("tokens still accumulate while sealed", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "end_turn", content: [], usage: { input_tokens: 100, output_tokens: 50 } },
    });
    JSON.stringify({ type: "result", total_cost_usd: 0.01 });
    expect(state.inTok).toBe(100);

    // Sealed assistant still accumulates tokens (model/usage always update)
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "tool_use", content: [], usage: { input_tokens: 20, output_tokens: 10 } },
    });
    expect(state.inTok).toBe(120);
    expect(state.outTok).toBe(60);
  });

  it("user event clears _sealed", () => {
    const state = installAndGetState();
    JSON.stringify({ type: "result", total_cost_usd: 0.01 });
    expect(state._sealed).toBe(true);

    JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "hello" }] },
    });
    expect(state._sealed).toBe(false);
  });
});

// ── Sticky idleDetected tests ──────────────────────────────────

describe("INSTALL_HOOK sticky idleDetected", () => {
  afterEach(cleanupGlobalHook);

  it("user event clears idleDetected", () => {
    let savedStringify: typeof JSON.stringify;
    let savedParse: typeof JSON.parse;
    savedStringify = JSON.stringify;
    savedParse = JSON.parse;
    try {
      const g = globalThis as unknown as Record<string, unknown>;
      cleanupGlobalHook();
      const fn = new Function(`return ${INSTALL_HOOK}`);
      fn();
      const state = g.__inspectorState as Record<string, unknown>;

      // Trigger idle
      JSON.stringify({ notification_type: "idle_prompt" });
      expect(state.idleDetected).toBe(true);

      // User event clears it
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "continue" }] },
      });
      expect(state.idleDetected).toBe(false);
    } finally {
      JSON.stringify = savedStringify;
      JSON.parse = savedParse;
      cleanupGlobalHook();
    }
  });
});

// ── Extended sealed flag edge cases ─────────────────────────────

describe("INSTALL_HOOK sealed flag edge cases", () => {
  let savedStringify: typeof JSON.stringify;
  let savedParse: typeof JSON.parse;

  beforeEach(() => {
    savedStringify = JSON.stringify;
    savedParse = JSON.parse;
  });

  afterEach(() => {
    JSON.stringify = savedStringify;
    JSON.parse = savedParse;
    cleanupGlobalHook();
  });

  function installAndGetState(): Record<string, unknown> {
    const g = globalThis as unknown as Record<string, unknown>;
    cleanupGlobalHook();
    const fn = new Function(`return ${INSTALL_HOOK}`);
    fn();
    return g.__inspectorState as Record<string, unknown>;
  }

  it("sealed blocks tools array update from post-completion assistant", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "end_turn", content: [{ type: "text", text: "Done" }], usage: { input_tokens: 10, output_tokens: 5 } },
    });
    JSON.stringify({ type: "result", total_cost_usd: 0.01 });
    expect(state.tools).toEqual([]);

    // Sealed assistant with tool_use — tools should NOT update
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Bash", input: { command: "echo hi" } }],
        usage: { input_tokens: 0, output_tokens: 0 } },
    });
    expect(state.tools).toEqual([]);
  });

  it("sealed blocks lastText update from post-completion assistant", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "end_turn",
        content: [{ type: "text", text: "Original response" }],
        usage: { input_tokens: 10, output_tokens: 5 } },
    });
    JSON.stringify({ type: "result", total_cost_usd: 0.01 });
    expect(state.lastText).toBe("Original response");

    // Sealed assistant — lastText should NOT change
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "end_turn",
        content: [{ type: "text", text: "Phantom re-serialized text" }],
        usage: { input_tokens: 0, output_tokens: 0 } },
    });
    expect(state.lastText).toBe("Original response");
  });

  it("sealed blocks toolAction update from post-completion assistant", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Read", input: { file_path: "/real.ts" } }],
        usage: { input_tokens: 10, output_tokens: 5 } },
    });
    expect(state.toolAction).toBe("Read: /real.ts");
    JSON.stringify({ type: "result", total_cost_usd: 0.01 });

    // Sealed assistant — toolAction should NOT change
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Bash", input: { command: "rm -rf /" } }],
        usage: { input_tokens: 0, output_tokens: 0 } },
    });
    expect(state.toolAction).toBe("Read: /real.ts");
  });

  it("sealed blocks pendingDescs growth from post-completion Agent tool_use", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "end_turn", content: [], usage: { input_tokens: 10, output_tokens: 5 } },
    });
    JSON.stringify({ type: "result", total_cost_usd: 0.01 });

    // Sealed assistant with Agent tool_use — pendingDescs should NOT grow
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Agent", input: { description: "Ghost agent" } }],
        usage: { input_tokens: 0, output_tokens: 0 } },
    });
    expect(state.pendingDescs).toEqual([]);
  });

  it("sealed does not block lastEvent update for user events", () => {
    const state = installAndGetState();
    JSON.stringify({ type: "result", total_cost_usd: 0.01 });
    expect(state._sealed).toBe(true);
    expect(state.lastEvent).toBe("result");

    // User event still updates lastEvent (and clears sealed)
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "next question" }] },
    });
    expect(state.lastEvent).toBe("user");
    expect(state._sealed).toBe(false);
  });

  it("sealed does not block model update from post-completion assistant", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "end_turn", content: [], usage: { input_tokens: 10, output_tokens: 5 } },
    });
    JSON.stringify({ type: "result", total_cost_usd: 0.01 });
    expect(state.model).toBe("claude-opus-4-6");

    // Model still updates while sealed (it's outside the sealed guard)
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-sonnet-4-6", stop_reason: "end_turn", content: [], usage: { input_tokens: 0, output_tokens: 0 } },
    });
    expect(state.model).toBe("claude-sonnet-4-6");
  });

  it("result events still update lastEvent while creating seal", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "end_turn", content: [], usage: { input_tokens: 10, output_tokens: 5 } },
    });
    expect(state.lastEvent).toBe("assistant");

    JSON.stringify({ type: "result", total_cost_usd: 0.01 });
    expect(state.lastEvent).toBe("result");
    expect(state._sealed).toBe(true);
  });

  it("sealed lastEvent stays unchanged for sealed assistant events", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "end_turn", content: [], usage: { input_tokens: 10, output_tokens: 5 } },
    });
    JSON.stringify({ type: "result", total_cost_usd: 0.01 });
    expect(state.lastEvent).toBe("result");

    // Sealed assistant — lastEvent should NOT update
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "tool_use", content: [], usage: { input_tokens: 0, output_tokens: 0 } },
    });
    expect(state.lastEvent).toBe("result");
  });

  it("seal-unseal-seal cycle works correctly", () => {
    const state = installAndGetState();
    // First cycle: assistant → result (seal)
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "end_turn", content: [{ type: "text", text: "First answer" }], usage: { input_tokens: 10, output_tokens: 5 } },
    });
    JSON.stringify({ type: "result", total_cost_usd: 0.01 });
    expect(state._sealed).toBe(true);

    // Unseal via user
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "Follow up" }] },
    });
    expect(state._sealed).toBe(false);

    // Second cycle: assistant → result (re-seal)
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "end_turn", content: [{ type: "text", text: "Second answer" }], usage: { input_tokens: 20, output_tokens: 10 } },
    });
    expect(state.lastText).toBe("Second answer");
    expect(state.stop).toBe("end_turn");

    JSON.stringify({ type: "result", total_cost_usd: 0.02 });
    expect(state._sealed).toBe(true);

    // Verify sealed blocks again
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }], usage: { input_tokens: 0, output_tokens: 0 } },
    });
    expect(state.stop).toBe("end_turn");
    expect(state.tools).toEqual([]);
  });
});

// ── Extended sticky idleDetected edge cases ─────────────────────

describe("INSTALL_HOOK sticky idleDetected edge cases", () => {
  let savedStringify: typeof JSON.stringify;
  let savedParse: typeof JSON.parse;

  beforeEach(() => {
    savedStringify = JSON.stringify;
    savedParse = JSON.parse;
  });

  afterEach(() => {
    JSON.stringify = savedStringify;
    JSON.parse = savedParse;
    cleanupGlobalHook();
  });

  function installAndGetState(): Record<string, unknown> {
    const g = globalThis as unknown as Record<string, unknown>;
    cleanupGlobalHook();
    const fn = new Function(`return ${INSTALL_HOOK}`);
    fn();
    return g.__inspectorState as Record<string, unknown>;
  }

  it("second idle_prompt while already sticky is idempotent", () => {
    const state = installAndGetState();
    JSON.stringify({ notification_type: "idle_prompt" });
    expect(state.idleDetected).toBe(true);

    // Second idle_prompt — still true, no error
    JSON.stringify({ notification_type: "idle_prompt" });
    expect(state.idleDetected).toBe(true);
  });

  it("tool_result user event also clears idleDetected", () => {
    const state = installAndGetState();
    JSON.stringify({ notification_type: "idle_prompt" });
    expect(state.idleDetected).toBe(true);

    // User event with tool_result still clears idleDetected
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "abc", content: "output" }] },
    });
    expect(state.idleDetected).toBe(false);
  });

  it("assistant event does not clear idleDetected", () => {
    const state = installAndGetState();
    JSON.stringify({ notification_type: "idle_prompt" });
    expect(state.idleDetected).toBe(true);

    // Assistant event — idleDetected stays
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "end_turn",
        content: [{ type: "text", text: "Some response text here" }],
        usage: { input_tokens: 10, output_tokens: 5 } },
    });
    expect(state.idleDetected).toBe(true);
  });

  it("result event does not clear idleDetected", () => {
    const state = installAndGetState();
    JSON.stringify({ notification_type: "idle_prompt" });
    expect(state.idleDetected).toBe(true);

    JSON.stringify({ type: "result", total_cost_usd: 0.01 });
    expect(state.idleDetected).toBe(true);
  });
});

// ── turnHasTools tracking ───────────────────────────────────────

describe("INSTALL_HOOK turnHasTools", () => {
  let savedStringify: typeof JSON.stringify;
  let savedParse: typeof JSON.parse;

  beforeEach(() => {
    savedStringify = JSON.stringify;
    savedParse = JSON.parse;
  });

  afterEach(() => {
    JSON.stringify = savedStringify;
    JSON.parse = savedParse;
    cleanupGlobalHook();
  });

  function installAndGetState(): Record<string, unknown> {
    const g = globalThis as unknown as Record<string, unknown>;
    cleanupGlobalHook();
    const fn = new Function(`return ${INSTALL_HOOK}`);
    fn();
    return g.__inspectorState as Record<string, unknown>;
  }

  it("starts false", () => {
    const state = installAndGetState();
    expect(state.turnHasTools).toBe(false);
  });

  it("set true when assistant has tool_use content", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6", stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    expect(state.turnHasTools).toBe(true);
  });

  it("NOT cleared by tool_result user event", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6", stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Edit", input: { file_path: "foo.ts" } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    expect(state.turnHasTools).toBe(true);

    // Tool result comes back — turnHasTools should persist
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: "ok" }] },
    });
    expect(state.turnHasTools).toBe(true);
  });

  it("cleared by non-tool-result user event (new prompt)", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6", stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    expect(state.turnHasTools).toBe(true);

    // New user prompt — starts a new turn
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "do something else" }] },
    });
    expect(state.turnHasTools).toBe(false);
  });

  it("not set by sealed assistant with tool_use", () => {
    const state = installAndGetState();
    // Seal via result
    JSON.stringify({ type: "result", total_cost_usd: 0.01 });
    expect(state._sealed).toBe(true);
    expect(state.turnHasTools).toBe(false);

    // Post-seal assistant with tool_use — should not set turnHasTools
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6", stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    expect(state.turnHasTools).toBe(false);
  });

  it("persists through full agentic loop: tool_use → tool_result → end_turn summary", () => {
    const state = installAndGetState();
    // User starts the turn
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "fix three things" }] },
    });
    expect(state.turnHasTools).toBe(false);

    // Claude uses Bash
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6", stop_reason: "tool_use",
        content: [
          { type: "text", text: "Let me fix that." },
          { type: "tool_use", name: "Bash", input: { command: "echo hi" } },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    });
    expect(state.turnHasTools).toBe(true);

    // Tool result
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: "hi" }] },
    });
    expect(state.turnHasTools).toBe(true);

    // Claude uses Edit
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6", stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Edit", input: { file_path: "a.ts" } }],
        usage: { input_tokens: 50, output_tokens: 20 },
      },
    });
    expect(state.turnHasTools).toBe(true);

    // Tool result
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: "done" }] },
    });

    // Final summary with numbered list — end_turn, no tool_use blocks
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6", stop_reason: "end_turn",
        content: [{ type: "text", text: "Three fixes applied:\n1. Fixed A\n2. Fixed B\n3. Fixed C" }],
        usage: { input_tokens: 50, output_tokens: 30 },
      },
    });
    expect(state.turnHasTools).toBe(true);
    expect(state.stop).toBe("end_turn");
    expect(state.lastText).toContain("1. Fixed A");
  });
});

// ── POLL_STATE choiceHint is always false (detection moved to terminal buffer) ──

describe("POLL_STATE choiceHint always false", () => {
  afterEach(cleanupGlobalHook);

  it("choiceHint=false regardless of lastText content", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__inspectorState = {
      n: 5, sid: null, cost: 0, model: null,
      stop: "end_turn", tools: [], inTok: 0, outTok: 0,
      events: [], lastEvent: "assistant", firstMsg: null,
      lastText: "Which approach do you prefer?\n1. Simple fix\n2. Full refactor\n3. Hybrid",
      userPrompt: null, permPending: false, idleDetected: false,
      toolAction: null, turnHasTools: false,
      inputBuf: "", inputTs: 0, pendingDescs: [], subs: [],
      _sealed: false,
    };
    const fn = new Function(`return ${POLL_STATE}`);
    const result = fn() as Record<string, unknown>;
    expect(result.choiceHint).toBe(false);
  });
});

// ── Stdin handler: interrupt (Ctrl+C, Escape) and Ctrl+U ─────────────

describe("INSTALL_HOOK stdin handler — interrupt signals", () => {
  let savedStringify: typeof JSON.stringify;
  let savedParse: typeof JSON.parse;

  beforeEach(() => {
    savedStringify = JSON.stringify;
    savedParse = JSON.parse;
  });

  afterEach(() => {
    JSON.stringify = savedStringify;
    JSON.parse = savedParse;
    cleanupGlobalHook();
  });

  function installAndGetState(): Record<string, unknown> {
    const g = globalThis as unknown as Record<string, unknown>;
    cleanupGlobalHook();
    const fn = new Function(`return ${INSTALL_HOOK}`);
    fn();
    return g.__inspectorState as Record<string, unknown>;
  }

  /** Simulate a stdin keystroke via the installed handler.
   *  The hook does chunk.toString(), so passing a string-like object suffices. */
  function sendStdin(ch: string) {
    const handler = (globalThis as unknown as Record<string, unknown>).__inspectorStdinHandler as (chunk: { toString(): string }) => void;
    expect(handler).toBeDefined();
    handler({ toString: () => ch });
  }

  /** Put the hook into mid-turn state: assistant thinking with active subagents. */
  function setupMidTurn(state: Record<string, unknown>) {
    // Main assistant event (thinking, tool in progress)
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    });
    // Type some input
    sendStdin("p");
    sendStdin("a");
    sendStdin("r");
    expect(state.inputBuf).toBe("par");
    expect(state.stop).toBe("tool_use");
    expect(state.toolAction).toBe("Bash: npm test");
    expect(state.permPending).toBe(false);
  }

  // ── Ctrl+C (\x03) ──

  it("Ctrl+C clears inputBuf", () => {
    const state = installAndGetState();
    setupMidTurn(state);
    sendStdin("\x03");
    expect(state.inputBuf).toBe("");
  });

  it("Ctrl+C pushes synthetic result event to ring buffer", () => {
    const state = installAndGetState();
    setupMidTurn(state);
    const eventsBefore = (state.events as unknown[]).length;
    sendStdin("\x03");
    const events = state.events as Array<Record<string, unknown>>;
    expect(events.length).toBe(eventsBefore + 1);
    expect(events[events.length - 1].t).toBe("result");
  });

  it("Ctrl+C sets lastEvent to result and stop to end_turn", () => {
    const state = installAndGetState();
    setupMidTurn(state);
    sendStdin("\x03");
    expect(state.lastEvent).toBe("result");
    expect(state.stop).toBe("end_turn");
  });

  it("Ctrl+C clears _sealed so next real event can update state", () => {
    const state = installAndGetState();
    setupMidTurn(state);
    sendStdin("\x03");
    expect(state._sealed).toBe(false);
  });

  it("Ctrl+C clears permPending and toolAction", () => {
    const state = installAndGetState();
    setupMidTurn(state);
    // Set permPending manually to verify it's cleared
    (state as Record<string, unknown>).permPending = true;
    sendStdin("\x03");
    expect(state.permPending).toBe(false);
    expect(state.toolAction).toBeNull();
  });

  // ── Escape (\x1b) ──

  it("Escape clears inputBuf", () => {
    const state = installAndGetState();
    setupMidTurn(state);
    sendStdin("\x1b");
    expect(state.inputBuf).toBe("");
  });

  it("Escape pushes synthetic result event to ring buffer", () => {
    const state = installAndGetState();
    setupMidTurn(state);
    const eventsBefore = (state.events as unknown[]).length;
    sendStdin("\x1b");
    const events = state.events as Array<Record<string, unknown>>;
    expect(events.length).toBe(eventsBefore + 1);
    expect(events[events.length - 1].t).toBe("result");
  });

  it("Escape sets lastEvent to result and stop to end_turn", () => {
    const state = installAndGetState();
    setupMidTurn(state);
    sendStdin("\x1b");
    expect(state.lastEvent).toBe("result");
    expect(state.stop).toBe("end_turn");
  });

  it("Escape clears permPending and toolAction", () => {
    const state = installAndGetState();
    setupMidTurn(state);
    (state as Record<string, unknown>).permPending = true;
    sendStdin("\x1b");
    expect(state.permPending).toBe(false);
    expect(state.toolAction).toBeNull();
  });

  // ── Ctrl+U (\x15) ──

  it("Ctrl+U clears inputBuf only (no synthetic event, no state reset)", () => {
    const state = installAndGetState();
    setupMidTurn(state);
    const eventsBefore = (state.events as unknown[]).length;
    const stopBefore = state.stop;
    const lastEventBefore = state.lastEvent;
    const toolActionBefore = state.toolAction;

    sendStdin("\x15");

    expect(state.inputBuf).toBe("");
    // No synthetic event pushed
    expect((state.events as unknown[]).length).toBe(eventsBefore);
    // State fields unchanged
    expect(state.stop).toBe(stopBefore);
    expect(state.lastEvent).toBe(lastEventBefore);
    expect(state.toolAction).toBe(toolActionBefore);
  });

  // ── Subagent cleanup on interrupt ──

  it("Ctrl+C marks all active subagents idle", () => {
    const state = installAndGetState();
    // Spawn two subagents in different states
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", name: "Agent", input: { description: "Task A" } },
          { type: "tool_use", name: "Agent", input: { description: "Task B" } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    // Create subagents via agentId events
    JSON.stringify({ type: "system", sessionId: "s1", agentId: "agent-a" });
    JSON.stringify({ type: "system", sessionId: "s1", agentId: "agent-b" });
    // Put agent-a into thinking state
    JSON.stringify({
      type: "assistant", agentId: "agent-a",
      message: {
        model: "claude-opus-4-6", stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
        usage: { input_tokens: 20, output_tokens: 10 },
      },
    });

    const subs = state.subs as Array<Record<string, unknown>>;
    expect(subs).toHaveLength(2);
    expect(subs[0].st).toBe("u"); // tool_use
    expect(subs[1].st).toBe("s"); // starting

    sendStdin("\x03");

    expect(subs[0].st).toBe("i");
    expect(subs[1].st).toBe("i");
  });

  it("Escape marks all active subagents idle", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Agent", input: { description: "Research" } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    JSON.stringify({ type: "system", sessionId: "s1", agentId: "agent-r1" });
    // Sub is in thinking state
    JSON.stringify({
      type: "user", agentId: "agent-r1",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    });

    const subs = state.subs as Array<Record<string, unknown>>;
    expect(subs[0].st).toBe("t"); // thinking (user event → tool_result)

    sendStdin("\x1b");
    expect(subs[0].st).toBe("i");
  });

  it("interrupt does not change already-idle subagents", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Agent", input: { description: "Done task" } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    JSON.stringify({ type: "system", sessionId: "s1", agentId: "agent-done" });
    // Complete the subagent
    JSON.stringify({ type: "result", agentId: "agent-done", total_cost_usd: 0.01 });

    const subs = state.subs as Array<Record<string, unknown>>;
    expect(subs[0].st).toBe("i");

    sendStdin("\x03");
    expect(subs[0].st).toBe("i"); // stays idle, no error
  });

  // ── Self-correction: real events after interrupt override synthetic state ──

  it("real assistant event after Ctrl+C overrides synthetic idle state", () => {
    const state = installAndGetState();
    setupMidTurn(state);
    sendStdin("\x03");

    // Synthetic state: idle
    expect(state.lastEvent).toBe("result");
    expect(state.stop).toBe("end_turn");

    // Claude continues processing — real assistant event arrives
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Read", input: { file_path: "/src/app.ts" } }],
        usage: { input_tokens: 50, output_tokens: 20 },
      },
    });

    // Real event overrides the synthetic state
    expect(state.lastEvent).toBe("assistant");
    expect(state.stop).toBe("tool_use");
    expect(state.toolAction).toBe("Read: /src/app.ts");
    const events = state.events as Array<Record<string, unknown>>;
    expect(events[events.length - 1].t).toBe("assistant");
  });

  it("real user event after interrupt resets sealed and starts new turn", () => {
    const state = installAndGetState();
    setupMidTurn(state);
    sendStdin("\x03");

    // _sealed is false after interrupt, so user event works normally
    expect(state._sealed).toBe(false);

    JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "new prompt after interrupt" }] },
    });

    expect(state.lastEvent).toBe("user");
    expect(state.stop).toBeNull();
    expect(state.tools).toEqual([]);
    expect(state.userPrompt).toBe("new prompt after interrupt");
  });

  it("deriveStateFromPoll sees idle after interrupt (synthetic result in events)", () => {
    const state = installAndGetState();
    setupMidTurn(state);
    sendStdin("\x03");

    // Build a poll-like snapshot from current state
    const events = (state.events as Array<{ t: string; sr?: string; c?: number; txt?: string; ta?: string }>).slice();
    const pollData = {
      n: state.n as number,
      sid: state.sid as string | null,
      cost: state.cost as number,
      model: state.model as string | null,
      stop: state.stop as string | null,
      tools: (state.tools as string[]).slice(),
      inTok: state.inTok as number,
      outTok: state.outTok as number,
      events,
      lastEvent: state.lastEvent as string | null,
      firstMsg: state.firstMsg as string | null,
      lastText: state.lastText as string | null,
      userPrompt: state.userPrompt as string | null,
      permPending: state.permPending as boolean,
      idleDetected: state.idleDetected as boolean,
      toolAction: state.toolAction as string | null,
      choiceHint: false,
      promptDetected: false,
      inputBuf: state.inputBuf as string,
      inputTs: state.inputTs as number,
      slashCmd: null,
      fetchBypassed: 0, fetchTimeouts: 0, httpsTimeouts: 0,
      subs: [],
      cwd: null,
    };

    const derived = deriveStateFromPoll(pollData, "toolUse");
    expect(derived).toBe("idle");
  });

  it("deriveStateFromPoll overrides to thinking when real user event follows interrupt", () => {
    const state = installAndGetState();
    setupMidTurn(state);
    sendStdin("\x03");

    // Real user event after interrupt
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "continue" }] },
    });

    const events = (state.events as Array<{ t: string; sr?: string; c?: number; txt?: string; ta?: string }>).slice();
    const pollData = {
      n: state.n as number,
      sid: state.sid as string | null,
      cost: state.cost as number,
      model: state.model as string | null,
      stop: state.stop as string | null,
      tools: (state.tools as string[]).slice(),
      inTok: state.inTok as number,
      outTok: state.outTok as number,
      events,
      lastEvent: state.lastEvent as string | null,
      firstMsg: state.firstMsg as string | null,
      lastText: state.lastText as string | null,
      userPrompt: state.userPrompt as string | null,
      permPending: state.permPending as boolean,
      idleDetected: state.idleDetected as boolean,
      toolAction: state.toolAction as string | null,
      choiceHint: false,
      promptDetected: false,
      inputBuf: state.inputBuf as string,
      inputTs: state.inputTs as number,
      slashCmd: null,
      fetchBypassed: 0, fetchTimeouts: 0, httpsTimeouts: 0,
      subs: [],
      cwd: null,
    };

    const derived = deriveStateFromPoll(pollData, "idle");
    expect(derived).toBe("thinking");
  });
});

// ── globalThis.fetch wrapper (WebFetch timeout) ─────────────────────

describe("INSTALL_HOOK globalThis.fetch wrapper", () => {
  let savedStringify: typeof JSON.stringify;
  let savedParse: typeof JSON.parse;
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    savedStringify = JSON.stringify;
    savedParse = JSON.parse;
    savedFetch = globalThis.fetch;
  });

  afterEach(() => {
    JSON.stringify = savedStringify;
    JSON.parse = savedParse;
    globalThis.fetch = savedFetch;
    cleanupGlobalHook();
  });

  function installAndGetState(): Record<string, unknown> {
    const g = globalThis as unknown as Record<string, unknown>;
    cleanupGlobalHook();
    const fn = new Function(`return ${INSTALL_HOOK}`);
    fn();
    return g.__inspectorState as Record<string, unknown>;
  }

  it("passes through non-Anthropic URLs without modification", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response("ok");
    };
    installAndGetState();

    await globalThis.fetch("https://example.com/api", { method: "POST", body: '{"data":true}' });
    // Non-Anthropic URL should pass through directly (no signal override)
    expect(capturedInit?.signal).toBeUndefined();
  });

  it("passes through streaming Anthropic calls without modification", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response("ok");
    };
    installAndGetState();

    await globalThis.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: '{"model":"claude-opus-4-6","stream":true,"messages":[]}',
    });
    // Streaming calls pass through — no AbortController signal injected
    expect(capturedInit?.signal).toBeUndefined();
  });

  it("passes through streaming calls with space in stream field", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response("ok");
    };
    installAndGetState();

    await globalThis.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: '{"model":"claude-opus-4-6","stream": true,"messages":[]}',
    });
    expect(capturedInit?.signal).toBeUndefined();
  });

  it("wraps non-streaming Anthropic calls with AbortController signal", async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Response("ok");
    };
    installAndGetState();

    await globalThis.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: '{"model":"claude-opus-4-6","stream":false,"messages":[]}',
    });
    // Non-streaming call should have an AbortController signal injected
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal!.aborted).toBe(false);
  });

  it("clears timeout timer on successful response", async () => {
    globalThis.fetch = async () => new Response("ok");
    installAndGetState();

    // This should resolve without leaving a dangling timer
    const resp = await globalThis.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: '{"model":"claude-opus-4-6","messages":[]}',
    });
    expect(resp).toBeInstanceOf(Response);
  });

  it("clears timeout timer on fetch rejection", async () => {
    globalThis.fetch = async () => { throw new Error("network error"); };
    installAndGetState();

    await expect(
      globalThis.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: '{"model":"claude-opus-4-6","messages":[]}',
      })
    ).rejects.toThrow("network error");
  });

  it("forwards original signal abort to the new AbortController", async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Response("ok");
    };
    const origAc = new AbortController();
    installAndGetState();

    await globalThis.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: '{"model":"claude-opus-4-6","messages":[]}',
      signal: origAc.signal,
    });

    // The wrapped signal is NOT the original one — it's a new AbortController's signal
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal).not.toBe(origAc.signal);
  });

  it("passes through immediately when original signal is already aborted", async () => {
    let callCount = 0;
    globalThis.fetch = async (_input: RequestInfo | URL, _init?: RequestInit) => {
      callCount++;
      return new Response("ok");
    };
    const origAc = new AbortController();
    origAc.abort("pre-aborted");
    installAndGetState();

    // When signal is already aborted, it should call origFetch directly
    // (passing original arguments, not creating a new AbortController)
    await globalThis.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: '{"model":"claude-opus-4-6","messages":[]}',
      signal: origAc.signal,
    });
    expect(callCount).toBe(1);
  });

  it("copies all init properties except signal to new init object", async () => {
    let capturedInit: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init as unknown as Record<string, unknown>;
      return new Response("ok");
    };
    installAndGetState();

    await globalThis.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: '{"model":"claude-opus-4-6","messages":[]}',
      headers: { "Content-Type": "application/json" },
    });

    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.body).toBe('{"model":"claude-opus-4-6","messages":[]}');
    expect(capturedInit?.headers).toEqual({ "Content-Type": "application/json" });
    // Signal should be from new AbortController, not undefined
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("removes abort listener from original signal on success", async () => {
    const origAc = new AbortController();
    const listenerCounts = { add: 0, remove: 0 };
    const origAdd = origAc.signal.addEventListener.bind(origAc.signal);
    const origRemove = origAc.signal.removeEventListener.bind(origAc.signal);
    origAc.signal.addEventListener = (...args: Parameters<typeof origAc.signal.addEventListener>) => {
      listenerCounts.add++;
      return origAdd(...args);
    };
    origAc.signal.removeEventListener = (...args: Parameters<typeof origAc.signal.removeEventListener>) => {
      listenerCounts.remove++;
      return origRemove(...args);
    };

    globalThis.fetch = async () => new Response("ok");
    installAndGetState();

    await globalThis.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: '{"model":"claude-opus-4-6","messages":[]}',
      signal: origAc.signal,
    });

    expect(listenerCounts.add).toBe(1);
    expect(listenerCounts.remove).toBe(1);
  });

  it("removes abort listener from original signal on rejection", async () => {
    const origAc = new AbortController();
    const listenerCounts = { add: 0, remove: 0 };
    const origAdd = origAc.signal.addEventListener.bind(origAc.signal);
    const origRemove = origAc.signal.removeEventListener.bind(origAc.signal);
    origAc.signal.addEventListener = (...args: Parameters<typeof origAc.signal.addEventListener>) => {
      listenerCounts.add++;
      return origAdd(...args);
    };
    origAc.signal.removeEventListener = (...args: Parameters<typeof origAc.signal.removeEventListener>) => {
      listenerCounts.remove++;
      return origRemove(...args);
    };

    globalThis.fetch = async () => { throw new Error("fail"); };
    installAndGetState();

    await globalThis.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: '{"model":"claude-opus-4-6","messages":[]}',
      signal: origAc.signal,
    }).catch(() => {});

    expect(listenerCounts.add).toBe(1);
    expect(listenerCounts.remove).toBe(1);
  });

  it("increments fetchTimeouts counter on timeout abort", async () => {
    // Use fake timers for deterministic timeout testing
    const { vi } = await import("vitest");
    vi.useFakeTimers();
    try {
      let capturedSignal: AbortSignal | undefined;
      globalThis.fetch = (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        // Return a promise that never resolves (simulating a hung request)
        return new Promise<Response>(() => {});
      };
      const state = installAndGetState();
      expect(state.fetchTimeouts).toBeUndefined();

      // Start a non-streaming Anthropic call (will hang forever)
      const fetchPromise = globalThis.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: '{"model":"claude-opus-4-6","messages":[]}',
      });
      // Verify signal is wired
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      expect(capturedSignal!.aborted).toBe(false);

      // Advance past the 120s timeout
      vi.advanceTimersByTime(120001);

      // fetchTimeouts should be incremented
      expect(state.fetchTimeouts).toBe(1);
      // Signal should now be aborted
      expect(capturedSignal!.aborted).toBe(true);

      // Clean up the dangling promise (it will reject from the abort)
      fetchPromise.catch(() => {});
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not increment fetchTimeouts for successful calls", async () => {
    globalThis.fetch = async () => new Response("ok");
    const state = installAndGetState();

    await globalThis.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: '{"model":"claude-opus-4-6","messages":[]}',
    });

    expect(state.fetchTimeouts).toBeUndefined();
  });
});

// ── https.request hard timeout ──────────────────────────────────────
// NOTE: require() is not available inside new Function() in Vitest's ESM
// environment, so INSTALL_HOOK's https/fetch wrappers silently no-op in tests.
// We test the wrapper logic directly by installing via eval (which has require
// in its lexical scope) using the same code from INSTALL_HOOK.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getHttpsModule = (): any => { try { return eval("require('https')"); } catch { return null; } };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const EventEmitterClass = (): any => { try { return eval("require('events')"); } catch { return null; } };

/**
 * Install ONLY the https.request wrapper from INSTALL_HOOK, using eval so
 * require() is available. Sets up a state object and returns it.
 * The mockReqFactory is pre-installed as https.request before the wrapper
 * captures it as origHttpsRequest.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function installHttpsWrapper(mockReqFactory: (...args: any[]) => any): Record<string, unknown> {
  const https = getHttpsModule();
  if (!https) throw new Error("https module not available");
  https.request = mockReqFactory;
  // Install wrapper via eval (same code as INSTALL_HOOK's https section)
  const state: Record<string, unknown> = {};
  eval(`
    (function() {
      var https = require('https');
      var origHttpsRequest = https.request;
      var state = arguments[0];
      https.request = function(options) {
        var h = (options && options.hostname) || '';
        var p = (options && options.path) || '';
        if (h === 'api.anthropic.com' && p.indexOf('/api/web/domain_info') !== -1) {
          var EventEmitter = require('events');
          var res = new EventEmitter();
          res.statusCode = 200;
          res.headers = { 'content-type': 'application/json' };
          res.destroy = function() {};
          var req = new EventEmitter();
          req.write = function() {};
          req.end = function() {
            setTimeout(function() {
              req.emit('response', res);
              res.emit('data', Buffer.from(JSON.stringify({ domain: h, can_fetch: true })));
              res.emit('end');
            }, 0);
          };
          req.abort = function() {};
          req.destroy = function() { return req; };
          req.on('error', function() {});
          req.setTimeout = function() { return req; };
          req.destroyed = false;
          if (typeof arguments[1] === 'function') {
            req.on('response', arguments[1]);
          }
          return req;
        }
        var origReq = origHttpsRequest.apply(this, arguments);
        var hardTimer = setTimeout(function() {
          if (!origReq.destroyed) {
            state.httpsTimeouts = (state.httpsTimeouts || 0) + 1;
            origReq.destroy(new Error('HTTPS hard timeout: request exceeded 90000ms'));
          }
        }, 90000);
        origReq.on('close', function() { clearTimeout(hardTimer); });
        return origReq;
      };
    })(state)
  `);
  return state;
}

describe("INSTALL_HOOK https.request hard timeout", () => {
  let savedStringify: typeof JSON.stringify;
  let savedParse: typeof JSON.parse;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let origHttpsRequest: any;

  beforeEach(() => {
    savedStringify = JSON.stringify;
    savedParse = JSON.parse;
    const https = getHttpsModule();
    if (https) origHttpsRequest = https.request;
  });

  afterEach(() => {
    JSON.stringify = savedStringify;
    JSON.parse = savedParse;
    const https = getHttpsModule();
    if (https && origHttpsRequest) https.request = origHttpsRequest;
    cleanupGlobalHook();
  });

  it("wraps https.request after installation", () => {
    const https = getHttpsModule();
    if (!https) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mock = function() {} as any;
    installHttpsWrapper(mock);
    // After install, https.request should be a different function (the wrapper)
    expect(https.request).not.toBe(mock);
  });

  it("domain blocklist bypass returns fake req for domain_info", () => {
    const EE = EventEmitterClass();
    if (!EE) return;
    const mock = () => new EE();
    installHttpsWrapper(mock);
    const https = getHttpsModule();

    const req = https.request({ hostname: "api.anthropic.com", path: "/api/web/domain_info?domain=example.com" });
    expect(typeof req.write).toBe("function");
    expect(typeof req.end).toBe("function");
    expect(typeof req.destroy).toBe("function");
  });

  it("clears hard timer when request emits close", async () => {
    const { vi } = await import("vitest");
    const EE = EventEmitterClass();
    if (!EE) return;

    const mockReq = new EE();
    mockReq.destroyed = false;
    mockReq.destroy = function() { this.destroyed = true; this.emit("close"); };
    // Install wrapper before fake timers (eval needs real require)
    const state = installHttpsWrapper(() => mockReq);

    vi.useFakeTimers();
    try {
      const https = getHttpsModule();
      https.request({ hostname: "api.example.com", path: "/data" });

      // Request completes normally
      mockReq.emit("close");

      // Advance past 90s — timer should already be cleared
      vi.advanceTimersByTime(91000);

      expect(state.httpsTimeouts).toBeUndefined();
      expect(mockReq.destroyed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroys request and increments httpsTimeouts on timeout", async () => {
    const { vi } = await import("vitest");
    const EE = EventEmitterClass();
    if (!EE) return;

    const mockReq = new EE();
    mockReq.destroyed = false;
    mockReq.destroy = function() { this.destroyed = true; };
    const state = installHttpsWrapper(() => mockReq);

    vi.useFakeTimers();
    try {
      const https = getHttpsModule();
      https.request({ hostname: "api.example.com", path: "/data" });

      vi.advanceTimersByTime(90001);

      expect(mockReq.destroyed).toBe(true);
      expect(state.httpsTimeouts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not destroy already-destroyed request on timeout", async () => {
    const { vi } = await import("vitest");
    const EE = EventEmitterClass();
    if (!EE) return;

    let destroyCallCount = 0;
    const mockReq = new EE();
    mockReq.destroyed = true; // Already destroyed
    mockReq.destroy = function() { destroyCallCount++; };
    const state = installHttpsWrapper(() => mockReq);

    vi.useFakeTimers();
    try {
      const https = getHttpsModule();
      https.request({ hostname: "api.example.com", path: "/data" });

      vi.advanceTimersByTime(90001);

      expect(destroyCallCount).toBe(0);
      expect(state.httpsTimeouts).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("increments httpsTimeouts for each timed-out request independently", async () => {
    const { vi } = await import("vitest");
    const EE = EventEmitterClass();
    if (!EE) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockReqs: any[] = [];
    const state = installHttpsWrapper(() => {
      const req = new EE();
      req.destroyed = false;
      req.destroy = function() { this.destroyed = true; };
      mockReqs.push(req);
      return req;
    });

    vi.useFakeTimers();
    try {
      const https = getHttpsModule();
      https.request({ hostname: "api.example.com", path: "/a" });
      https.request({ hostname: "api.example.com", path: "/b" });

      // First completes, second hangs
      mockReqs[0].emit("close");

      vi.advanceTimersByTime(90001);

      expect(mockReqs[0].destroyed).toBe(false);
      expect(mockReqs[1].destroyed).toBe(true);
      expect(state.httpsTimeouts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── POLL_STATE fetchTimeouts and httpsTimeouts fields ───────────────

describe("POLL_STATE timeout counter fields", () => {
  afterEach(cleanupGlobalHook);

  it("exposes fetchTimeouts from state", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__inspectorState = {
      n: 1, sid: null, cost: 0, model: null, stop: null,
      tools: [], inTok: 0, outTok: 0, events: [], lastEvent: null,
      firstMsg: null, lastText: null, userPrompt: null,
      permPending: false, idleDetected: false, toolAction: null,
      inputBuf: "", inputTs: 0, pendingDescs: [], subs: [],
      _sealed: false, fetchBypassed: 0, fetchTimeouts: 3, httpsTimeouts: 0,
    };
    const fn = new Function(`return ${POLL_STATE}`);
    const result = fn() as Record<string, unknown>;
    expect(result.fetchTimeouts).toBe(3);
  });

  it("exposes httpsTimeouts from state", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__inspectorState = {
      n: 1, sid: null, cost: 0, model: null, stop: null,
      tools: [], inTok: 0, outTok: 0, events: [], lastEvent: null,
      firstMsg: null, lastText: null, userPrompt: null,
      permPending: false, idleDetected: false, toolAction: null,
      inputBuf: "", inputTs: 0, pendingDescs: [], subs: [],
      _sealed: false, fetchBypassed: 0, fetchTimeouts: 0, httpsTimeouts: 5,
    };
    const fn = new Function(`return ${POLL_STATE}`);
    const result = fn() as Record<string, unknown>;
    expect(result.httpsTimeouts).toBe(5);
  });

  it("defaults to 0 when fields are undefined on state", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__inspectorState = {
      n: 1, sid: null, cost: 0, model: null, stop: null,
      tools: [], inTok: 0, outTok: 0, events: [], lastEvent: null,
      firstMsg: null, lastText: null, userPrompt: null,
      permPending: false, idleDetected: false, toolAction: null,
      inputBuf: "", inputTs: 0, pendingDescs: [], subs: [],
      _sealed: false,
    };
    const fn = new Function(`return ${POLL_STATE}`);
    const result = fn() as Record<string, unknown>;
    expect(result.fetchTimeouts).toBe(0);
    expect(result.httpsTimeouts).toBe(0);
    expect(result.fetchBypassed).toBe(0);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { INSTALL_HOOK, POLL_STATE } from "../inspectorHooks";
import { deriveStateFromPoll } from "../../hooks/useInspectorState";
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
    expect(state.perm).toBeNull();
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
    expect(state.subagentDescs).toEqual([]);
    expect(state.inputBuf).toBe("");
    expect(state.inputTs).toBe(0);
    expect(state.thinkingAccum).toEqual({});
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
    expect(state.perm).toBe("default");
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

  it("collects Agent descriptions into subagentDescs", () => {
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
    expect(state.subagentDescs).toEqual(["Search codebase", "Run tests"]);
    expect(state.toolAction).toBe("Agent: Run tests"); // Last one wins
  });

  it("caps subagentDescs at 20 entries", () => {
    const state = installAndGetState();
    for (let i = 0; i < 25; i++) {
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-6",
          stop_reason: "tool_use",
          content: [{ type: "tool_use", name: "Agent", input: { description: `task-${i}` } }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
    }
    expect((state.subagentDescs as string[]).length).toBe(20);
    // Should have the most recent 20 (shifted oldest)
    expect((state.subagentDescs as string[])[0]).toBe("task-5");
    expect((state.subagentDescs as string[])[19]).toBe("task-24");
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

  // ── Thinking block capture tests (SSE via JSON.parse) ─────────────

  /** Helper: simulate SSE thinking block via JSON.parse events */
  function emitThinkingSSE(index: number, text: string) {
    JSON.parse(JSON.stringify({ type: "content_block_start", index, content_block: { type: "thinking" } }));
    // Send text in chunks to simulate streaming
    const chunkSize = Math.max(1, Math.ceil(text.length / 3));
    for (let i = 0; i < text.length; i += chunkSize) {
      JSON.parse(JSON.stringify({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: text.slice(i, i + chunkSize) } }));
    }
    JSON.parse(JSON.stringify({ type: "content_block_stop", index }));
  }

  it("captures thinking via SSE delta accumulation", () => {
    const state = installAndGetState();
    emitThinkingSSE(0, "Let me analyze this problem step by step");
    const thinking = state.thinking as Array<{ x: string; ts: number; r: boolean }>;
    expect(thinking).toHaveLength(1);
    expect(thinking[0].x).toBe("Let me analyze this problem step by step");
    expect(thinking[0].r).toBe(false);
    expect(thinking[0].ts).toBeGreaterThan(0);
  });

  it("captures redacted_thinking blocks via SSE", () => {
    const state = installAndGetState();
    JSON.parse(JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking" } }));
    const thinking = state.thinking as Array<{ x: string; ts: number; r: boolean }>;
    expect(thinking).toHaveLength(1);
    expect(thinking[0].x).toBe("");
    expect(thinking[0].r).toBe(true);
  });

  it("captures mixed thinking and redacted_thinking blocks via SSE", () => {
    const state = installAndGetState();
    emitThinkingSSE(0, "Step 1 reasoning");
    JSON.parse(JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "redacted_thinking" } }));
    emitThinkingSSE(2, "Step 3 reasoning");
    const thinking = state.thinking as Array<{ x: string; ts: number; r: boolean }>;
    expect(thinking).toHaveLength(3);
    expect(thinking[0].x).toBe("Step 1 reasoning");
    expect(thinking[0].r).toBe(false);
    expect(thinking[1].x).toBe("");
    expect(thinking[1].r).toBe(true);
    expect(thinking[2].x).toBe("Step 3 reasoning");
    expect(thinking[2].r).toBe(false);
  });

  it("truncates thinking text at 10K chars via SSE", () => {
    const state = installAndGetState();
    const longThinking = "x".repeat(15000);
    emitThinkingSSE(0, longThinking);
    const thinking = state.thinking as Array<{ x: string; ts: number; r: boolean }>;
    expect(thinking).toHaveLength(1);
    // 10000 chars + "\n[truncated]" suffix
    expect(thinking[0].x.length).toBeLessThanOrEqual(10000 + 20);
    expect(thinking[0].x).toContain("[truncated]");
  });

  it("caps thinking ring buffer at 30 entries", () => {
    const state = installAndGetState();
    for (let i = 0; i < 35; i++) {
      emitThinkingSSE(0, `thinking-block-${i} with enough padding`);
    }
    const thinking = state.thinking as Array<{ x: string; ts: number; r: boolean }>;
    expect(thinking).toHaveLength(30);
    // Oldest entries should be evicted (shifted)
    expect(thinking[0].x).toContain("thinking-block-5");
    expect(thinking[29].x).toContain("thinking-block-34");
  });

  it("accumulates thinking blocks across multiple sequential SSE blocks", () => {
    const state = installAndGetState();
    emitThinkingSSE(0, "First turn thinking");
    emitThinkingSSE(0, "Second turn thinking");
    const thinking = state.thinking as Array<{ x: string; ts: number; r: boolean }>;
    expect(thinking).toHaveLength(2);
    expect(thinking[0].x).toBe("First turn thinking");
    expect(thinking[1].x).toBe("Second turn thinking");
  });

  it("drops empty thinking blocks (no deltas before stop)", () => {
    const state = installAndGetState();
    JSON.parse(JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }));
    JSON.parse(JSON.stringify({ type: "content_block_stop", index: 0 }));
    const thinking = state.thinking as Array<{ x: string; ts: number; r: boolean }>;
    expect(thinking).toHaveLength(0);
  });

  it("ignores non-thinking deltas", () => {
    const state = installAndGetState();
    // text_delta should not accumulate into thinking
    JSON.parse(JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "some text" } }));
    JSON.parse(JSON.stringify({ type: "content_block_stop", index: 0 }));
    const thinking = state.thinking as Array<{ x: string; ts: number; r: boolean }>;
    expect(thinking).toHaveLength(0);
  });

  it("handles JSON.parse errors gracefully", () => {
    installAndGetState();
    // Should not throw — origParse handles bad input
    expect(() => JSON.parse("not json")).toThrow(); // origParse throws
    // But structured SSE with bad data should not corrupt state
    JSON.parse(JSON.stringify({ type: "content_block_delta", index: 99, delta: { type: "thinking_delta", thinking: "orphan" } }));
    // No crash, orphan delta ignored since index 99 was never started
  });

  it("initializes thinking array and thinkingAccum in state", () => {
    const fn = new Function(`return ${INSTALL_HOOK}`);
    cleanupGlobalHook();
    fn();
    const g = globalThis as unknown as Record<string, unknown>;
    const state = g.__inspectorState as Record<string, unknown>;
    expect(state.thinking).toEqual([]);
    expect(state.thinkingAccum).toEqual({});
    cleanupGlobalHook();
  });
});

describe("POLL_STATE", () => {
  it("returns null when no state installed", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.__inspectorState;
    const fn = new Function(`return ${POLL_STATE}`);
    expect(fn()).toBeNull();
  });

  it("returns state and drains events", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__inspectorState = {
      n: 5,
      sid: "test-123",
      cost: 0.01,
      model: "claude-opus-4-6",
      stop: "end_turn",
      tools: ["Bash"],
      perm: "default",
      inTok: 1000,
      outTok: 500,
      dur: 0,
      events: [{ t: "assistant", sr: "end_turn" }, { t: "user" }],
      lastEvent: "user",
      firstMsg: "Hello",
      lastText: "Response text",
      userPrompt: "Hello",
      permPending: false,
      idleDetected: false,
      toolAction: "Bash: ls",
      subagentDescs: ["Search code"],
      inputBuf: "partial",
      inputTs: 12345,
      thinking: [],
      subs: [],
    };
    const fn = new Function(`return ${POLL_STATE}`);
    const result = fn() as Record<string, unknown>;
    expect(result.n).toBe(5);
    expect(result.sid).toBe("test-123");
    expect(result.events).toHaveLength(2);
    // Events should be drained from state
    expect((g.__inspectorState as Record<string, unknown[]>).events).toHaveLength(0);
  });

  it("returns new fields from enhanced state", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__inspectorState = {
      n: 3, sid: null, cost: 0, model: null, stop: null,
      tools: [], perm: null, inTok: 0, outTok: 0, dur: 0,
      events: [], lastEvent: null,
      firstMsg: "First message",
      lastText: "Last response",
      userPrompt: "Latest prompt",
      permPending: true,
      idleDetected: false,
      toolAction: "Read: /foo.ts",
      subagentDescs: ["task-1", "task-2"],
      inputBuf: "typed",
      inputTs: 99999,
      thinking: [],
      subs: [],
    };
    const fn = new Function(`return ${POLL_STATE}`);
    const result = fn() as Record<string, unknown>;
    expect(result.firstMsg).toBe("First message");
    expect(result.lastText).toBe("Last response");
    expect(result.userPrompt).toBe("Latest prompt");
    expect(result.permPending).toBe(true);
    expect(result.idleDetected).toBe(false);
    expect(result.toolAction).toBe("Read: /foo.ts");
    expect(result.subagentDescs).toEqual(["task-1", "task-2"]);
    expect(result.inputBuf).toBe("typed");
    expect(result.inputTs).toBe(99999);
  });

  it("resets transient flags after poll", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__inspectorState = {
      n: 1, sid: null, cost: 0, model: null, stop: null,
      tools: [], perm: null, inTok: 0, outTok: 0, dur: 0,
      events: [{ t: "user" }], lastEvent: null,
      firstMsg: null, lastText: null, userPrompt: null,
      permPending: true,
      idleDetected: true,
      toolAction: null, subagentDescs: [],
      inputBuf: "", inputTs: 0,
      thinking: [],
      subs: [],
    };
    const fn = new Function(`return ${POLL_STATE}`);
    const result = fn() as Record<string, unknown>;
    // Result should have the flags
    expect(result.permPending).toBe(true);
    expect(result.idleDetected).toBe(true);
    // State should be reset (permPending one-shot, idleDetected sticky)
    const state = g.__inspectorState as Record<string, unknown>;
    expect(state.permPending).toBe(false);
    expect(state.idleDetected).toBe(true); // sticky — cleared only by user event
    expect((state.events as unknown[]).length).toBe(0);
  });

  it("returns a copy of subagentDescs (not reference)", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const descs = ["task-a"];
    g.__inspectorState = {
      n: 0, sid: null, cost: 0, model: null, stop: null,
      tools: [], perm: null, inTok: 0, outTok: 0, dur: 0,
      events: [], lastEvent: null,
      firstMsg: null, lastText: null, userPrompt: null,
      permPending: false, idleDetected: false,
      toolAction: null, subagentDescs: descs,
      inputBuf: "", inputTs: 0,
      thinking: [],
      subs: [],
    };
    const fn = new Function(`return ${POLL_STATE}`);
    const result = fn() as Record<string, unknown>;
    // Mutating the result should not affect original
    (result.subagentDescs as string[]).push("task-b");
    expect(descs).toEqual(["task-a"]);
  });

  // ── Thinking block drain tests ──────────────────────────────────

  it("drains thinking blocks on poll via splice", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__inspectorState = {
      n: 2, sid: null, cost: 0, model: null, stop: null,
      tools: [], perm: null, inTok: 0, outTok: 0, dur: 0,
      events: [], lastEvent: null, firstMsg: null, lastText: null,
      userPrompt: null, permPending: false, idleDetected: false,
      toolAction: null, subagentDescs: [], inputBuf: "", inputTs: 0,
      thinking: [
        { x: "First thought", ts: 1000, r: false },
        { x: "", ts: 2000, r: true },
        { x: "Third thought", ts: 3000, r: false },
      ],
      subs: [],
    };
    const fn = new Function(`return ${POLL_STATE}`);
    const result = fn() as Record<string, unknown>;

    // Result should contain all thinking blocks
    const thinking = result.thinking as Array<{ x: string; ts: number; r: boolean }>;
    expect(thinking).toHaveLength(3);
    expect(thinking[0].x).toBe("First thought");
    expect(thinking[0].r).toBe(false);
    expect(thinking[1].x).toBe("");
    expect(thinking[1].r).toBe(true);
    expect(thinking[2].x).toBe("Third thought");

    // State thinking array should be empty after drain
    const stateObj = g.__inspectorState as Record<string, unknown>;
    expect((stateObj.thinking as unknown[]).length).toBe(0);
  });

  it("returns empty thinking array when no thinking blocks", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__inspectorState = {
      n: 0, sid: null, cost: 0, model: null, stop: null,
      tools: [], perm: null, inTok: 0, outTok: 0, dur: 0,
      events: [], lastEvent: null, firstMsg: null, lastText: null,
      userPrompt: null, permPending: false, idleDetected: false,
      toolAction: null, subagentDescs: [], inputBuf: "", inputTs: 0,
      thinking: [],
      subs: [],
    };
    const fn = new Function(`return ${POLL_STATE}`);
    const result = fn() as Record<string, unknown>;
    expect((result.thinking as unknown[]).length).toBe(0);
  });

  // ── choiceHint derivation tests ─────────────────────────────────

  it("returns choiceHint true when end_turn with numbered list in lastText", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__inspectorState = {
      n: 1, sid: null, cost: 0, model: null,
      stop: "end_turn",
      tools: [], perm: null, inTok: 0, outTok: 0, dur: 0,
      events: [], lastEvent: null, firstMsg: null,
      lastText: "Here are your options:\n1. Option A\n2. Option B\n3. Option C",
      userPrompt: null, permPending: false, idleDetected: false,
      toolAction: null, subagentDescs: [], inputBuf: "", inputTs: 0,
      thinking: [],
      subs: [],
    };
    const fn = new Function(`return ${POLL_STATE}`);
    const result = fn() as Record<string, unknown>;
    expect(result.choiceHint).toBe(true);
  });

  it("returns choiceHint false when stop is not end_turn", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__inspectorState = {
      n: 1, sid: null, cost: 0, model: null,
      stop: "tool_use",
      tools: [], perm: null, inTok: 0, outTok: 0, dur: 0,
      events: [], lastEvent: null, firstMsg: null,
      lastText: "Running:\n1. Step one\n2. Step two",
      userPrompt: null, permPending: false, idleDetected: false,
      toolAction: null, subagentDescs: [], inputBuf: "", inputTs: 0,
      thinking: [],
      subs: [],
    };
    const fn = new Function(`return ${POLL_STATE}`);
    const result = fn() as Record<string, unknown>;
    expect(result.choiceHint).toBe(false);
  });

  it("returns choiceHint false when lastText is null", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__inspectorState = {
      n: 1, sid: null, cost: 0, model: null,
      stop: "end_turn",
      tools: [], perm: null, inTok: 0, outTok: 0, dur: 0,
      events: [], lastEvent: null, firstMsg: null,
      lastText: null,
      userPrompt: null, permPending: false, idleDetected: false,
      toolAction: null, subagentDescs: [], inputBuf: "", inputTs: 0,
      thinking: [],
      subs: [],
    };
    const fn = new Function(`return ${POLL_STATE}`);
    const result = fn() as Record<string, unknown>;
    expect(result.choiceHint).toBe(false);
  });

  it("returns choiceHint false when lastText has no numbered list", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__inspectorState = {
      n: 1, sid: null, cost: 0, model: null,
      stop: "end_turn",
      tools: [], perm: null, inTok: 0, outTok: 0, dur: 0,
      events: [], lastEvent: null, firstMsg: null,
      lastText: "Here is my complete answer without any numbered items.",
      userPrompt: null, permPending: false, idleDetected: false,
      toolAction: null, subagentDescs: [], inputBuf: "", inputTs: 0,
      thinking: [],
      subs: [],
    };
    const fn = new Function(`return ${POLL_STATE}`);
    const result = fn() as Record<string, unknown>;
    expect(result.choiceHint).toBe(false);
  });

  it("returns choiceHint true only for digits 1-9 (not 0)", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__inspectorState = {
      n: 1, sid: null, cost: 0, model: null,
      stop: "end_turn",
      tools: [], perm: null, inTok: 0, outTok: 0, dur: 0,
      events: [], lastEvent: null, firstMsg: null,
      lastText: "Results:\n0. Zero item should not trigger",
      userPrompt: null, permPending: false, idleDetected: false,
      toolAction: null, subagentDescs: [], inputBuf: "", inputTs: 0,
      thinking: [],
      subs: [],
    };
    const fn = new Function(`return ${POLL_STATE}`);
    const result = fn() as Record<string, unknown>;
    expect(result.choiceHint).toBe(false);
  });
});

describe("deriveStateFromPoll", () => {
  const basePoll = {
    n: 1, sid: null, cost: 0, model: null, stop: null as string | null,
    tools: [] as string[], perm: null, inTok: 0, outTok: 0, dur: 0,
    events: [] as Array<{ t: string; sr?: string; c?: number; txt?: string; nt?: string; ta?: string }>,
    lastEvent: null as string | null,
    firstMsg: null, lastText: null, userPrompt: null,
    permPending: false, idleDetected: false, choiceHint: false,
    toolAction: null, subagentDescs: [] as string[],
    thinking: [] as Array<{ x: string; ts: number; r: boolean }>,
    inputBuf: "", inputTs: 0,
    subs: [] as Array<{ sid: string; desc: string; st: string; tok: number; act: string | null;
      msgs: Array<{ r: string; x: string; tn?: string }>; lastTs: number }>,
  };

  it("returns waitingPermission when permPending is true", () => {
    expect(deriveStateFromPoll({ ...basePoll, permPending: true }, "thinking")).toBe("waitingPermission");
  });

  it("returns idle when idleDetected is true", () => {
    expect(deriveStateFromPoll({ ...basePoll, idleDetected: true }, "thinking")).toBe("idle");
  });

  it("permPending overrides idleDetected", () => {
    // Both true: permPending wins (checked last)
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

  it("system event after end_turn does not mask idle (filtered from ring buffer)", () => {
    // After the fix, system events don't enter the ring buffer, so the last
    // event is the assistant end_turn, correctly deriving idle.
    const poll = {
      ...basePoll,
      events: [{ t: "assistant", sr: "end_turn" }],
    };
    expect(deriveStateFromPoll(poll, "thinking")).toBe("idle");
  });
});

describe("allocateInspectorPort", () => {
  it("returns sequential ports (wraps at boundary)", () => {
    const p1 = allocateInspectorPort();
    const p2 = allocateInspectorPort();
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
    // Also in subagentDescs
    expect((state.subagentDescs as string[])).toEqual(["Pending task"]);
  });
});

describe("POLL_STATE subagent draining", () => {
  afterEach(cleanupGlobalHook);

  it("drains subagent messages on poll", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__inspectorState = {
      n: 5, sid: "main", cost: 0, model: null, stop: null,
      tools: [], perm: null, inTok: 0, outTok: 0, dur: 0,
      events: [], lastEvent: null, firstMsg: null, lastText: null,
      userPrompt: null, permPending: false, idleDetected: false,
      toolAction: null, subagentDescs: [], inputBuf: "", inputTs: 0,
      pendingDescs: [],
      thinking: [],
      subs: [{
        sid: "sub-1", desc: "Test", st: "t", tok: 100, act: "Bash: ls",
        msgs: [{ r: "a", x: "hello" }, { r: "t", x: "output", tn: "Bash" }],
        lastTs: Date.now(),
      }],
    };

    const fn = new Function(`return ${POLL_STATE}`);
    const result = fn() as Record<string, unknown>;

    // Result should include subs with messages
    const subs = result.subs as Array<Record<string, unknown>>;
    expect(subs).toHaveLength(1);
    expect(subs[0].sid).toBe("sub-1");
    expect(subs[0].desc).toBe("Test");
    expect(subs[0].st).toBe("t");
    const msgs = subs[0].msgs as Array<Record<string, unknown>>;
    expect(msgs).toHaveLength(2);

    // Messages should be drained from state
    const stateObj = g.__inspectorState as { subs: Array<{ msgs: unknown[] }> };
    expect(stateObj.subs[0].msgs).toHaveLength(0);
  });

  it("returns empty subs array when no subagents", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__inspectorState = {
      n: 0, sid: null, cost: 0, model: null, stop: null,
      tools: [], perm: null, inTok: 0, outTok: 0, dur: 0,
      events: [], lastEvent: null, firstMsg: null, lastText: null,
      userPrompt: null, permPending: false, idleDetected: false,
      toolAction: null, subagentDescs: [], inputBuf: "", inputTs: 0,
      pendingDescs: [],
      thinking: [],
      subs: [],
    };

    const fn = new Function(`return ${POLL_STATE}`);
    const result = fn() as Record<string, unknown>;
    expect((result.subs as unknown[]).length).toBe(0);
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

  it("POLL_STATE does not reset idleDetected", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__inspectorState = {
      n: 1, sid: null, cost: 0, model: null, stop: "end_turn",
      tools: [], perm: null, inTok: 0, outTok: 0, dur: 0,
      events: [], lastEvent: "result", firstMsg: null, lastText: null,
      userPrompt: null, permPending: false, idleDetected: true,
      toolAction: null, subagentDescs: [], inputBuf: "", inputTs: 0,
      pendingDescs: [], thinking: [], subs: [], _sealed: true,
    };

    const fn = new Function(`return ${POLL_STATE}`);
    fn(); // first poll
    const stateObj = g.__inspectorState as Record<string, unknown>;
    expect(stateObj.idleDetected).toBe(true); // still sticky
  });

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

// ── actionNeeded state derivation tests ──────────────────────

describe("deriveStateFromPoll actionNeeded", () => {
  const basePoll = {
    n: 1, sid: null, cost: 0, model: null, stop: null as string | null,
    tools: [] as string[], perm: null, inTok: 0, outTok: 0, dur: 0,
    events: [] as Array<{ t: string; sr?: string; c?: number; txt?: string; nt?: string; ta?: string }>,
    lastEvent: null as string | null,
    firstMsg: null, lastText: null, userPrompt: null,
    permPending: false, idleDetected: false, choiceHint: false,
    toolAction: null, subagentDescs: [] as string[],
    thinking: [] as Array<{ x: string; ts: number; r: boolean }>,
    inputBuf: "", inputTs: 0,
    subs: [] as Array<{ sid: string; desc: string; st: string; tok: number; act: string | null;
      msgs: Array<{ r: string; x: string; tn?: string }>; lastTs: number }>,
  };

  it("ExitPlanMode tool_use → actionNeeded", () => {
    expect(deriveStateFromPoll({
      ...basePoll, stop: "tool_use", tools: ["ExitPlanMode"],
    }, "idle")).toBe("actionNeeded");
  });

  it("Bash tool_use → toolUse (not actionNeeded)", () => {
    expect(deriveStateFromPoll({
      ...basePoll, stop: "tool_use", tools: ["Bash"],
    }, "idle")).toBe("toolUse");
  });

  it("choiceHint + idle → actionNeeded", () => {
    expect(deriveStateFromPoll({
      ...basePoll, stop: "end_turn", choiceHint: true,
    }, "idle")).toBe("actionNeeded");
  });

  it("idleDetected + choiceHint → actionNeeded (choiceHint refines after idleDetected)", () => {
    expect(deriveStateFromPoll({
      ...basePoll, idleDetected: true, choiceHint: true,
    }, "thinking")).toBe("actionNeeded");
  });

  it("permPending overrides actionNeeded → waitingPermission", () => {
    expect(deriveStateFromPoll({
      ...basePoll, stop: "tool_use", tools: ["ExitPlanMode"], permPending: true,
    }, "idle")).toBe("waitingPermission");
  });

  it("ExitPlanMode via events (not persisted stop) → actionNeeded", () => {
    expect(deriveStateFromPoll({
      ...basePoll, tools: ["ExitPlanMode"],
      events: [{ t: "assistant", sr: "tool_use" }],
    }, "idle")).toBe("actionNeeded");
  });

  it("choiceHint without idle state has no effect (toolUse stays toolUse)", () => {
    // choiceHint only refines idle → actionNeeded; toolUse is unaffected
    expect(deriveStateFromPoll({
      ...basePoll, stop: "tool_use", choiceHint: true,
    }, "idle")).toBe("toolUse");
  });

  it("idleDetected alone (no choiceHint) → idle, not actionNeeded", () => {
    expect(deriveStateFromPoll({
      ...basePoll, idleDetected: true, choiceHint: false,
    }, "thinking")).toBe("idle");
  });

  it("ExitPlanMode + idleDetected → actionNeeded (idleDetected→idle, then choiceHint absent keeps idle)", () => {
    // ExitPlanMode refines toolUse→actionNeeded, then idleDetected overrides to idle
    expect(deriveStateFromPoll({
      ...basePoll, stop: "tool_use", tools: ["ExitPlanMode"], idleDetected: true,
    }, "idle")).toBe("idle");
  });

  it("ExitPlanMode + idleDetected + choiceHint → actionNeeded", () => {
    // ExitPlanMode→actionNeeded, idleDetected→idle, choiceHint→actionNeeded
    expect(deriveStateFromPoll({
      ...basePoll, stop: "tool_use", tools: ["ExitPlanMode"], idleDetected: true, choiceHint: true,
    }, "idle")).toBe("actionNeeded");
  });

  it("permPending overrides choiceHint actionNeeded → waitingPermission", () => {
    expect(deriveStateFromPoll({
      ...basePoll, stop: "end_turn", choiceHint: true, permPending: true,
    }, "idle")).toBe("waitingPermission");
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

  it("sealed blocks subagentDescs growth from post-completion Agent tool_use", () => {
    const state = installAndGetState();
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "end_turn", content: [], usage: { input_tokens: 10, output_tokens: 5 } },
    });
    JSON.stringify({ type: "result", total_cost_usd: 0.01 });

    // Sealed assistant with Agent tool_use — subagentDescs should NOT grow
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6", stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Agent", input: { description: "Ghost agent" } }],
        usage: { input_tokens: 0, output_tokens: 0 } },
    });
    expect(state.subagentDescs).toEqual([]);
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

  it("idleDetected persists across multiple POLL_STATE calls", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__inspectorState = {
      n: 1, sid: null, cost: 0, model: null, stop: "end_turn",
      tools: [], perm: null, inTok: 0, outTok: 0, dur: 0,
      events: [], lastEvent: "result", firstMsg: null, lastText: null,
      userPrompt: null, permPending: false, idleDetected: true,
      toolAction: null, subagentDescs: [], inputBuf: "", inputTs: 0,
      pendingDescs: [], thinking: [], subs: [], _sealed: true,
    };

    const fn = new Function(`return ${POLL_STATE}`);
    const result1 = fn() as Record<string, unknown>;
    expect(result1.idleDetected).toBe(true);

    const result2 = fn() as Record<string, unknown>;
    expect(result2.idleDetected).toBe(true);

    const result3 = fn() as Record<string, unknown>;
    expect(result3.idleDetected).toBe(true);

    const stateObj = g.__inspectorState as Record<string, unknown>;
    expect(stateObj.idleDetected).toBe(true);
  });

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

// ── SSE thinking via JSON.parse edge cases ─────────────────────

describe("INSTALL_HOOK SSE thinking edge cases", () => {
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

  it("concurrent thinking blocks with different indices accumulate independently", () => {
    const state = installAndGetState();
    // Start two thinking blocks at different indices
    JSON.parse(JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }));
    JSON.parse(JSON.stringify({ type: "content_block_start", index: 2, content_block: { type: "thinking" } }));

    // Interleave deltas
    JSON.parse(JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Block zero " } }));
    JSON.parse(JSON.stringify({ type: "content_block_delta", index: 2, delta: { type: "thinking_delta", thinking: "Block two " } }));
    JSON.parse(JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "continued" } }));
    JSON.parse(JSON.stringify({ type: "content_block_delta", index: 2, delta: { type: "thinking_delta", thinking: "continued" } }));

    // Stop them
    JSON.parse(JSON.stringify({ type: "content_block_stop", index: 0 }));
    JSON.parse(JSON.stringify({ type: "content_block_stop", index: 2 }));

    const thinking = state.thinking as Array<{ x: string; ts: number; r: boolean }>;
    expect(thinking).toHaveLength(2);
    expect(thinking[0].x).toBe("Block zero continued");
    expect(thinking[1].x).toBe("Block two continued");
  });

  it("content_block_stop for non-thinking index is a no-op", () => {
    const state = installAndGetState();
    // Stop without start — no crash, no entry
    JSON.parse(JSON.stringify({ type: "content_block_stop", index: 5 }));
    const thinking = state.thinking as Array<{ x: string; ts: number; r: boolean }>;
    expect(thinking).toHaveLength(0);
  });

  it("thinkingAccum is cleaned up after stop (no memory leak)", () => {
    const state = installAndGetState();
    JSON.parse(JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }));
    JSON.parse(JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hello" } }));

    // Before stop, accumulator exists
    const accum = state.thinkingAccum as Record<number, string>;
    expect(accum[0]).toBe("hello");

    JSON.parse(JSON.stringify({ type: "content_block_stop", index: 0 }));

    // After stop, accumulator entry is deleted
    expect(accum[0]).toBeUndefined();
  });

  it("thinkingAccum does not appear in POLL_STATE output", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__inspectorState = {
      n: 1, sid: null, cost: 0, model: null, stop: null,
      tools: [], perm: null, inTok: 0, outTok: 0, dur: 0,
      events: [], lastEvent: null, firstMsg: null, lastText: null,
      userPrompt: null, permPending: false, idleDetected: false,
      toolAction: null, subagentDescs: [], inputBuf: "", inputTs: 0,
      pendingDescs: [], thinking: [], subs: [],
      thinkingAccum: { 0: "partial" }, _sealed: false,
    };

    const fn = new Function(`return ${POLL_STATE}`);
    const result = fn() as Record<string, unknown>;
    expect(result.thinkingAccum).toBeUndefined();
  });

  it("content_block_start without index field does not crash", () => {
    const state = installAndGetState();
    // Malformed SSE event — no index
    JSON.parse(JSON.stringify({ type: "content_block_start", content_block: { type: "thinking" } }));
    // This creates thinkingAccum[undefined] = '' — stop should clean it up
    JSON.parse(JSON.stringify({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "test" } }));
    JSON.parse(JSON.stringify({ type: "content_block_stop" }));
    // Should not crash; entry accumulates at key "undefined"
    const thinking = state.thinking as Array<{ x: string; ts: number; r: boolean }>;
    expect(thinking).toHaveLength(1);
    expect(thinking[0].x).toBe("test");
  });
});

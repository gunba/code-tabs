import { describe, it, expect } from "vitest";
import {
  processJsonlEvent,
  createAccumulator,
  modelPricing,
  formatToolAction,
} from "../jsonlState";

describe("processJsonlEvent", () => {
  // ── assistant events ────────────────────────────────────────────────

  it("sets state to idle on assistant with stop_reason: end_turn", () => {
    const acc = createAccumulator();
    const event = {
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "Done!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    };
    const result = processJsonlEvent(acc, event);
    expect(result.state).toBe("idle");
  });

  it("sets state to toolUse on assistant with stop_reason: tool_use", () => {
    const acc = createAccumulator();
    const event = {
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 200, output_tokens: 100 },
      },
    };
    const result = processJsonlEvent(acc, event);
    expect(result.state).toBe("toolUse");
    expect(result.currentToolName).toBe("Bash");
    expect(result.currentAction).toBe("Bash: npm test");
  });

  it("sets state to thinking when no stop_reason", () => {
    const acc = createAccumulator();
    const event = {
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "Thinking about it..." }],
        usage: { input_tokens: 50, output_tokens: 20 },
      },
    };
    const result = processJsonlEvent(acc, event);
    expect(result.state).toBe("thinking");
  });

  it("extracts last assistant text for speech bubble", () => {
    const acc = createAccumulator();
    const event = {
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "First line\nSecond line\nThird line" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    };
    const result = processJsonlEvent(acc, event);
    expect(result.lastAssistantText).toBe("First line\nSecond line\nThird line");
  });

  it("extracts subagent activity from Agent tool_use blocks", () => {
    const acc = createAccumulator();
    const event = {
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [
          { type: "tool_use", id: "toolu_1", name: "Agent", input: { subagent_type: "Explore", description: "Search codebase" } },
          { type: "tool_use", id: "toolu_2", name: "Agent", input: { subagent_type: "Plan", description: "Design approach" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 500, output_tokens: 200 },
      },
    };
    const result = processJsonlEvent(acc, event);
    expect(result.subagentCount).toBe(2);
    expect(result.subagentActivity).toEqual([
      "Explore: Search codebase",
      "Plan: Design approach",
    ]);
  });

  // ── Cost accumulation ───────────────────────────────────────────────

  it("accumulates tokens and cost across multiple assistant events", () => {
    let acc = createAccumulator();

    acc = processJsonlEvent(acc, {
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "Hello" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1000, output_tokens: 500 },
      },
    });

    expect(acc.inputTokens).toBe(1000);
    expect(acc.outputTokens).toBe(500);
    const cost1 = acc.costUsd;

    acc = processJsonlEvent(acc, {
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "More" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 2000, output_tokens: 1000 },
      },
    });

    expect(acc.inputTokens).toBe(3000);
    expect(acc.outputTokens).toBe(1500);
    expect(acc.costUsd).toBeGreaterThan(cost1);
  });

  it("excludes cache_read_input_tokens from token count", () => {
    const acc = createAccumulator();
    const result = processJsonlEvent(acc, {
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 500 },
      },
    });

    // Only non-cached input tokens are counted to avoid inflated totals
    expect(result.inputTokens).toBe(100);
  });

  // ── user events ─────────────────────────────────────────────────────

  it("sets state to thinking on user with tool_result", () => {
    const acc = { ...createAccumulator(), state: "toolUse" as const };
    const event = {
      type: "user",
      message: {
        content: [{ type: "tool_result", content: "Tests passed" }],
      },
    };
    const result = processJsonlEvent(acc, event);
    expect(result.state).toBe("thinking");
    expect(result.currentAction).toBeNull();
    expect(result.currentToolName).toBeNull();
  });

  it("preserves state on user event without tool_result", () => {
    const acc = { ...createAccumulator(), state: "idle" as const };
    const event = {
      type: "user",
      message: {
        content: [{ type: "text", text: "Do something" }],
      },
    };
    const result = processJsonlEvent(acc, event);
    expect(result.state).toBe("idle");
  });

  // ── progress events ─────────────────────────────────────────────────

  it("maintains toolUse state on progress events", () => {
    const acc = {
      ...createAccumulator(),
      state: "toolUse" as const,
      currentToolName: "Bash",
    };
    const event = {
      type: "progress",
      data: { type: "bash_progress", output: "running...", elapsedTimeSeconds: 3 },
    };
    const result = processJsonlEvent(acc, event);
    expect(result.state).toBe("toolUse");
    expect(result.currentAction).toBe("Bash: running (3s)");
  });

  it("ignores progress events when state is idle (stale progress)", () => {
    const acc = {
      ...createAccumulator(),
      state: "idle" as const,
      currentToolName: "Bash",
    };
    const event = {
      type: "progress",
      data: { elapsedTimeSeconds: 5 },
    };
    const result = processJsonlEvent(acc, event);
    expect(result.state).toBe("idle");
    expect(result.currentAction).toBeNull();
  });

  it("ignores progress events when state is thinking", () => {
    const acc = {
      ...createAccumulator(),
      state: "thinking" as const,
    };
    const event = {
      type: "progress",
      data: { elapsedTimeSeconds: 2 },
    };
    const result = processJsonlEvent(acc, event);
    expect(result.state).toBe("thinking");
  });

  // ── result events ───────────────────────────────────────────────────

  it("sets state to idle on result event", () => {
    const acc = { ...createAccumulator(), state: "thinking" as const };
    const event = { type: "result", total_cost_usd: 1.23 };
    const result = processJsonlEvent(acc, event);
    expect(result.state).toBe("idle");
    expect(result.costUsd).toBe(1.23);
  });

  it("clears currentAction and currentToolName on result event", () => {
    const acc = {
      ...createAccumulator(),
      state: "toolUse" as const,
      currentAction: "Bash: npm test",
      currentToolName: "Bash",
    };
    const event = { type: "result", total_cost_usd: 0.5 };
    const result = processJsonlEvent(acc, event);
    expect(result.state).toBe("idle");
    expect(result.currentAction).toBeNull();
    expect(result.currentToolName).toBeNull();
  });

  // ── system events ───────────────────────────────────────────────────

  it("sets contextWarning on compact_boundary system event", () => {
    const acc = createAccumulator();
    const event = { type: "system", subtype: "compact_boundary" };
    const result = processJsonlEvent(acc, event);
    expect(result.contextWarning).toBe("auto-compacting");
  });

  // ── unknown events ──────────────────────────────────────────────────

  it("passes through unknown event types unchanged", () => {
    const acc = createAccumulator();
    const event = { type: "unknown_type", data: "whatever" };
    const result = processJsonlEvent(acc, event);
    expect(result).toEqual(acc);
  });
});

describe("modelPricing", () => {
  it("returns haiku pricing for haiku models", () => {
    expect(modelPricing("claude-haiku-4-5")).toEqual([0.80, 4.00]);
  });

  it("returns sonnet pricing for sonnet models", () => {
    expect(modelPricing("claude-sonnet-4-6")).toEqual([3.00, 15.00]);
  });

  it("returns opus pricing as default", () => {
    expect(modelPricing("claude-opus-4-6")).toEqual([15.00, 75.00]);
    expect(modelPricing("")).toEqual([15.00, 75.00]);
  });
});

describe("formatToolAction", () => {
  it("formats Bash with command", () => {
    expect(formatToolAction({ name: "Bash", input: { command: "npm test" } }))
      .toBe("Bash: npm test");
  });

  it("formats Read with file_path", () => {
    expect(formatToolAction({ name: "Read", input: { file_path: "/src/main.ts" } }))
      .toBe("Read /src/main.ts");
  });

  it("formats Write with file_path", () => {
    expect(formatToolAction({ name: "Write", input: { file_path: "/src/new.ts" } }))
      .toBe("Write /src/new.ts");
  });

  it("formats Edit with file_path", () => {
    expect(formatToolAction({ name: "Edit", input: { file_path: "/src/edit.ts" } }))
      .toBe("Edit /src/edit.ts");
  });

  it("formats Grep with pattern", () => {
    expect(formatToolAction({ name: "Grep", input: { pattern: "TODO" } }))
      .toBe('Grep "TODO"');
  });

  it("formats Glob with pattern", () => {
    expect(formatToolAction({ name: "Glob", input: { pattern: "**/*.ts" } }))
      .toBe("Glob **/*.ts");
  });

  it("formats Agent with description", () => {
    expect(formatToolAction({ name: "Agent", input: { description: "find files" } }))
      .toBe("Agent: find files");
  });

  it("returns name for unknown tools", () => {
    expect(formatToolAction({ name: "WebFetch", input: {} }))
      .toBe("WebFetch");
  });

  it("truncates long actions to 200 chars", () => {
    const longPath = "/very/long/" + "x".repeat(300) + "/file.ts";
    const result = formatToolAction({ name: "Read", input: { file_path: longPath } });
    expect(result.length).toBeLessThanOrEqual(200);
  });
});

describe("createAccumulator", () => {
  it("initializes with starting state and zero values", () => {
    const acc = createAccumulator();
    expect(acc.state).toBe("starting");
    expect(acc.costUsd).toBe(0);
    expect(acc.inputTokens).toBe(0);
    expect(acc.outputTokens).toBe(0);
    expect(acc.assistantMessageCount).toBe(0);
    expect(acc.currentAction).toBeNull();
    expect(acc.currentToolName).toBeNull();
    expect(acc.subagentCount).toBe(0);
    expect(acc.subagentActivity).toEqual([]);
    expect(acc.lastAssistantText).toBe("");
  });
});

describe("assistantMessageCount", () => {
  it("increments on each assistant event", () => {
    let acc = createAccumulator();
    expect(acc.assistantMessageCount).toBe(0);

    acc = processJsonlEvent(acc, {
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "Hello" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    });
    expect(acc.assistantMessageCount).toBe(1);

    acc = processJsonlEvent(acc, {
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "More" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 200, output_tokens: 100 },
      },
    });
    expect(acc.assistantMessageCount).toBe(2);
  });

  it("does not increment on non-assistant events", () => {
    let acc = createAccumulator();
    acc = processJsonlEvent(acc, { type: "user", message: { content: [{ type: "text", text: "hi" }] } });
    expect(acc.assistantMessageCount).toBe(0);
    acc = processJsonlEvent(acc, { type: "result", total_cost_usd: 0.5 });
    expect(acc.assistantMessageCount).toBe(0);
  });
});

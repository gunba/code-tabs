import { describe, it, expect } from "vitest";
import { buildMainTabEntries, buildSubagentTabs, filterAgentBlocks, collectAgentToolIds } from "../contextProjection";
import type { SystemPromptBlock, CapturedMessage, CapturedContentBlock } from "../../types/session";

// ── Helpers ─────────────────────────────────────────────

function textBlock(text: string): CapturedContentBlock {
  return { type: "text", text };
}

function toolUseBlock(name: string, input: unknown, id?: string): CapturedContentBlock {
  return { type: "tool_use", id, name, input };
}

function toolResultBlock(toolUseId: string, text: string, isError = false): CapturedContentBlock {
  return { type: "tool_result", toolUseId, text, isError };
}

function msg(role: string, content: CapturedContentBlock[]): CapturedMessage {
  return { role, content };
}

// ── collectAgentToolIds ─────────────────────────────────

describe("collectAgentToolIds", () => {
  it("collects ids from tool_use blocks with id", () => {
    const messages: CapturedMessage[] = [
      msg("assistant", [toolUseBlock("Agent", {}, "toolu_1"), toolUseBlock("Bash", {}, "toolu_2")]),
      msg("user", [toolResultBlock("toolu_1", "r1"), toolResultBlock("toolu_2", "r2")]),
    ];
    const ids = collectAgentToolIds(messages);
    expect(ids.has("toolu_1")).toBe(true);
    expect(ids.has("toolu_2")).toBe(false);
  });

  it("recovers ids positionally when tool_use.id is missing (old data)", () => {
    const messages: CapturedMessage[] = [
      msg("assistant", [
        toolUseBlock("Agent", { description: "explore" }), // no id
        toolUseBlock("Bash", { command: "ls" }),            // no id
      ]),
      msg("user", [
        toolResultBlock("toolu_real_1", "agent result"),
        toolResultBlock("toolu_real_2", "bash result"),
      ]),
    ];
    const ids = collectAgentToolIds(messages);
    // Position 0 is Agent → should recover toolu_real_1
    expect(ids.has("toolu_real_1")).toBe(true);
    // Position 1 is Bash → should NOT be collected
    expect(ids.has("toolu_real_2")).toBe(false);
  });

  it("handles mixed: some tool_use blocks with id, some without", () => {
    const messages: CapturedMessage[] = [
      msg("assistant", [
        toolUseBlock("Agent", {}, "toolu_a"),           // has id
        toolUseBlock("Agent", { description: "b" }),    // no id
      ]),
      msg("user", [
        toolResultBlock("toolu_a", "r1"),
        toolResultBlock("toolu_b", "r2"),
      ]),
    ];
    const ids = collectAgentToolIds(messages);
    expect(ids.has("toolu_a")).toBe(true);
    expect(ids.has("toolu_b")).toBe(true); // recovered positionally
  });
});

// ── filterAgentBlocks ───────────────────────────────────

describe("filterAgentBlocks", () => {
  it("returns null when all blocks are Agent-related", () => {
    const agentIds = new Set(["toolu_1"]);
    const m = msg("assistant", [toolUseBlock("Agent", { description: "test" }, "toolu_1")]);
    expect(filterAgentBlocks(m, agentIds)).toBeNull();
  });

  it("preserves non-Agent blocks in mixed messages", () => {
    const agentIds = new Set(["toolu_1"]);
    const m = msg("assistant", [
      toolUseBlock("Agent", { description: "test" }, "toolu_1"),
      toolUseBlock("Bash", { command: "ls" }, "toolu_2"),
    ]);
    const result = filterAgentBlocks(m, agentIds);
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe("Bash");
  });

  it("filters tool_result blocks matching Agent ids", () => {
    const agentIds = new Set(["toolu_1"]);
    const m = msg("user", [
      toolResultBlock("toolu_1", "agent result"),
      toolResultBlock("toolu_2", "bash result"),
    ]);
    const result = filterAgentBlocks(m, agentIds);
    expect(result).toHaveLength(1);
    expect(result![0].toolUseId).toBe("toolu_2");
  });

  it("returns full content when no Agent blocks present", () => {
    const agentIds = new Set<string>();
    const content = [textBlock("hello"), toolUseBlock("Read", {}, "toolu_3")];
    const m = msg("assistant", content);
    const result = filterAgentBlocks(m, agentIds);
    expect(result).toHaveLength(2);
  });
});

// ── buildMainTabEntries ─────────────────────────────────

describe("buildMainTabEntries", () => {
  it("produces system entries from blocks", () => {
    const blocks: SystemPromptBlock[] = [
      { text: "Block one" },
      { text: "Block two", cacheControl: { type: "ephemeral" } },
      { text: "Block three" },
    ];
    const entries = buildMainTabEntries(blocks, null, 1);

    // sys-0, sys-1, cache-boundary, sys-2
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({ kind: "system", index: 0 });
    expect(entries[1]).toMatchObject({ kind: "system", index: 1, isCacheBoundary: true });
    expect(entries[2]).toMatchObject({ kind: "cache-boundary" });
    expect(entries[3]).toMatchObject({ kind: "system", index: 2 });
  });

  it("no cache boundary when last block is cached", () => {
    const blocks: SystemPromptBlock[] = [
      { text: "Block one" },
      { text: "Block two", cacheControl: { type: "ephemeral" } },
    ];
    const entries = buildMainTabEntries(blocks, null, 1);
    expect(entries).toHaveLength(2);
    expect(entries.find(e => e.kind === "cache-boundary")).toBeUndefined();
  });

  it("filters out Agent messages entirely when only Agent blocks", () => {
    const blocks: SystemPromptBlock[] = [];
    const messages: CapturedMessage[] = [
      msg("user", [textBlock("Hello")]),
      msg("assistant", [
        textBlock("Let me use an agent"),
        toolUseBlock("Agent", { description: "explore" }, "toolu_1"),
      ]),
      msg("user", [toolResultBlock("toolu_1", "agent result")]),
      msg("assistant", [textBlock("Done")]),
    ];
    const entries = buildMainTabEntries(blocks, messages, -1);

    // msg 0: user "Hello" → kept
    // msg 1: assistant with text + Agent → text kept, Agent removed
    // msg 2: user with only Agent result → dropped
    // msg 3: assistant "Done" → kept
    const msgEntries = entries.filter(e => e.kind === "message");
    expect(msgEntries).toHaveLength(3);
  });

  it("handles null messages", () => {
    const entries = buildMainTabEntries([{ text: "sys" }], null, -1);
    expect(entries).toHaveLength(1);
  });

  it("handles empty messages", () => {
    const entries = buildMainTabEntries([], [], -1);
    expect(entries).toHaveLength(0);
  });

  it("filters Agent tool_results from old data without tool_use.id (positional)", () => {
    const messages: CapturedMessage[] = [
      msg("user", [textBlock("Hello")]),
      msg("assistant", [
        toolUseBlock("Agent", { description: "explore" }), // no id
      ]),
      msg("user", [toolResultBlock("toolu_real", "agent result")]),
      msg("assistant", [textBlock("Done")]),
    ];
    const entries = buildMainTabEntries([], messages, -1);
    const msgEntries = entries.filter(e => e.kind === "message");
    // msg 0: user Hello → kept
    // msg 1: assistant with only Agent tool_use → dropped
    // msg 2: user with only Agent result (recovered positionally) → dropped
    // msg 3: assistant Done → kept
    expect(msgEntries).toHaveLength(2);
  });
});

// ── buildSubagentTabs ───────────────────────────────────

describe("buildSubagentTabs", () => {
  it("extracts one tab per Agent tool_use", () => {
    const messages: CapturedMessage[] = [
      msg("user", [textBlock("Do something")]),
      msg("assistant", [
        toolUseBlock("Agent", { description: "Explore codebase", prompt: "Find files" }, "toolu_1"),
        toolUseBlock("Agent", { description: "Plan implementation", prompt: "Design approach" }, "toolu_2"),
      ]),
      msg("user", [
        toolResultBlock("toolu_1", "Found files: a.ts, b.ts"),
        toolResultBlock("toolu_2", "Plan: step 1, step 2"),
      ]),
    ];

    const tabs = buildSubagentTabs(messages);
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toMatchObject({
      id: "toolu_1",
      label: "Explore codebase",
      promptText: "Find files",
      resultText: "Found files: a.ts, b.ts",
    });
    expect(tabs[1]).toMatchObject({
      id: "toolu_2",
      label: "Plan implementation",
      promptText: "Design approach",
      resultText: "Plan: step 1, step 2",
    });
  });

  it("marks pending tabs when no tool_result yet", () => {
    const messages: CapturedMessage[] = [
      msg("assistant", [
        toolUseBlock("Agent", { description: "Running task" , prompt: "Do it" }, "toolu_1"),
      ]),
    ];
    const tabs = buildSubagentTabs(messages);
    expect(tabs).toHaveLength(1);
    expect(tabs[0].resultText).toBeNull();
  });

  it("uses positional fallback id when tool_use.id is missing", () => {
    const messages: CapturedMessage[] = [
      msg("assistant", [
        toolUseBlock("Agent", { description: "Task A", prompt: "A" }),
        toolUseBlock("Agent", { description: "Task B", prompt: "B" }),
      ]),
    ];
    const tabs = buildSubagentTabs(messages);
    expect(tabs[0].id).toBe("agent-0");
    expect(tabs[1].id).toBe("agent-1");
  });

  it("pairs results positionally for old data without tool_use.id", () => {
    const messages: CapturedMessage[] = [
      msg("assistant", [
        toolUseBlock("Agent", { description: "Task A", prompt: "A" }), // no id
        toolUseBlock("Agent", { description: "Task B", prompt: "B" }), // no id
      ]),
      msg("user", [
        toolResultBlock("toolu_real_1", "Result A"),
        toolResultBlock("toolu_real_2", "Result B"),
      ]),
    ];
    const tabs = buildSubagentTabs(messages);
    expect(tabs).toHaveLength(2);
    expect(tabs[0].resultText).toBe("Result A");
    expect(tabs[1].resultText).toBe("Result B");
  });

  it("truncates long descriptions", () => {
    const longDesc = "This is a very long description that exceeds thirty characters";
    const messages: CapturedMessage[] = [
      msg("assistant", [
        toolUseBlock("Agent", { description: longDesc, prompt: "" }, "toolu_1"),
      ]),
    ];
    const tabs = buildSubagentTabs(messages);
    expect(tabs[0].label.length).toBeLessThanOrEqual(31); // 30 + ellipsis
    expect(tabs[0].label.endsWith("\u2026")).toBe(true);
  });

  it("returns empty for null messages", () => {
    expect(buildSubagentTabs(null)).toEqual([]);
  });

  it("returns empty when no Agent calls", () => {
    const messages: CapturedMessage[] = [
      msg("user", [textBlock("Hello")]),
      msg("assistant", [textBlock("Hi")]),
    ];
    expect(buildSubagentTabs(messages)).toEqual([]);
  });
});

// ── compaction-boundary handling ────────────────────────

describe("buildMainTabEntries — compaction", () => {
  function compaction(text: string): CapturedMessage {
    return { role: "system", content: [{ type: "compaction_summary", text }] };
  }

  it("emits a compaction-boundary entry instead of a normal message", () => {
    const messages: CapturedMessage[] = [
      msg("user", [textBlock("before")]),
      compaction("Summary of prior turns."),
      msg("assistant", [textBlock("after")]),
    ];
    const entries = buildMainTabEntries([], messages, -1);
    const kinds = entries.map((e) => e.kind);
    expect(kinds).toEqual(["message", "compaction-boundary", "message"]);
    const boundary = entries[1] as { kind: "compaction-boundary"; summary: string };
    expect(boundary.summary).toBe("Summary of prior turns.");
  });

  it("flags messages before the latest compaction as preCompaction", () => {
    const messages: CapturedMessage[] = [
      msg("user", [textBlock("first")]),
      compaction("c1"),
      msg("assistant", [textBlock("middle")]),
      compaction("c2"),
      msg("user", [textBlock("after")]),
    ];
    const entries = buildMainTabEntries([], messages, -1);
    const before = entries.find((e) => e.kind === "message" && (e.message.content[0] as { text?: string }).text === "first");
    const middle = entries.find((e) => e.kind === "message" && (e.message.content[0] as { text?: string }).text === "middle");
    const after = entries.find((e) => e.kind === "message" && (e.message.content[0] as { text?: string }).text === "after");
    expect(before).toMatchObject({ kind: "message", preCompaction: true });
    expect(middle).toMatchObject({ kind: "message", preCompaction: true });
    expect(after).toMatchObject({ kind: "message", preCompaction: false });
  });

  it("does not filter Agent blocks from non-compaction system messages", () => {
    const messages: CapturedMessage[] = [
      msg("system", [textBlock("system note")]),
    ];
    const entries = buildMainTabEntries([], messages, -1);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("message");
  });
});

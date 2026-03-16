import type { SessionState } from "../types/session";

/**
 * JSONL event processor — derives session state and metadata from
 * Claude Code's structured JSONL conversation files.
 *
 * Replaces the heuristic PTY regex scanner (stateDetector.ts).
 */

export interface JsonlAccumulator {
  state: SessionState;
  costUsd: number;
  currentAction: string | null;
  currentToolName: string | null;
  subagentCount: number;
  subagentActivity: string[];
  lastAssistantText: string;
  inputTokens: number;
  outputTokens: number;
  assistantMessageCount: number;
  contextWarning: string | null;
  taskProgress: string | null;
}

export function createAccumulator(): JsonlAccumulator {
  return {
    state: "starting",
    costUsd: 0,
    currentAction: null,
    currentToolName: null,
    subagentCount: 0,
    subagentActivity: [],
    lastAssistantText: "",
    inputTokens: 0,
    outputTokens: 0,
    assistantMessageCount: 0,
    contextWarning: null,
    taskProgress: null,
  };
}

/** Process a single JSONL line and return an updated accumulator. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function processJsonlEvent(acc: JsonlAccumulator, event: any): JsonlAccumulator {
  const type = event.type;

  if (type === "assistant") {
    return processAssistant(acc, event);
  }

  if (type === "user") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hasToolResult = event.message?.content?.some?.((b: any) => b.type === "tool_result");
    if (hasToolResult) {
      return { ...acc, state: "thinking", currentAction: null, currentToolName: null };
    }
    // A user message with text (not a tool result) means the user typed a new
    // prompt. Claude must have been idle to accept it. If state was stuck in
    // thinking/toolUse (e.g. after an interrupt), this corrects it.
    return { ...acc, state: "idle", currentAction: null, currentToolName: null };
  }

  if (type === "progress") {
    // Only update to toolUse if we're actually in a tool-use state.
    // Progress events can arrive late — don't override idle/thinking.
    if (acc.state !== "toolUse" && acc.state !== "starting") return acc;
    const toolName = acc.currentToolName || "Bash";
    return {
      ...acc,
      currentAction: `${toolName}: running (${event.data?.elapsedTimeSeconds || 0}s)`,
    };
  }

  if (type === "result") {
    return {
      ...acc,
      state: "idle",
      costUsd: event.total_cost_usd ?? acc.costUsd,
      currentAction: null,
      currentToolName: null,
    };
  }

  // system (compact_boundary) → context warning
  if (type === "system" && event.subtype === "compact_boundary") {
    return { ...acc, contextWarning: "auto-compacting" };
  }

  return acc;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function processAssistant(acc: JsonlAccumulator, event: any): JsonlAccumulator {
  const msg = event.message;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content: any[] = msg?.content || [];
  const stopReason: string | undefined = msg?.stop_reason;
  const usage = msg?.usage;

  // Accumulate tokens — only non-cached tokens.
  // cache_read and cache_creation tokens represent the same context re-sent
  // across turns, so including them inflates the count to millions.
  const inputTokens = acc.inputTokens + (usage?.input_tokens || 0);
  const outputTokens = acc.outputTokens + (usage?.output_tokens || 0);

  // Calculate cost from tokens
  const model: string = msg?.model || "";
  const [inRate, outRate] = modelPricing(model);
  const costUsd = (inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate;

  // Extract last text block for speech bubble
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const textBlocks = content.filter((b: any) => b.type === "text");
  let lastText = acc.lastAssistantText;
  if (textBlocks.length > 0) {
    const raw: string = textBlocks[textBlocks.length - 1].text || "";
    const trimmed = raw.trim().slice(0, 500);
    if (trimmed) lastText = trimmed;
  }

  // Extract tool use blocks
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolUseBlocks = content.filter((b: any) => b.type === "tool_use");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agentBlocks = toolUseBlocks.filter((b: any) => b.name === "Agent");

  // Derive state from stop_reason
  let state: SessionState;
  let currentAction: string | null = null;
  let currentToolName: string | null = null;

  if (stopReason === "tool_use" && toolUseBlocks.length > 0) {
    const lastTool = toolUseBlocks[toolUseBlocks.length - 1];
    currentToolName = lastTool.name;
    currentAction = formatToolAction(lastTool);
    state = "toolUse";
  } else if (stopReason === "end_turn") {
    state = "idle";
  } else {
    state = "thinking"; // Still generating
  }

  // Subagent tracking
  const subagentActivity = agentBlocks.map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (b: any) => `${b.input?.subagent_type || "Agent"}: ${(b.input?.description || "working").replace(/\n/g, " ")}`.slice(0, 200)
  );

  return {
    ...acc,
    state,
    costUsd,
    currentAction,
    currentToolName,
    subagentCount: agentBlocks.length > 0 ? agentBlocks.length : acc.subagentCount,
    subagentActivity: subagentActivity.length > 0 ? subagentActivity : acc.subagentActivity,
    lastAssistantText: lastText,
    inputTokens,
    outputTokens,
    assistantMessageCount: acc.assistantMessageCount + 1,
    contextWarning: acc.contextWarning,
    taskProgress: acc.taskProgress,
  };
}

export function modelPricing(model: string): [number, number] {
  if (model.includes("haiku")) return [0.80, 4.00];
  if (model.includes("sonnet")) return [3.00, 15.00];
  return [15.00, 75.00]; // opus default
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatToolAction(block: any): string {
  const name: string = block.name;
  const input = block.input || {};
  if (name === "Bash") return `Bash: ${(input.command || "").slice(0, 200)}`;
  if (name === "Read") return `Read ${input.file_path || ""}`.slice(0, 200);
  if (name === "Write") return `Write ${input.file_path || ""}`.slice(0, 200);
  if (name === "Edit") return `Edit ${input.file_path || ""}`.slice(0, 200);
  if (name === "Grep") return `Grep "${input.pattern || ""}"`.slice(0, 200);
  if (name === "Glob") return `Glob ${input.pattern || ""}`.slice(0, 200);
  if (name === "Agent") return `Agent: ${(input.description || "").replace(/\n/g, " ")}`.slice(0, 200);
  return name;
}

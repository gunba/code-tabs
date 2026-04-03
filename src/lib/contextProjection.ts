import type { SystemPromptBlock, CapturedMessage, CapturedContentBlock } from "../types/session";

// ── Types ───────────────────────────────────────────────

export type UnifiedEntry =
  | { kind: "system"; index: number; block: SystemPromptBlock; isCacheBoundary: boolean }
  | { kind: "cache-boundary" }
  | { kind: "message"; index: number; message: CapturedMessage };

export interface SubagentTab {
  id: string;               // tool_use id or positional fallback "agent-N"
  label: string;            // from input.description, truncated
  promptText: string;       // from input.prompt
  resultText: string | null; // from paired tool_result, null if pending
}

// ── Helpers ─────────────────────────────────────────────

/**
 * Collect all ids associated with Agent tool calls.
 *
 * Uses tool_use.id when present. For old data where tool_use.id was not
 * captured, falls back to positional matching: the Nth tool_use in an
 * assistant message corresponds to the Nth tool_result in the following
 * user message, so we can recover the toolUseId from the result side.
 */
export function collectAgentToolIds(messages: CapturedMessage[]): Set<string> {
  const ids = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;

    // Find all tool_use blocks and track which positions are Agent calls
    const toolUseBlocks = msg.content.filter(b => b.type === "tool_use");
    const agentPositions = new Set<number>();

    toolUseBlocks.forEach((b, idx) => {
      if (b.name === "Agent") {
        if (b.id) ids.add(b.id);
        agentPositions.add(idx);
      }
    });

    if (agentPositions.size === 0) continue;

    // Positional fallback: match tool_results from the next user message
    const nextMsg = messages[i + 1];
    if (!nextMsg || nextMsg.role !== "user") continue;

    const toolResults = nextMsg.content.filter(b => b.type === "tool_result");
    toolResults.forEach((b, idx) => {
      if (agentPositions.has(idx) && b.toolUseId) {
        ids.add(b.toolUseId);
      }
    });
  }

  return ids;
}

/**
 * Filter Agent-related content blocks from a message.
 * Returns the filtered content array, or null if all blocks were removed.
 */
export function filterAgentBlocks(
  message: CapturedMessage,
  agentToolIds: Set<string>,
): CapturedContentBlock[] | null {
  const filtered = message.content.filter((b) => {
    if (b.type === "tool_use" && b.name === "Agent") return false;
    if (b.type === "tool_result" && b.toolUseId && agentToolIds.has(b.toolUseId)) return false;
    return true;
  });
  return filtered.length > 0 ? filtered : null;
}

// ── Main tab entries ────────────────────────────────────

/**
 * Build the unified entry list for the Main Agent tab.
 * System blocks come first, then messages with Agent tool_use/tool_result filtered out.
 */
export function buildMainTabEntries(
  blocks: SystemPromptBlock[],
  messages: CapturedMessage[] | null | undefined,
  lastCachedIdx: number,
): UnifiedEntry[] {
  const entries: UnifiedEntry[] = [];

  // System prompt blocks
  for (let i = 0; i < blocks.length; i++) {
    entries.push({
      kind: "system",
      index: i,
      block: blocks[i],
      isCacheBoundary: !!blocks[i].cacheControl,
    });
    if (i === lastCachedIdx && i < blocks.length - 1) {
      entries.push({ kind: "cache-boundary" });
    }
  }

  if (!messages) return entries;

  // Collect Agent tool ids for filtering (handles both old and new data)
  const agentIds = collectAgentToolIds(messages);

  // Messages with Agent blocks stripped
  let msgIndex = 0;
  for (const msg of messages) {
    const filtered = filterAgentBlocks(msg, agentIds);
    if (filtered) {
      entries.push({
        kind: "message",
        index: msgIndex,
        message: filtered === msg.content ? msg : { role: msg.role, content: filtered },
      });
    }
    msgIndex++;
  }

  return entries;
}

// ── Subagent tabs ───────────────────────────────────────

/**
 * Extract per-subagent tabs from the message list.
 * Each Agent tool_use block creates one tab, paired with its tool_result.
 *
 * Uses positional matching when tool_use.id is missing (old captured data).
 */
export function buildSubagentTabs(
  messages: CapturedMessage[] | null | undefined,
): SubagentTab[] {
  if (!messages) return [];

  const tabs: SubagentTab[] = [];
  let positionalIdx = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;

    // Collect Agent tool_use blocks and their positions among all tool_uses
    const toolUseBlocks = msg.content.filter(b => b.type === "tool_use");
    const agentEntries: Array<{ position: number; input: Record<string, unknown> | undefined; id?: string }> = [];

    toolUseBlocks.forEach((b, idx) => {
      if (b.name === "Agent") {
        agentEntries.push({
          position: idx,
          input: b.input as Record<string, unknown> | undefined,
          id: b.id,
        });
      }
    });

    if (agentEntries.length === 0) continue;

    // Find tool_results from the next user message for pairing
    const nextMsg = messages[i + 1];
    const toolResults = (nextMsg?.role === "user")
      ? nextMsg.content.filter(b => b.type === "tool_result")
      : [];

    for (const entry of agentEntries) {
      const desc = (entry.input?.description as string) || "Agent";
      const prompt = (entry.input?.prompt as string) || "";

      // Pair with result: use id if available, otherwise positional match
      let resultText: string | null = null;
      if (entry.id) {
        const matchedResult = toolResults.find(b => b.toolUseId === entry.id);
        if (matchedResult) resultText = matchedResult.text ?? "";
      } else {
        // Positional fallback: Nth tool_use → Nth tool_result
        const positionalResult = toolResults[entry.position];
        if (positionalResult) resultText = positionalResult.text ?? "";
      }

      const tabId = entry.id || `agent-${positionalIdx}`;
      tabs.push({
        id: tabId,
        label: desc.length > 30 ? desc.slice(0, 30) + "\u2026" : desc,
        promptText: prompt,
        resultText,
      });
      positionalIdx++;
    }
  }

  return tabs;
}

import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../store/sessions";
import {
  processJsonlEvent,
  createAccumulator,
  type JsonlAccumulator,
} from "../lib/jsonlState";
import type { SessionState, SubagentMessage } from "../types/session";

/** Max messages to keep per subagent to bound memory. */
const MAX_MESSAGES = 200;

/**
 * Extract conversation messages from a parsed JSONL event.
 * Returns an array of SubagentMessages (may be empty).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractMessages(parsed: any): SubagentMessage[] {
  const msgs: SubagentMessage[] = [];
  const now = Date.now();

  if (parsed.type === "assistant" && parsed.message?.content) {
    // Extract text blocks
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const block of parsed.message.content) {
      if (block.type === "text" && block.text) {
        msgs.push({ role: "assistant", text: block.text, timestamp: now });
      }
      if (block.type === "tool_use") {
        const inputStr = typeof block.input === "object"
          ? JSON.stringify(block.input).slice(0, 300)
          : String(block.input).slice(0, 300);
        msgs.push({
          role: "tool",
          text: inputStr,
          toolName: block.name,
          timestamp: now,
        });
      }
    }
  }

  if (parsed.type === "user" && parsed.message?.content) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const block of parsed.message.content) {
      if (block.type === "tool_result") {
        const resultText = typeof block.content === "string"
          ? block.content.slice(0, 500)
          : Array.isArray(block.content)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ? block.content.map((b: any) => b.text || "").join("\n").slice(0, 500)
            : "";
        if (resultText) {
          msgs.push({
            role: "tool",
            text: resultText,
            toolName: "result",
            timestamp: now,
          });
        }
      }
    }
  }

  return msgs;
}

/** Timeout for subagents stuck in "starting" state (ms). */
const STALE_TIMEOUT = 30_000;

/**
 * Hook that watches for subagent JSONL events and maintains subagent state.
 * Accumulates conversation messages for inspection.
 */
export function useSubagentWatcher(sessionId: string | null, workingDir: string, jsonlSessionId: string | null = null) {
  const addSubagent = useSessionStore((s) => s.addSubagent);
  const updateSubagent = useSessionStore((s) => s.updateSubagent);
  const accumulators = useRef<Map<string, JsonlAccumulator>>(new Map());
  const messageBuffers = useRef<Map<string, SubagentMessage[]>>(new Map());
  const lastEventTime = useRef<Map<string, number>>(new Map());
  const startTimes = useRef<Map<string, number>>(new Map());
  // Track whether initial replay is done — suppress UI creation during replay
  // to avoid showing historical subagents from resumed sessions.
  const initialReplayDone = useRef(!jsonlSessionId); // New sessions: no replay

  // Start subagent watcher once on mount.
  useEffect(() => {
    if (!sessionId) return;

    // Mark initial replay as done after a short delay — the Rust watcher
    // scans existing files immediately on start. Any subagent events
    // arriving within the first 2s are from historical files.
    if (jsonlSessionId) {
      const timer = setTimeout(() => { initialReplayDone.current = true; }, 2000);
      invoke("start_subagent_watcher", { sessionId, workingDir, jsonlSessionId });
      return () => { clearTimeout(timer); invoke("stop_subagent_watcher", { sessionId }); };
    }

    invoke("start_subagent_watcher", { sessionId, workingDir, jsonlSessionId: null });
    return () => { invoke("stop_subagent_watcher", { sessionId }); };
  }, [sessionId, workingDir, jsonlSessionId]);

  // Listen for subagent JSONL events
  useEffect(() => {
    if (!sessionId) return;

    const unlisten = listen<{ sessionId: string; subagentId: string; line: string }>(
      "jsonl-subagent-event",
      (event) => {
        if (event.payload.sessionId !== sessionId) return;

        const { subagentId, line } = event.payload;
        console.log("[subagentWatcher] Event for", subagentId, "session:", sessionId);

        try {
          const parsed = JSON.parse(line);

          // Get or create accumulator for this subagent
          let acc = accumulators.current.get(subagentId);
          if (!acc) {
            acc = createAccumulator();
            accumulators.current.set(subagentId, acc);
            messageBuffers.current.set(subagentId, []);

            // Skip UI creation during initial replay of historical subagents
            if (!initialReplayDone.current) {
              accumulators.current.set(subagentId, processJsonlEvent(acc, parsed));
              return;
            }

            // Clear old completed subagents when a new batch starts
            const existing = useSessionStore.getState().subagents.get(sessionId) || [];
            const allIdle = existing.every((s) => s.state === "idle" || s.state === "dead");
            if (allIdle && existing.length > 0) {
              // New batch — clear old subagents by marking them dead
              for (const old of existing) {
                updateSubagent(sessionId, old.id, { state: "dead" });
              }
            }

            // Extract name from the first user message (the prompt/description)
            let name = "Starting...";
            if (parsed.type === "user") {
              const content = parsed.message?.content;
              if (typeof content === "string") {
                name = content.replace(/\n/g, " ").trim().slice(0, 200);
              } else if (Array.isArray(content)) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const text = content.find((b: any) => b.type === "text")?.text;
                if (text) name = text.replace(/\n/g, " ").trim().slice(0, 200);
              }
            }

            startTimes.current.set(subagentId, Date.now());
            addSubagent(sessionId, {
              id: subagentId,
              parentSessionId: sessionId,
              state: "starting",
              description: name,
              tokenCount: 0,
              currentAction: null,
              messages: [],
            });
          }

          // Process the JSONL event for state/metadata
          acc = processJsonlEvent(acc, parsed);
          accumulators.current.set(subagentId, acc);
          lastEventTime.current.set(subagentId, Date.now());

          // Extract and accumulate conversation messages
          const newMsgs = extractMessages(parsed);
          if (newMsgs.length > 0) {
            const buffer = messageBuffers.current.get(subagentId) || [];
            buffer.push(...newMsgs);
            if (buffer.length > MAX_MESSAGES) {
              buffer.splice(0, buffer.length - MAX_MESSAGES);
            }
            messageBuffers.current.set(subagentId, buffer);
          }

          // Compute elapsed time locally since progress events may lack elapsedTimeSeconds
          const startTime = startTimes.current.get(subagentId);
          const elapsed = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
          // Override currentAction with locally computed time for active states
          let currentAction = acc.currentAction;
          if (acc.state === "toolUse" || acc.state === "thinking") {
            const toolName = acc.currentToolName || (acc.state === "thinking" ? "Thinking" : "Working");
            currentAction = `${toolName} (${elapsed}s)`;
          }

          // Update state (don't overwrite the name from the first user message
          // with random assistant text)
          updateSubagent(sessionId, subagentId, {
            state: acc.state as SessionState,
            tokenCount: acc.inputTokens + acc.outputTokens,
            currentAction,
            messages: messageBuffers.current.get(subagentId) || [],
          });
        } catch {
          // Invalid JSON — skip
        }
      }
    );

    return () => {
      unlisten.then((fn) => fn());
      accumulators.current.clear();
      messageBuffers.current.clear();
      lastEventTime.current.clear();
    };
  }, [sessionId, addSubagent, updateSubagent]);

  // Staleness check: mark subagents as dead if no events for STALE_TIMEOUT
  useEffect(() => {
    if (!sessionId) return;
    const interval = setInterval(() => {
      const now = Date.now();
      for (const [subagentId, lastTime] of lastEventTime.current.entries()) {
        const acc = accumulators.current.get(subagentId);
        if (!acc) continue;
        // Only auto-kill subagents stuck in starting/thinking/toolUse
        if (acc.state === "idle" || acc.state === "dead") continue;
        if (now - lastTime > STALE_TIMEOUT) {
          updateSubagent(sessionId, subagentId, { state: "dead" });
        }
      }
    }, 10_000);
    return () => clearInterval(interval);
  }, [sessionId, updateSubagent]);
}

import { useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useSessionStore } from "../store/sessions";
import {
  processJsonlEvent,
  createAccumulator,
  type JsonlAccumulator,
} from "../lib/jsonlState";

/** Patterns that indicate the CLI is waiting for user permission/input. */
const PERMISSION_PATTERNS = [
  /Allow\s+(once|always|for this session)/i,
  /\(y\)es.*\(n\)o/i,
  /Do you want to (allow|proceed|run)/i,
  /\[y\/n\]/i,
  /Press Enter to continue/i,
  /Do you want to proceed/i,
  /approve|deny|reject/i,
  /waiting for.*input/i,
];

/** Claude Code's idle prompt — the ❯ character rendered by ink when waiting for input. */
const IDLE_PROMPT = /❯\s*$/;

/**
 * Hook that derives session state + metadata from JSONL events
 * emitted by the Rust file watcher. Keeps a minimal PTY scan
 * only for permission detection (the one thing JSONL doesn't capture).
 */
interface UseClaudeStateOptions {
  /** Called when a result event indicates the conversation ended (plan mode, compaction). */
  onConversationEnd?: () => void;
}

export function useClaudeState(sessionId: string | null, isResumed = false, opts: UseClaudeStateOptions = {}) {
  const updateState = useSessionStore((s) => s.updateState);
  const updateMetadata = useSessionStore((s) => s.updateMetadata);
  const accRef = useRef<JsonlAccumulator>(createAccumulator());
  const lastStateRef = useRef<string>("starting");
  const lastFingerprintRef = useRef<string>("");
  const permissionRef = useRef("");
  // Suppress state/metadata updates until the JSONL watcher has caught up.
  // Only needed for resumed sessions (which have history to replay).
  // New sessions start caught-up — no replay to suppress.
  const caughtUpRef = useRef(!isResumed);
  const onConversationEndRef = useRef(opts.onConversationEnd);
  onConversationEndRef.current = opts.onConversationEnd;

  // Listen to JSONL events from Rust watcher
  useEffect(() => {
    if (!sessionId) return;

    const unlisten = listen<{ sessionId: string; line: string }>(
      "jsonl-event",
      (event) => {
        if (event.payload.sessionId !== sessionId) return;

        try {
          const parsed = JSON.parse(event.payload.line);
          accRef.current = processJsonlEvent(accRef.current, parsed);
          const acc = accRef.current;

          // Suppress state and metadata updates until the watcher has caught up.
          // During JSONL replay, events arrive in rapid bursts. The Rust watcher
          // emits "jsonl-caught-up" once it reaches the end of the file.
          if (!caughtUpRef.current) return;

          // Detect conversation end (result event) — signals plan mode or compaction
          if (parsed.type === "result" && onConversationEndRef.current) {
            onConversationEndRef.current();
          }

          if (acc.state !== lastStateRef.current) {
            updateState(sessionId, acc.state);
            lastStateRef.current = acc.state;
            // When JSONL gives a definitive state (idle, thinking), clear the
            // permission buffer so stale permission prompts don't re-trigger
            // waitingPermission after the user has already responded.
            if (acc.state === "idle" || acc.state === "thinking") {
              permissionRef.current = "";
            }
          }

          const metadata = {
            costUsd: acc.costUsd,
            currentAction: acc.currentAction,
            currentToolName: acc.currentToolName,
            subagentCount: acc.subagentCount,
            subagentActivity: acc.subagentActivity,
            recentOutput: acc.lastAssistantText,
            contextWarning: acc.contextWarning,
            taskProgress: acc.taskProgress,
            inputTokens: acc.inputTokens,
            outputTokens: acc.outputTokens,
            assistantMessageCount: acc.assistantMessageCount,
            // First user message as tab summary
            ...(acc.firstUserMessage ? { nodeSummary: acc.firstUserMessage } : {}),
          };
          const fp = JSON.stringify(metadata);
          if (fp !== lastFingerprintRef.current) {
            lastFingerprintRef.current = fp;
            updateMetadata(sessionId, metadata);
          }
        } catch {
          // Invalid JSON line — skip
        }
      }
    );

    // Listen for caught-up signal — watcher reached end of file.
    // Snapshot the current metadata fingerprint so the first post-replay
    // metadata update doesn't leak stale recentOutput to the activity feed.
    const unlistenCaughtUp = listen<{ sessionId: string }>(
      "jsonl-caught-up",
      (event) => {
        if (event.payload.sessionId !== sessionId) return;
        // Only handle the first caught-up signal (initial replay).
        // Subsequent caught-up signals are from new data batches and should
        // NOT reset tokens or fingerprints.
        if (caughtUpRef.current) return;
        // Set fingerprint to match the RESET metadata we're about to push,
        // so the next new event will correctly trigger an update.
        const acc = accRef.current;
        lastFingerprintRef.current = JSON.stringify({
          costUsd: 0,
          currentAction: acc.currentAction,
          currentToolName: acc.currentToolName,
          subagentCount: acc.subagentCount,
          subagentActivity: acc.subagentActivity,
          recentOutput: acc.lastAssistantText,
          contextWarning: acc.contextWarning,
          taskProgress: acc.taskProgress,
          inputTokens: 0,
          outputTokens: 0,
          assistantMessageCount: acc.assistantMessageCount,
        });
        // Sync state to store. For resumed sessions, if replay ends in an
        // active state (thinking/toolUse), the session was likely interrupted.
        // The PTY is now showing the idle prompt, so force idle.
        const replayState = (acc.state === "thinking" || acc.state === "toolUse") ? "idle" : acc.state;
        lastStateRef.current = replayState;
        updateState(sessionId, replayState);
        updateMetadata(sessionId, {
          costUsd: 0,
          currentAction: acc.currentAction,
          currentToolName: acc.currentToolName,
          subagentCount: acc.subagentCount,
          subagentActivity: acc.subagentActivity,
          recentOutput: acc.lastAssistantText,
          contextWarning: acc.contextWarning,
          taskProgress: acc.taskProgress,
          inputTokens: 0, // Reset — only count NEW tokens
          outputTokens: 0,
          assistantMessageCount: acc.assistantMessageCount,
          // Preserve first user message from replay for tab naming
          ...(acc.firstUserMessage ? { nodeSummary: acc.firstUserMessage } : {}),
        });
        // Reset token counts and cost so only the NEW conversation's usage is shown.
        // Historical tokens from the resumed session don't count against this run.
        accRef.current = { ...accRef.current, inputTokens: 0, outputTokens: 0, costUsd: 0 };
        caughtUpRef.current = true;
      }
    );

    return () => {
      unlisten.then((fn) => fn());
      unlistenCaughtUp.then((fn) => fn());
    };
  }, [sessionId, updateState, updateMetadata]);


  // PTY feed — detects idle prompt and permission patterns from terminal output.
  // This is how we read the actual state of the Claude Code instance: by parsing
  // what it renders to the terminal. JSONL covers most transitions, but interrupts
  // (Ctrl+C) and permission prompts are only visible in PTY output.
  const feed = useCallback(
    (data: string) => {
      if (!sessionId) return;
      // Strip ANSI escape sequences before buffering
      const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      permissionRef.current = (permissionRef.current + clean).slice(-800);

      const state = lastStateRef.current;

      // Idle prompt detection: Claude Code renders ❯ when waiting for input.
      // If we see this while in an active state, Claude has returned to idle
      // (e.g. after interrupt, completion without end_turn, or error recovery).
      if (state !== "idle" && state !== "dead" && state !== "starting") {
        if (IDLE_PROMPT.test(permissionRef.current)) {
          updateState(sessionId, "idle");
          lastStateRef.current = "idle";
          permissionRef.current = "";
          return;
        }
      }

      // Permission prompt detection: only when JSONL says we're in an active
      // state (toolUse/thinking). Don't override idle.
      if (state === "toolUse" || state === "thinking") {
        if (PERMISSION_PATTERNS.some((p) => p.test(permissionRef.current))) {
          updateState(sessionId, "waitingPermission");
          lastStateRef.current = "waitingPermission";
        }
      }
    },
    [sessionId, updateState]
  );

  return { feed, caughtUp: caughtUpRef };
}

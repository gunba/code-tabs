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

/**
 * Hook that derives session state + metadata from JSONL events
 * emitted by the Rust file watcher. Keeps a minimal PTY scan
 * only for permission detection (the one thing JSONL doesn't capture).
 */
export function useClaudeState(sessionId: string | null) {
  const updateState = useSessionStore((s) => s.updateState);
  const updateMetadata = useSessionStore((s) => s.updateMetadata);
  const accRef = useRef<JsonlAccumulator>(createAccumulator());
  const lastStateRef = useRef<string>("starting");
  const lastFingerprintRef = useRef<string>("");
  const lastJsonlEventRef = useRef<number>(Date.now());
  const permissionRef = useRef("");
  // Suppress state/metadata updates until the JSONL watcher has caught up
  // (finished reading all existing lines). This prevents replay floods on resume.
  const caughtUpRef = useRef(false);

  // Listen to JSONL events from Rust watcher
  useEffect(() => {
    if (!sessionId) return;

    const unlisten = listen<{ sessionId: string; line: string }>(
      "jsonl-event",
      (event) => {
        if (event.payload.sessionId !== sessionId) return;

        try {
          const parsed = JSON.parse(event.payload.line);
          lastJsonlEventRef.current = Date.now();

          accRef.current = processJsonlEvent(accRef.current, parsed);
          const acc = accRef.current;

          // Suppress state and metadata updates until the watcher has caught up.
          // During JSONL replay, events arrive in rapid bursts. The Rust watcher
          // emits "jsonl-caught-up" once it reaches the end of the file.
          if (!caughtUpRef.current) return;

          if (acc.state !== lastStateRef.current) {
            updateState(sessionId, acc.state);
            lastStateRef.current = acc.state;
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

    // Listen for caught-up signal — watcher reached end of file
    const unlistenCaughtUp = listen<{ sessionId: string }>(
      "jsonl-caught-up",
      (event) => {
        if (event.payload.sessionId !== sessionId) return;
        caughtUpRef.current = true;
      }
    );

    return () => {
      unlisten.then((fn) => fn());
      unlistenCaughtUp.then((fn) => fn());
    };
  }, [sessionId, updateState, updateMetadata]);

  // Timeout heuristic: if state is toolUse and no JSONL events for 10s, re-check PTY buffer
  useEffect(() => {
    if (!sessionId) return;
    const interval = setInterval(() => {
      const elapsed = Date.now() - lastJsonlEventRef.current;
      if (lastStateRef.current === 'toolUse' && elapsed > 10_000) {
        if (PERMISSION_PATTERNS.some((p) => p.test(permissionRef.current))) {
          if ((lastStateRef.current as string) !== 'waitingPermission') {
            updateState(sessionId, 'waitingPermission');
            lastStateRef.current = 'waitingPermission';
          }
        }
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [sessionId, updateState]);

  // Minimal PTY feed — ONLY for permission detection
  const feed = useCallback(
    (data: string) => {
      if (!sessionId) return;
      // Strip ANSI escape sequences before buffering
      const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      permissionRef.current = (permissionRef.current + clean).slice(-800);
      if (PERMISSION_PATTERNS.some((p) => p.test(permissionRef.current))) {
        if (lastStateRef.current !== "waitingPermission") {
          updateState(sessionId, "waitingPermission");
          lastStateRef.current = "waitingPermission";
        }
      }
    },
    [sessionId, updateState]
  );

  return { feed, caughtUp: caughtUpRef };
}

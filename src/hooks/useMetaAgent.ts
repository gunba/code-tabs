import { useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../store/sessions";
import { useSettingsStore } from "../store/settings";
import { sessionFingerprint } from "../lib/metaAgentUtils";
import { dirToTabName } from "../lib/claude";

const DEBOUNCE_MS = 15_000;
const MIN_SESSIONS = 1;
const RESUMMARISE_INTERVAL = 15;

/**
 * Manages an on-demand Haiku summariser that analyzes active sessions
 * and updates their names and `nodeSummary` metadata for the graph canvas.
 *
 * Title (session name):
 * - Set ONCE when the session first gets assistantMessageCount === 1
 * - Uses Haiku to generate a 2-4 word title from the first response
 * - Once set, NEVER changes
 *
 * Summary (nodeSummary):
 * - First summary generated alongside the title (at assistantMessageCount === 1)
 * - Updated every RESUMMARISE_INTERVAL messages to reflect conversation drift
 *
 * Uses one-shot Claude CLI pipe mode per invocation.
 */
export function useMetaAgent(): { isRunning: boolean } {
  const updateMetadata = useSessionStore((s) => s.updateMetadata);

  const isRunningRef = useRef(false);
  const lastFingerprintRef = useRef("");
  const lastTriggerRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef(false);

  const processResponse = useCallback((response: string) => {
    const renameSession = useSessionStore.getState().renameSession;
    // Try to extract JSON from the response (Haiku may wrap in markdown code fences)
    let jsonStr = response.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    try {
      const parsed = JSON.parse(jsonStr);
      const summaries: Record<string, string> | undefined = parsed.summaries;
      const names: Record<string, string> | undefined = parsed.names;

      if (summaries && typeof summaries === "object") {
        for (const [sessionId, summary] of Object.entries(summaries)) {
          if (typeof summary === "string" && summary.length > 0) {
            updateMetadata(sessionId, { nodeSummary: summary });
          }
        }
      }

      // Apply names only for sessions still using default directory names
      if (names && typeof names === "object") {
        for (const [sessionId, name] of Object.entries(names)) {
          if (typeof name === "string" && name.length > 0 && name.length <= 30) {
            const session = useSessionStore
              .getState()
              .sessions.find((s) => s.id === sessionId);
            if (session) {
              const defaultName = dirToTabName(session.config.workingDir);
              if (session.name === defaultName) {
                renameSession(sessionId, name);
              }
            }
          }
        }
      }
    } catch {
      // Not valid JSON — log for debugging
      console.warn("[useMetaAgent] Failed to parse Haiku response:", response.slice(0, 200));
    }
  }, [updateMetadata]);

  const sendPrompt = useCallback(async () => {
    const sessions = useSessionStore.getState().sessions;
    const claudePath = useSessionStore.getState().claudePath;
    const targetSessions = sessions.filter((s) => !s.isMetaAgent && s.state !== "dead");

    if (targetSessions.length === 0 || !claudePath) return;

    // Check fingerprint — don't re-run if nothing changed
    const fp = sessionFingerprint(targetSessions);
    if (fp === lastFingerprintRef.current) return;
    lastFingerprintRef.current = fp;

    // Identify sessions needing a name (first response received, still using default name)
    const needsNaming = targetSessions.filter(
      (s) => s.metadata.assistantMessageCount >= 1 && s.name === dirToTabName(s.config.workingDir)
    );

    // Identify sessions needing a summary (first response received, no summary or drifted)
    const lastSummarisedAtMap = lastSummarisedAtRef.current;
    const needsSummary = targetSessions.filter((s) => {
      if (s.metadata.assistantMessageCount < 1) return false;
      const lastAt = lastSummarisedAtMap[s.id] ?? 0;
      // Needs first summary or has drifted enough
      return !s.metadata.nodeSummary || (s.metadata.assistantMessageCount - lastAt >= RESUMMARISE_INTERVAL);
    });

    // Nothing to do
    if (needsNaming.length === 0 && needsSummary.length === 0) return;

    // Build compact prompt
    const allNeeded = new Set([...needsNaming.map((s) => s.id), ...needsSummary.map((s) => s.id)]);
    const sessionsJson = targetSessions
      .filter((s) => allNeeded.has(s.id))
      .map((s) => ({
        id: s.id,
        name: s.name,
        state: s.state,
        action: s.metadata.currentAction || "none",
        output: (s.metadata.recentOutput || "").slice(0, 150).replace(/\n/g, " "),
        summary: s.metadata.nodeSummary || "none",
      }));

    const needsNamingIds = needsNaming.map((s) => s.id);
    const needsSummaryIds = needsSummary.map((s) => s.id);

    const namingPart = needsNamingIds.length > 0
      ? ` Give a 2-4 word title for sessions: ${needsNamingIds.join(",")}.`
      : "";
    const summaryPart = needsSummaryIds.length > 0
      ? ` Summarize these sessions briefly: ${needsSummaryIds.join(",")}.`
      : "";

    const prompt = `Sessions: ${JSON.stringify(sessionsJson)}.${namingPart}${summaryPart} Return JSON: {"names":{...},"summaries":{...}}`;
    const systemPrompt = "You summarize Claude Code sessions. Return only valid JSON, no markdown, no explanation.";

    try {
      isRunningRef.current = true;
      const cwd = useSettingsStore.getState().lastConfig.workingDir || ".";

      const response = await invoke<string>("invoke_claude_pipe", {
        claudePath,
        prompt,
        systemPrompt,
        model: "haiku",
        workingDir: cwd,
      });
      processResponse(response);

      // Record the message counts so we don't re-trigger immediately
      for (const s of needsSummary) {
        lastSummarisedAtMap[s.id] = s.metadata.assistantMessageCount;
      }
    } catch (err) {
      console.error("[useMetaAgent] Haiku failed:", err);
    } finally {
      isRunningRef.current = false;
    }
  }, [processResponse]);

  // Track the assistantMessageCount at which we last summarised each session
  const lastSummarisedAtRef = useRef<Record<string, number>>({});

  // Debounced trigger function
  const triggerSummary = useCallback(() => {
    const now = Date.now();
    const elapsed = now - lastTriggerRef.current;

    if (elapsed >= DEBOUNCE_MS) {
      lastTriggerRef.current = now;
      sendPrompt();
    } else {
      // Schedule for later if not already pending
      if (!pendingRef.current) {
        pendingRef.current = true;
        debounceTimerRef.current = setTimeout(() => {
          pendingRef.current = false;
          lastTriggerRef.current = Date.now();
          sendPrompt();
        }, DEBOUNCE_MS - elapsed);
      }
    }
  }, [sendPrompt]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, []);

  // Subscribe to session state changes and trigger contextually
  useEffect(() => {
    let prevFingerprint = "";
    // Track which sessions have already been named (reached assistantMessageCount >= 1)
    const namedSessions = new Set<string>();
    const lastSummarisedAt = lastSummarisedAtRef.current;

    const unsub = useSessionStore.subscribe((state) => {
      const sessions = state.sessions.filter((s) => !s.isMetaAgent);

      // Don't trigger if no sessions or all starting
      if (
        sessions.length < MIN_SESSIONS ||
        sessions.every((s) => s.state === "starting")
      ) {
        return;
      }

      const fp = sessionFingerprint(sessions);
      if (fp === prevFingerprint) return;

      // Parse previous fingerprint into a lookup of id -> state
      const prevSessions = prevFingerprint.split("|").reduce(
        (acc, pair) => {
          const [id, st] = pair.split(":");
          if (id) acc[id] = st;
          return acc;
        },
        {} as Record<string, string>
      );

      prevFingerprint = fp;

      // Naming trigger: session has messages but still using default directory name
      const hasNewFirstResponse = sessions.some((s) => {
        if (s.metadata.assistantMessageCount >= 1 && !namedSessions.has(s.id)) {
          namedSessions.add(s.id);
          if (s.name === dirToTabName(s.config.workingDir)) return true;
        }
        return false;
      });

      // Also trigger for sessions that have messages but no summary
      // (e.g., revived from Claude history, not originally created in the app)
      const needsInitialSummary = sessions.some((s) => {
        return s.metadata.assistantMessageCount >= 1
          && !s.metadata.nodeSummary
          && s.state !== "dead"
          && s.state !== "starting"
          && !(lastSummarisedAt[s.id]);
      });

      // Check if any session's message count exceeds lastSummarisedAt by RESUMMARISE_INTERVAL
      const hasDriftedSession = sessions.some((s) => {
        const count = s.metadata.assistantMessageCount;
        const lastAt = lastSummarisedAt[s.id] ?? 0;
        return count >= 1 && count - lastAt >= RESUMMARISE_INTERVAL;
      });

      // Check if any session just went from active -> idle AND needs a summary update
      const hasIdleTransitionNeedingSummary = sessions.some((s) => {
        const prev = prevSessions[s.id];
        if (
          prev &&
          (prev === "thinking" || prev === "toolUse") &&
          s.state === "idle" &&
          s.metadata.assistantMessageCount >= 1
        ) {
          const lastAt = lastSummarisedAt[s.id] ?? 0;
          // Needs first summary or has drifted
          return !s.metadata.nodeSummary || (s.metadata.assistantMessageCount - lastAt >= RESUMMARISE_INTERVAL);
        }
        return false;
      });

      if (hasNewFirstResponse || needsInitialSummary || hasDriftedSession || hasIdleTransitionNeedingSummary) {
        triggerSummary();
      }
    });

    return unsub;
  }, [triggerSummary]);

  return { isRunning: isRunningRef.current };
}

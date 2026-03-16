import { useEffect, useRef, useCallback } from "react";
import { useSessionStore } from "../store/sessions";
import { useSettingsStore } from "../store/settings";
import { sessionFingerprint } from "../lib/metaAgentUtils";
import { dirToTabName } from "../lib/claude";
import { writeToPty, registerPtyWriter, unregisterPtyWriter } from "../lib/ptyRegistry";
import { spawn as ptySpawn } from "tauri-pty";

const DEBOUNCE_MS = 15_000;
const MIN_SESSIONS = 1;
const RESUMMARISE_INTERVAL = 15;
// Max time to wait for a Haiku response before giving up (ms)
const RESPONSE_TIMEOUT = 30_000;

/**
 * Persistent Haiku summariser — spawns ONE long-lived Claude session
 * with --model haiku and reuses it for all summarisation requests.
 * Between requests, sends /clear to reset context. No process restarts.
 */
export function useMetaAgent(): { isRunning: boolean } {
  const updateMetadata = useSessionStore((s) => s.updateMetadata);

  const isRunningRef = useRef(false);
  const lastFingerprintRef = useRef("");
  const lastTriggerRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef(false);
  const lastSummarisedAtRef = useRef<Record<string, number>>({});

  // Persistent Haiku session state
  const metaSessionIdRef = useRef<string | null>(null);
  const metaReadyRef = useRef(false);
  const responseBufferRef = useRef("");
  const responseResolveRef = useRef<((text: string) => void) | null>(null);
  const spawnAttemptedRef = useRef(false);

  // Spawn the persistent Haiku session (once)
  const ensureMetaSession = useCallback(async (): Promise<boolean> => {
    if (metaReadyRef.current && metaSessionIdRef.current) return true;
    if (spawnAttemptedRef.current) return false;
    spawnAttemptedRef.current = true;

    const claudePath = useSessionStore.getState().claudePath;
    if (!claudePath) { spawnAttemptedRef.current = false; return false; }

    const cwd = useSettingsStore.getState().lastConfig.workingDir || ".";

    try {
      const session = await useSessionStore.getState().createSession("_haiku", {
        workingDir: cwd,
        model: "haiku",
        permissionMode: "default",
        dangerouslySkipPermissions: true,
        systemPrompt: null,
        appendSystemPrompt: "You summarize Claude Code sessions. Return only valid JSON, no markdown, no explanation.",
        allowedTools: [],
        disallowedTools: [],
        additionalDirs: [],
        mcpConfig: null,
        agent: null,
        effort: null,
        verbose: false,
        debug: false,
        maxBudget: null,
        resumeSession: null,
        forkSession: false,
        continueSession: false,
        projectDir: false,
        extraFlags: null,
        sessionId: null,
      }, { isMetaAgent: true });

      metaSessionIdRef.current = session.id;

      // Spawn PTY for the meta-agent
      const args = ["--model", "haiku", "--dangerously-skip-permissions",
        "--append-system-prompt", "You summarize Claude Code sessions. Return only valid JSON, no markdown, no explanation."];

      const pty = ptySpawn(claudePath, args, { cwd, cols: 200, rows: 50 });

      // Register PTY writer
      registerPtyWriter(session.id, (data: string) => pty.write(data));

      // Collect output for response detection
      const decoder = new TextDecoder();
      pty.onData((data: Uint8Array) => {
        const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data as unknown as number[]);
        const text = decoder.decode(bytes, { stream: true });
        // Strip ANSI sequences
        const clean = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
        responseBufferRef.current += clean;

        // Check if response is complete (idle prompt appeared)
        if (responseResolveRef.current && /❯\s*$/.test(responseBufferRef.current)) {
          const response = responseBufferRef.current;
          responseBufferRef.current = "";
          const resolve = responseResolveRef.current;
          responseResolveRef.current = null;
          resolve(response);
        }
      });

      pty.onExit(() => {
        metaReadyRef.current = false;
        metaSessionIdRef.current = null;
        spawnAttemptedRef.current = false;
        unregisterPtyWriter(session.id);
        useSessionStore.getState().updateState(session.id, "dead");
      });

      // Wait for initial idle prompt
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (/❯\s*$/.test(responseBufferRef.current)) {
            clearInterval(check);
            responseBufferRef.current = "";
            resolve();
          }
        }, 200);
        // Timeout after 15s
        setTimeout(() => { clearInterval(check); resolve(); }, 15_000);
      });

      metaReadyRef.current = true;
      useSessionStore.getState().updateState(session.id, "idle");
      return true;
    } catch (err) {
      console.error("[useMetaAgent] Failed to spawn Haiku session:", err);
      spawnAttemptedRef.current = false;
      return false;
    }
  }, []);

  // Send a prompt to the persistent session and wait for response
  const queryHaiku = useCallback(async (prompt: string): Promise<string | null> => {
    const sid = metaSessionIdRef.current;
    if (!sid || !metaReadyRef.current) return null;

    // Clear context — \r triggers Enter in the PTY (ink's input submit).
    // Wait for the idle prompt (❯) to confirm clear is complete before sending.
    writeToPty(sid, "/clear\r");
    responseBufferRef.current = "";
    await new Promise<void>((resolve) => {
      responseResolveRef.current = () => resolve();
      setTimeout(() => {
        if (responseResolveRef.current) {
          responseResolveRef.current = null;
          resolve(); // Timeout fallback
        }
      }, RESPONSE_TIMEOUT);
    });
    responseBufferRef.current = "";

    // Send prompt
    writeToPty(sid, prompt + "\r");

    // Wait for response (idle prompt signals completion)
    return new Promise<string | null>((resolve) => {
      responseResolveRef.current = (text) => resolve(text);
      setTimeout(() => {
        if (responseResolveRef.current) {
          responseResolveRef.current = null;
          resolve(null); // Timeout
        }
      }, RESPONSE_TIMEOUT);
    });
  }, []);

  const processResponse = useCallback((response: string) => {
    const renameSession = useSessionStore.getState().renameSession;
    // Try to extract JSON from the response (Haiku may wrap in markdown code fences)
    let jsonStr = response.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    // Try to find JSON object in the response
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];

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
      console.warn("[useMetaAgent] Failed to parse Haiku response:", response.slice(0, 200));
    }
  }, [updateMetadata]);

  const sendPrompt = useCallback(async () => {
    const sessions = useSessionStore.getState().sessions;
    const targetSessions = sessions.filter((s) => !s.isMetaAgent && s.state !== "dead");

    if (targetSessions.length === 0) return;

    // Check fingerprint
    const fp = sessionFingerprint(targetSessions);
    if (fp === lastFingerprintRef.current) return;
    lastFingerprintRef.current = fp;

    const lastSummarisedAtMap = lastSummarisedAtRef.current;

    const needsNaming = targetSessions.filter(
      (s) => s.metadata.assistantMessageCount >= 1 && s.name === dirToTabName(s.config.workingDir)
    );
    const needsSummary = targetSessions.filter((s) => {
      if (s.metadata.assistantMessageCount < 1) return false;
      const lastAt = lastSummarisedAtMap[s.id] ?? 0;
      return !s.metadata.nodeSummary || (s.metadata.assistantMessageCount - lastAt >= RESUMMARISE_INTERVAL);
    });

    if (needsNaming.length === 0 && needsSummary.length === 0) return;

    // Ensure persistent session exists
    const ready = await ensureMetaSession();
    if (!ready) return;

    // Build prompt
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

    try {
      isRunningRef.current = true;
      const response = await queryHaiku(prompt);
      if (response) {
        processResponse(response);
        for (const s of needsSummary) {
          lastSummarisedAtMap[s.id] = s.metadata.assistantMessageCount;
        }
      }
    } catch (err) {
      console.error("[useMetaAgent] Haiku failed:", err);
    } finally {
      isRunningRef.current = false;
    }
  }, [processResponse, ensureMetaSession, queryHaiku]);

  // Debounced trigger
  const triggerSummary = useCallback(() => {
    const now = Date.now();
    const elapsed = now - lastTriggerRef.current;

    if (elapsed >= DEBOUNCE_MS) {
      lastTriggerRef.current = now;
      sendPrompt();
    } else {
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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // Subscribe to session state changes
  useEffect(() => {
    let prevFingerprint = "";
    const namedSessions = new Set<string>();
    const lastSummarisedAt = lastSummarisedAtRef.current;

    const unsub = useSessionStore.subscribe((state) => {
      const sessions = state.sessions.filter((s) => !s.isMetaAgent);

      if (
        sessions.length < MIN_SESSIONS ||
        sessions.every((s) => s.state === "starting")
      ) {
        return;
      }

      const fp = sessionFingerprint(sessions);
      if (fp === prevFingerprint) return;

      const prevSessions = prevFingerprint.split("|").reduce(
        (acc, pair) => {
          const [id, st] = pair.split(":");
          if (id) acc[id] = st;
          return acc;
        },
        {} as Record<string, string>
      );

      prevFingerprint = fp;

      const hasNewFirstResponse = sessions.some((s) => {
        if (s.metadata.assistantMessageCount >= 1 && !namedSessions.has(s.id)) {
          namedSessions.add(s.id);
          if (s.name === dirToTabName(s.config.workingDir)) return true;
        }
        return false;
      });

      const needsInitialSummary = sessions.some((s) => {
        return s.metadata.assistantMessageCount >= 1
          && !s.metadata.nodeSummary
          && s.state !== "dead"
          && s.state !== "starting"
          && !(lastSummarisedAt[s.id]);
      });

      const hasDriftedSession = sessions.some((s) => {
        const count = s.metadata.assistantMessageCount;
        const lastAt = lastSummarisedAt[s.id] ?? 0;
        return count >= 1 && count - lastAt >= RESUMMARISE_INTERVAL;
      });

      const hasIdleTransitionNeedingSummary = sessions.some((s) => {
        const prev = prevSessions[s.id];
        if (
          prev &&
          (prev === "thinking" || prev === "toolUse") &&
          s.state === "idle" &&
          s.metadata.assistantMessageCount >= 1
        ) {
          const lastAt = lastSummarisedAt[s.id] ?? 0;
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

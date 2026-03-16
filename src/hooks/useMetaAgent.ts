import { useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSessionStore } from "../store/sessions";
import { useSettingsStore } from "../store/settings";
import { sessionFingerprint } from "../lib/metaAgentUtils";
import { dirToTabName } from "../lib/claude";
import { writeToPty, registerPtyWriter, unregisterPtyWriter } from "../lib/ptyRegistry";
import { spawn as ptySpawn } from "tauri-pty";

const DEBOUNCE_MS = 15_000;
const MIN_SESSIONS = 1;
const RESUMMARISE_INTERVAL = 15;
const RESPONSE_TIMEOUT = 30_000;

/**
 * Persistent Haiku summariser — spawns ONE long-lived Claude session
 * with --model haiku. Response detection uses JSONL events (structured
 * data written by Claude Code), not terminal output parsing.
 *
 * Between requests, sends /clear to reset context. No process restarts.
 */
export function useMetaAgent(): { isRunning: boolean } {
  const updateMetadata = useSessionStore((s) => s.updateMetadata);

  const isRunningRef = useRef(false);
  const lastTriggerRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef(false);
  const lastSummarisedAtRef = useRef<Record<string, number>>({});

  // Persistent Haiku session state
  const metaSessionIdRef = useRef<string | null>(null);
  const metaReadyRef = useRef(false);
  const spawnAttemptedRef = useRef(false);
  // Resolves with the assistant response text when an end_turn event arrives
  const jsonlResolveRef = useRef<((text: string) => void) | null>(null);
  const jsonlUnlistenRef = useRef<(() => void) | null>(null);

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

      const sid = session.id;
      metaSessionIdRef.current = sid;

      // Spawn PTY
      const args = ["--model", "haiku", "--dangerously-skip-permissions",
        "--append-system-prompt", "You summarize Claude Code sessions. Return only valid JSON, no markdown, no explanation."];
      const pty = ptySpawn(claudePath, args, { cwd, cols: 200, rows: 50 });

      registerPtyWriter(sid, (data: string) => pty.write(data));

      // Respond to DSR queries so ink can render
      pty.onData((data: Uint8Array) => {
        const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data as unknown as number[]);
        const text = new TextDecoder().decode(bytes);
        if (text.includes("\x1b[6n")) {
          pty.write("\x1b[50;200R");
        }
      });

      pty.onExit(() => {
        metaReadyRef.current = false;
        metaSessionIdRef.current = null;
        spawnAttemptedRef.current = false;
        unregisterPtyWriter(sid);
        jsonlUnlistenRef.current?.();
        useSessionStore.getState().updateState(sid, "dead");
      });

      // Start JSONL watcher for the Haiku session
      invoke("start_jsonl_watcher", {
        sessionId: sid,
        workingDir: cwd,
        jsonlSessionId: null,
      });

      // Listen for JSONL events from the Haiku session.
      // When we see an assistant message with stop_reason: "end_turn",
      // extract the text and resolve the pending query.
      const unlisten = await listen<{ sessionId: string; line: string }>(
        "jsonl-event",
        (event) => {
          if (event.payload.sessionId !== sid) return;
          try {
            const parsed = JSON.parse(event.payload.line);
            if (parsed.type === "assistant" && parsed.message?.stop_reason === "end_turn") {
              const content = parsed.message.content || [];
              const textBlocks = content.filter((b: { type: string }) => b.type === "text");
              const responseText = textBlocks.map((b: { text: string }) => b.text || "").join("\n");
              if (jsonlResolveRef.current && responseText) {
                const resolve = jsonlResolveRef.current;
                jsonlResolveRef.current = null;
                resolve(responseText);
              }
            }
          } catch { /* skip invalid JSON */ }
        }
      );
      jsonlUnlistenRef.current = unlisten;

      // The Haiku session is ready immediately — no history to replay,
      // and the JSONL file won't exist until the first message is sent.
      // The JSONL event listener above will capture the response.
      metaReadyRef.current = true;
      useSessionStore.getState().updateState(sid, "idle");

      return true;
    } catch (err) {
      console.error("[useMetaAgent] Failed to spawn Haiku session:", err);
      spawnAttemptedRef.current = false;
      return false;
    }
  }, []);

  // Send a prompt to the persistent session and wait for JSONL response
  const queryHaiku = useCallback(async (prompt: string): Promise<string | null> => {
    const sid = metaSessionIdRef.current;
    if (!sid || !metaReadyRef.current) return null;

    // Clear context
    writeToPty(sid, "/clear\r");
    // Brief yield to let /clear process before sending the prompt
    await new Promise((r) => requestAnimationFrame(r));

    // Send prompt
    writeToPty(sid, prompt + "\r");

    // Wait for JSONL assistant response with end_turn
    return new Promise<string | null>((resolve) => {
      jsonlResolveRef.current = resolve;
      setTimeout(() => {
        if (jsonlResolveRef.current) {
          jsonlResolveRef.current = null;
          resolve(null);
        }
      }, RESPONSE_TIMEOUT);
    });
  }, []);

  const processResponse = useCallback((response: string) => {
    const renameSession = useSessionStore.getState().renameSession;
    let jsonStr = response.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
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
            const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
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

    const ready = await ensureMetaSession();
    if (!ready) return;

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

    const namingPart = needsNaming.length > 0
      ? ` Give a 2-4 word title for sessions: ${needsNaming.map((s) => s.id).join(",")}.`
      : "";
    const summaryPart = needsSummary.length > 0
      ? ` Summarize these sessions briefly: ${needsSummary.map((s) => s.id).join(",")}.`
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

  const triggerSummary = useCallback(() => {
    const now = Date.now();
    const elapsed = now - lastTriggerRef.current;
    if (elapsed >= DEBOUNCE_MS) {
      lastTriggerRef.current = now;
      sendPrompt();
    } else if (!pendingRef.current) {
      pendingRef.current = true;
      debounceTimerRef.current = setTimeout(() => {
        pendingRef.current = false;
        lastTriggerRef.current = Date.now();
        sendPrompt();
      }, DEBOUNCE_MS - elapsed);
    }
  }, [sendPrompt]);

  useEffect(() => {
    return () => { if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current); };
  }, []);

  useEffect(() => {
    let prevFingerprint = "";
    const namedSessions = new Set<string>();
    const lastSummarisedAt = lastSummarisedAtRef.current;

    const unsub = useSessionStore.subscribe((state) => {
      const sessions = state.sessions.filter((s) => !s.isMetaAgent);
      if (sessions.length < MIN_SESSIONS || sessions.every((s) => s.state === "starting")) return;

      const fp = sessionFingerprint(sessions);
      if (fp === prevFingerprint) return;

      const prevSessions = prevFingerprint.split("|").reduce((acc, pair) => {
        const [id, st] = pair.split(":");
        if (id) acc[id] = st;
        return acc;
      }, {} as Record<string, string>);
      prevFingerprint = fp;

      const hasNewFirstResponse = sessions.some((s) => {
        if (s.metadata.assistantMessageCount >= 1 && !namedSessions.has(s.id)) {
          namedSessions.add(s.id);
          if (s.name === dirToTabName(s.config.workingDir)) return true;
        }
        return false;
      });

      const needsInitialSummary = sessions.some((s) =>
        s.metadata.assistantMessageCount >= 1 && !s.metadata.nodeSummary
        && s.state !== "dead" && s.state !== "starting" && !(lastSummarisedAt[s.id])
      );

      const hasDriftedSession = sessions.some((s) => {
        const lastAt = lastSummarisedAt[s.id] ?? 0;
        return s.metadata.assistantMessageCount >= 1 && s.metadata.assistantMessageCount - lastAt >= RESUMMARISE_INTERVAL;
      });

      const hasIdleTransitionNeedingSummary = sessions.some((s) => {
        const prev = prevSessions[s.id];
        if (prev && (prev === "thinking" || prev === "toolUse") && s.state === "idle" && s.metadata.assistantMessageCount >= 1) {
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

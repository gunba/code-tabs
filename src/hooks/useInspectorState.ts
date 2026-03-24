import { useEffect, useRef, useCallback, useState } from "react";
import { useSessionStore } from "../store/sessions";
import { INSTALL_HOOK, POLL_STATE } from "../lib/inspectorHooks";
import { getSessionBufferTail } from "../lib/terminalRegistry";
import { dlog } from "../lib/debugLog";
import type { SessionState, SubagentMessage } from "../types/session";

/** Compact state returned by POLL_STATE expression. */
interface InspectorPollResult {
  n: number; sid: string | null; cost: number; model: string | null;
  stop: string | null; tools: string[]; inTok: number; outTok: number;
  events: Array<{ t: string; sr?: string; c?: number; txt?: string; ta?: string }>;
  lastEvent: string | null; firstMsg: string | null; lastText: string | null;
  userPrompt: string | null; permPending: boolean; idleDetected: boolean;
  toolAction: string | null; choiceHint: boolean;
  inputBuf: string; inputTs: number; fetchBypassed: number;
  fetchTimeouts: number; httpsTimeouts: number;
  promptDetected: boolean;
  subs: Array<{
    sid: string; desc: string; st: string; tok: number; act: string | null;
    msgs: Array<{ r: string; x: string; tn?: string }>; lastTs: number;
  }>;
  cwd: string | null;
}

/** Map inspector sub-state codes to SessionState values. */
const SUB_STATE_MAP: Record<string, SessionState> = { s: "starting", t: "thinking", u: "toolUse", i: "idle" };

/** Prompt markers for terminal buffer idle detection (matches useTerminal.ts). */
const PROMPT_MARKER_NEW = ">\u00A0"; // > + NBSP — current Claude Code prompt
const PROMPT_MARKER_OLD = "\u276F"; // ❯ — legacy Claude Code prompt

/** Delay before first connection attempt (PTY needs ~50ms to spawn, Bun ~1s to init). */
const CONNECT_DELAY_MS = 1000;
/** Interval between POLL_STATE evaluations. */
const POLL_INTERVAL_MS = 250;
/** Max reconnection attempts before giving up. */
const MAX_RETRIES = 3;
/** Backoff delays for reconnection attempts. */
const RETRY_DELAYS = [2000, 4000, 8000];

/**
 * Derive session state directly from inspector poll data.
 * No state machine — inspector captures everything via JSON.stringify interception.
 */
export function deriveStateFromPoll(
  data: InspectorPollResult,
  currentState: SessionState,
): SessionState {
  let state = currentState;

  // Events (since last poll) provide the most recent granular info
  if (data.events.length > 0) {
    const last = data.events[data.events.length - 1];
    if (last.t === "result") state = "idle";
    else if (last.t === "user") state = "thinking";
    else if (last.t === "assistant") {
      if (last.sr === "tool_use") state = "toolUse";
      else if (last.sr === "end_turn") state = "idle";
      else state = "thinking"; // still generating
    }
  } else if (data.n > 0) {
    // No events this poll — use persisted stop_reason
    if (data.stop === "tool_use") state = "toolUse";
    else if (data.stop === "end_turn") state = "idle";
    else if (data.stop === null && data.lastEvent === "user") state = "thinking";
    else if (data.lastEvent === "result") state = "idle";
    else if (data.stop !== null) state = "idle";
  }

  // Refine toolUse → actionNeeded for ExitPlanMode
  if (state === "toolUse" && data.tools.includes("ExitPlanMode")) state = "actionNeeded";

  // Notification flags override
  if (data.idleDetected) state = "idle";

  // Terminal buffer fallback: prompt visible + no events flowing → force idle.
  // Catches stuck thinking/toolUse when events are missed (e.g. POLL_STATE errors).
  if ((state === "thinking" || state === "toolUse") && data.events.length === 0 && data.promptDetected) state = "idle";

  // Refine idle → actionNeeded for CLI selectors (detected via terminal buffer)
  if (state === "idle" && data.choiceHint) state = "actionNeeded";

  // Permission always wins
  if (data.permPending) state = "waitingPermission";

  return state;
}

/**
 * Connects to Claude Code's BUN_INSPECT WebSocket and polls internal state
 * via JSON.stringify interception. Sole source of state detection — no JSONL fallback.
 */
export function useInspectorState(
  sessionId: string | null,
  port: number | null,
  reconnectKey?: number
): { connected: boolean; disconnect: () => void; inputText: string; inputTs: number; userPrompt: string | null; claudeSessionId: string | null; completionCount: number } {
  const [connected, setConnected] = useState(false);
  const [inputText, setInputText] = useState("");
  const [inputTs, setInputTs] = useState(0);
  const [userPrompt, setUserPrompt] = useState<string | null>(null);
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
  const [completionCount, setCompletionCount] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hookInstalledRef = useRef(false);
  const msgIdRef = useRef(1);
  const lastStateRef = useRef<SessionState>("starting");
  const lastFingerprintRef = useRef("");
  const lastSidRef = useRef<string | null>(null);
  const knownSubsRef = useRef<Set<string>>(new Set());
  const fetchBypassLoggedRef = useRef(false);
  const fetchTimeoutLoggedRef = useRef(false);
  const httpsTimeoutLoggedRef = useRef(false);
  const noEventTicksRef = useRef(0);
  const lastCwdRef = useRef<string | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const updateState = useSessionStore((s) => s.updateState);
  const updateMetadata = useSessionStore((s) => s.updateMetadata);
  const updateConfig = useSessionStore((s) => s.updateConfig);

  // Send a WebSocket message with auto-incrementing id
  const wsSend = useCallback((method: string, params?: Record<string, unknown>): number => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return -1;
    const id = msgIdRef.current++;
    ws.send(JSON.stringify({ id, method, params }));
    return id;
  }, []);

  // Process poll result and update store — direct state derivation, no state machine
  const processPollResult = useCallback((data: InspectorPollResult) => {
    const sid = sessionIdRef.current;
    if (!sid) return;

    // Track consecutive polls with no events (detects stale state)
    if (data.events.length === 0) {
      noEventTicksRef.current++;
    } else {
      noEventTicksRef.current = 0;
    }

    // Detect CLI selectors from terminal buffer: Ink renders "> 1." for the
    // selected item and "  2." for subsequent items. Check last 15 lines.
    const tail = getSessionBufferTail(sid, 15);
    const selectorActive = tail !== null && tail.includes("> 1.") && tail.includes("2.");
    data.choiceHint = selectorActive;

    // Terminal buffer idle fallback: if no events for 2+ polls (500ms) and
    // the Claude Code prompt is visible on the last terminal line, flag it.
    // Guards against stuck thinking/toolUse when POLL_STATE errors lose events.
    if (noEventTicksRef.current >= 2 && tail !== null) {
      const lastLine = tail.split("\n").pop() || "";
      data.promptDetected = lastLine.includes(PROMPT_MARKER_NEW) || lastLine.includes(PROMPT_MARKER_OLD);
    } else {
      data.promptDetected = false;
    }

    const derivedState = deriveStateFromPoll(data, lastStateRef.current);

    // Signal genuine completion: only on transition TO idle via event-confirmed source.
    // Queued input watches this instead of session.state to avoid false idle flashes.
    if (derivedState === "idle" && lastStateRef.current !== "idle") {
      const lastEvt = data.events.length > 0 ? data.events[data.events.length - 1] : null;
      const eventConfirmed = lastEvt != null && (
        lastEvt.t === "result" ||
        (lastEvt.t === "assistant" && lastEvt.sr === "end_turn")
      );
      if (eventConfirmed || data.idleDetected) {
        setCompletionCount(c => c + 1);
      }
    }

    if (derivedState !== lastStateRef.current) {
      dlog("inspector", sid, `state ${lastStateRef.current} → ${derivedState}`);
      updateState(sid, derivedState);
      lastStateRef.current = derivedState;
    }

    // Build metadata entirely from inspector data
    const metadata = {
      costUsd: data.cost,
      inputTokens: data.inTok,
      outputTokens: data.outTok,
      currentAction: data.toolAction,
      currentToolName: data.tools.length > 0 ? data.tools[data.tools.length - 1] : null,
      choiceHint: selectorActive,
      runtimeModel: data.model ?? null,
      ...(data.firstMsg ? { nodeSummary: data.firstMsg } : {}),
    };
    const fp = JSON.stringify(metadata);
    if (fp !== lastFingerprintRef.current) {
      lastFingerprintRef.current = fp;
      updateMetadata(sid, metadata);
    }

    // ── Worktree cwd detection ──
    // When Claude enters a worktree via -w, process.cwd() changes.
    // Update workingDir so tab acronym, resume cwd, and prune all work.
    if (data.cwd && data.cwd !== lastCwdRef.current) {
      lastCwdRef.current = data.cwd;
      // Normalize to backslashes on Windows for consistent comparison
      const normalized = data.cwd.replace(/\//g, "\\");
      const session = useSessionStore.getState().sessions.find((s) => s.id === sid);
      if (session && normalized !== session.config.workingDir) {
        updateConfig(sid, { workingDir: normalized });
      }
    }

    // ── Subagent tracking (routed by agentId in the hook) ──
    if (data.subs.length > 0) {
      const { addSubagent, updateSubagent, clearIdleSubagents, subagents } = useSessionStore.getState();
      const existing = subagents.get(sid) || [];
      const hasNewSubs = data.subs.some(sub => !knownSubsRef.current.has(sub.sid));
      if (hasNewSubs) clearIdleSubagents(sid);

      for (const sub of data.subs) {
        const subState = SUB_STATE_MAP[sub.st] || "starting";
        const newMsgs: SubagentMessage[] = sub.msgs.map(m => ({
          role: m.r === "a" ? "assistant" as const : "tool" as const,
          text: m.x, toolName: m.tn, timestamp: Date.now(),
        }));

        if (!knownSubsRef.current.has(sub.sid)) {
          knownSubsRef.current.add(sub.sid);
          dlog("inspector", sid, `subagent discovered id=${sub.sid} desc="${sub.desc}"`, "DEBUG");
          addSubagent(sid, {
            id: sub.sid, parentSessionId: sid, state: subState,
            description: sub.desc, tokenCount: sub.tok,
            currentAction: sub.act, messages: newMsgs,
          });
        } else {
          const existingSub = existing.find(s => s.id === sub.sid);
          const allMsgs = existingSub ? [...existingSub.messages, ...newMsgs] : newMsgs;
          updateSubagent(sid, sub.sid, {
            state: subState, tokenCount: sub.tok, currentAction: sub.act,
            messages: allMsgs.length > 200 ? allMsgs.slice(-200) : allMsgs,
          });
        }
      }
    }

    // Track Claude's internal session ID (changes on /resume, plan-mode fork, compaction)
    if (data.sid && data.sid !== lastSidRef.current) {
      dlog("inspector", sid, `claude sessionId changed ${lastSidRef.current} → ${data.sid}`, "DEBUG");
      lastSidRef.current = data.sid;
      setClaudeSessionId(data.sid);
    }

    // Detect slash commands from actual sent messages.
    // Use user events (not userPrompt comparison) so repeated same-commands are caught.
    if (data.events.some(e => e.t === "user") && data.userPrompt?.startsWith("/")) {
      useSessionStore.getState().addCommandHistory(sid, data.userPrompt.split(" ")[0]);
    }

    setUserPrompt(data.userPrompt);
    setInputText(data.inputBuf);
    setInputTs(data.inputTs);

    // Log WebFetch domain blocklist bypass (only on first occurrence)
    if (data.fetchBypassed > 0 && !fetchBypassLoggedRef.current) {
      dlog("inspector", sid, "WebFetch domain blocklist bypass active", "WARN");
      fetchBypassLoggedRef.current = true;
    }
    if (data.fetchTimeouts > 0 && !fetchTimeoutLoggedRef.current) {
      dlog("inspector", sid, "WebFetch API timeout (non-streaming >120s)", "WARN");
      fetchTimeoutLoggedRef.current = true;
    }
    if (data.httpsTimeouts > 0 && !httpsTimeoutLoggedRef.current) {
      dlog("inspector", sid, "HTTPS hard timeout (external >90s)", "WARN");
      httpsTimeoutLoggedRef.current = true;
    }
  }, [updateState, updateMetadata, updateConfig]);

  // Start polling loop
  const startPolling = useCallback(() => {
    if (pollTimerRef.current) return;
    pollTimerRef.current = setInterval(() => {
      wsSend("Runtime.evaluate", { expression: POLL_STATE, returnByValue: true });
    }, POLL_INTERVAL_MS);
  }, [wsSend]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // Connect to inspector WebSocket. Uses connectRef for retry self-reference
  // to avoid stale closure if deps change between retries.
  const connectRef = useRef<(port: number) => void>(() => {});
  const connect = useCallback((wsPort: number) => {
    const url = `ws://127.0.0.1:${wsPort}/0`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      dlog("inspector", sessionIdRef.current, `connected port=${wsPort}`);
      retryCountRef.current = 0;
      wsSend("Console.enable");
      if (!hookInstalledRef.current) {
        wsSend("Runtime.evaluate", { expression: INSTALL_HOOK, returnByValue: true });
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        // Check for hook install response
        if (msg.result?.result?.value === "ok" || msg.result?.result?.value === "already") {
          if (!hookInstalledRef.current) {
            hookInstalledRef.current = true;
            dlog("inspector", sessionIdRef.current, `hook installed (${msg.result.result.value})`, "DEBUG");
            setConnected(true);
            startPolling();
          }
        }

        // Check for poll result
        if (msg.result?.result?.type === "object" && msg.result?.result?.value) {
          const pollData = msg.result.result.value as InspectorPollResult;
          if (typeof pollData.n === "number") {
            processPollResult(pollData);
          }
        }

        // Log Runtime.evaluate exceptions (e.g. POLL_STATE crash)
        if (msg.result?.exceptionDetails) {
          dlog("inspector", sessionIdRef.current, `evaluation error: ${msg.result.exceptionDetails.text || msg.result.exceptionDetails.exception?.description}`, "WARN");
        }
      } catch {
        // Invalid message — skip
      }
    };

    ws.onclose = () => {
      dlog("inspector", sessionIdRef.current, `disconnected port=${wsPort}`);
      setConnected(false);
      stopPolling();
      wsRef.current = null;

      // Retry with backoff via ref to avoid stale self-reference
      if (retryCountRef.current < MAX_RETRIES && sessionIdRef.current) {
        const delay = RETRY_DELAYS[retryCountRef.current] || 8000;
        retryCountRef.current++;
        dlog("inspector", sessionIdRef.current, `reconnecting attempt=${retryCountRef.current}/${MAX_RETRIES} delay=${delay}ms`, "DEBUG");
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          if (sessionIdRef.current) connectRef.current(wsPort);
        }, delay);
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror — reconnection handled there
    };
  }, [wsSend, startPolling, stopPolling, processPollResult]);
  connectRef.current = connect;

  const disconnect = useCallback(() => {
    stopPolling();
    // Cancel any pending retry timer to prevent zombie reconnections
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    const ws = wsRef.current;
    if (ws) {
      ws.onclose = null; // Prevent reconnection
      ws.close();
      wsRef.current = null;
    }
    setConnected(false);
    hookInstalledRef.current = false;
    retryCountRef.current = 0;
    lastStateRef.current = "starting";
    lastFingerprintRef.current = "";
    lastSidRef.current = null;
    knownSubsRef.current = new Set();
    noEventTicksRef.current = 0;
    msgIdRef.current = 1;
    setClaudeSessionId(null);
    setCompletionCount(0);
    setInputText("");
    setInputTs(0);
    setUserPrompt(null);
  }, [stopPolling]);

  // Lifecycle: connect after delay when port is available
  useEffect(() => {
    if (!sessionId || !port) return;

    hookInstalledRef.current = false;
    retryCountRef.current = 0;

    const timer = setTimeout(() => {
      connect(port);
    }, CONNECT_DELAY_MS);

    return () => {
      clearTimeout(timer);
      disconnect();
    };
  }, [sessionId, port, connect, disconnect, reconnectKey]);

  return { connected, disconnect, inputText, inputTs, userPrompt, claudeSessionId, completionCount };
}

import { useEffect, useRef, useCallback, useState } from "react";
import { useSessionStore } from "../store/sessions";
import { INSTALL_HOOK, POLL_STATE } from "../lib/inspectorHooks";
import type { SessionState, SubagentMessage } from "../types/session";

/** Compact state returned by POLL_STATE expression. */
interface InspectorPollResult {
  n: number;
  sid: string | null;
  cost: number;
  model: string | null;
  stop: string | null;
  tools: string[];
  perm: string | null;
  inTok: number;
  outTok: number;
  dur: number;
  events: Array<{ t: string; sr?: string; c?: number; txt?: string; nt?: string; ta?: string }>;
  lastEvent: string | null;
  firstMsg: string | null;
  lastText: string | null;
  userPrompt: string | null;
  permPending: boolean;
  idleDetected: boolean;
  toolAction: string | null;
  choiceHint: boolean;
  thinking: Array<{ x: string; ts: number; r: boolean }>;
  subagentDescs: string[];
  inputBuf: string;
  inputTs: number;
  subs: Array<{
    sid: string; desc: string; st: string; tok: number; act: string | null;
    msgs: Array<{ r: string; x: string; tn?: string }>; lastTs: number;
  }>;
}

/** Map inspector sub-state codes to SessionState values. */
const SUB_STATE_MAP: Record<string, SessionState> = { s: "starting", t: "thinking", u: "toolUse", i: "idle" };

/** States that indicate a subagent is actively running (not idle or dead). */
const SUBAGENT_ACTIVE_STATES = new Set<string>(["thinking", "toolUse", "starting"]);

/** Delay before first connection attempt (PTY needs ~50ms to spawn, Bun ~1s to init). */
const CONNECT_DELAY_MS = 1000;
/** Interval between POLL_STATE evaluations. */
const POLL_INTERVAL_MS = 1000;
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
  if (state === "toolUse" && data.tools.includes("ExitPlanMode")) {
    state = "actionNeeded";
  }

  // Notification flags override
  if (data.idleDetected) state = "idle";

  // Refine idle → actionNeeded for choice questions
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
): { connected: boolean; disconnect: () => void; inputText: string; inputTs: number; userPrompt: string | null; claudeSessionId: string | null } {
  const [connected, setConnected] = useState(false);
  const [inputText, setInputText] = useState("");
  const [inputTs, setInputTs] = useState(0);
  const [userPrompt, setUserPrompt] = useState<string | null>(null);
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
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
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const updateState = useSessionStore((s) => s.updateState);
  const updateMetadata = useSessionStore((s) => s.updateMetadata);

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

    const derivedState = deriveStateFromPoll(data, lastStateRef.current);
    if (derivedState !== lastStateRef.current) {
      console.log(`[inspector] state ${lastStateRef.current} → ${derivedState} session=${sid}`);
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
      choiceHint: data.choiceHint ?? false,
      runtimeModel: data.model ?? null,
      ...(data.firstMsg ? { nodeSummary: data.firstMsg } : {}),
    };
    const fp = JSON.stringify(metadata);
    if (fp !== lastFingerprintRef.current) {
      lastFingerprintRef.current = fp;
      updateMetadata(sid, metadata);
    }

    // ── Thinking blocks ──
    if (data.thinking.length > 0) {
      const { appendThinkingBlocks } = useSessionStore.getState();
      appendThinkingBlocks(sid, data.thinking.map(t => ({
        text: t.x, timestamp: t.ts, redacted: t.r,
      })));
    }

    // ── Subagent tracking (routed by agentId in the hook) ──
    if (data.subs.length > 0) {
      const { addSubagent, updateSubagent, removeDeadSubagents, subagents } = useSessionStore.getState();
      const existing = subagents.get(sid) || [];

      // When new subagent appears and no subs are actively running: mark idle as dead, then purge
      const hasNewSubs = data.subs.some(s => !knownSubsRef.current.has(s.sid));
      if (hasNewSubs && existing.length > 0) {
        const anyRunning = existing.some(s => SUBAGENT_ACTIVE_STATES.has(s.state));
        if (!anyRunning) {
          for (const old of existing) {
            if (old.state === "idle") updateSubagent(sid, old.id, { state: "dead" });
          }
          removeDeadSubagents(sid);
        }
      }

      for (const sub of data.subs) {
        const subState = SUB_STATE_MAP[sub.st] || "starting";
        const newMsgs: SubagentMessage[] = sub.msgs.map(m => ({
          role: m.r === "a" ? "assistant" : "tool",
          text: m.x,
          toolName: m.tn,
          timestamp: Date.now(),
        }));

        const isNew = !knownSubsRef.current.has(sub.sid);
        // Mark stale non-idle subs as dead (30s without events)
        const isStale = !isNew && subState !== "idle" && Date.now() - sub.lastTs > 30000;
        const effectiveState = isStale ? "dead" as const : subState;

        if (isNew) {
          knownSubsRef.current.add(sub.sid);
          addSubagent(sid, {
            id: sub.sid,
            parentSessionId: sid,
            state: effectiveState,
            description: sub.desc,
            tokenCount: sub.tok,
            currentAction: sub.act,
            messages: newMsgs,
          });
        } else {
          const existingSub = existing.find(s => s.id === sub.sid);
          const allMsgs = existingSub ? [...existingSub.messages, ...newMsgs] : newMsgs;
          updateSubagent(sid, sub.sid, {
            state: effectiveState,
            tokenCount: sub.tok,
            currentAction: sub.act,
            messages: allMsgs.length > 200 ? allMsgs.slice(-200) : allMsgs,
          });
        }
      }
    }

    // Track Claude's internal session ID (changes on /resume, plan-mode fork, compaction)
    if (data.sid && data.sid !== lastSidRef.current) {
      lastSidRef.current = data.sid;
      setClaudeSessionId(data.sid);
    }

    setUserPrompt(data.userPrompt);
    setInputText(data.inputBuf);
    setInputTs(data.inputTs);
  }, [updateState, updateMetadata]);

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
      console.log(`[inspector] connected port=${wsPort}`);
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
      } catch {
        // Invalid message — skip
      }
    };

    ws.onclose = () => {
      console.log(`[inspector] disconnected port=${wsPort}`);
      setConnected(false);
      stopPolling();
      wsRef.current = null;

      // Retry with backoff via ref to avoid stale self-reference
      if (retryCountRef.current < MAX_RETRIES && sessionIdRef.current) {
        const delay = RETRY_DELAYS[retryCountRef.current] || 8000;
        retryCountRef.current++;
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
    msgIdRef.current = 1;
    setClaudeSessionId(null);
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

  return { connected, disconnect, inputText, inputTs, userPrompt, claudeSessionId };
}

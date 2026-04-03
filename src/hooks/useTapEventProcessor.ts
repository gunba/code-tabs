import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../store/sessions";
import { tapEventBus } from "../lib/tapEventBus";
import { reduceTapEvent, isCompletionEvent } from "../lib/tapStateReducer";
import { TapMetadataAccumulator } from "../lib/tapMetadataAccumulator";
import { TapSubagentTracker } from "../lib/tapSubagentTracker";
import { normalizePath } from "../lib/paths";
import { getResumeId, resolveModelFamily } from "../lib/claude";
import { useSettingsStore } from "../store/settings";
import { dlog } from "../lib/debugLog";
import { getNoisyEventKinds } from "../lib/noisyEventKinds";
import type { TapEvent } from "../types/tapEvents";
import type { SessionState, PermissionMode } from "../types/session";


/** Return discriminating fields for key event types (for debug logs). */
function eventDetail(event: TapEvent): string {
  switch (event.kind) {
    case "ConversationMessage":
      return ` type=${event.messageType} sidechain=${event.isSidechain} stop=${event.stopReason} agent=${event.agentId}`;
    case "TurnEnd":
      return ` stop=${event.stopReason}`;
    case "ToolCallStart":
      return ` tool=${event.toolName}`;
    case "PermissionPromptShown":
    case "PermissionApproved":
      return ` tool=${event.toolName}`;
    case "SubagentSpawn":
      return ` desc="${event.description.slice(0, 50)}"`;
    case "SubagentNotification":
      return ` status=${event.status}`;
    case "SubagentLifecycle":
      return ` variant=${event.variant} type=${event.agentType}`;
    case "UserInput":
      return ` "${event.display.slice(0, 30)}"`;
    case "SlashCommand":
      return ` ${event.command}`;
    default:
      return "";
  }
}

// [SI-13] Event priority: runs reduceTapEvent which enforces sticky actionNeeded guard
// [SI-20] Worktree cwd detection: ConversationMessage/SessionRegistration/WorktreeState -> updateConfig
// [SI-23] Plan detection: ToolCallStart(ExitPlanMode) handled by reducer, processor dispatches
/**
 * React hook bridging tapEventBus to the Zustand store.
 * Subscribes to tap events for a session, runs reducers, updates store.
 * Sole source of state/metadata/subagent data (replaces useInspectorState's processing).
 */
export function useTapEventProcessor(
  sessionId: string | null
): { completionCount: number; claudeSessionId: string | null; userPrompt: string | null } {
  const updateState = useSessionStore((s) => s.updateState);
  const updateMetadata = useSessionStore((s) => s.updateMetadata);
  const updateConfig = useSessionStore((s) => s.updateConfig);
  const addSubagent = useSessionStore((s) => s.addSubagent);
  const updateSubagent = useSessionStore((s) => s.updateSubagent);
  const clearIdleSubagents = useSessionStore((s) => s.clearIdleSubagents);
  const addSkillInvocation = useSessionStore((s) => s.addSkillInvocation);
  const addCommandHistory = useSessionStore((s) => s.addCommandHistory);
  const updateProcessHealth = useSessionStore((s) => s.updateProcessHealth);

  // useState for values that TerminalPanel reacts to
  const [completionCount, setCompletionCount] = useState(0);
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
  const [userPrompt, setUserPrompt] = useState<string | null>(null);

  const stateRef = useRef<SessionState>("starting");
  const metaAccRef = useRef<TapMetadataAccumulator | null>(null);
  const subTrackerRef = useRef<TapSubagentTracker | null>(null);
  const healthCountRef = useRef(0);
  const lastHighMemWarnRef = useRef(0);
  const apiIpResolvedRef = useRef(false);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    if (!sessionId) return;

    // Create per-session instances
    const metaAcc = new TapMetadataAccumulator();
    const subTracker = new TapSubagentTracker(sessionId);
    metaAccRef.current = metaAcc;
    subTrackerRef.current = subTracker;
    stateRef.current = "starting";
    setCompletionCount(0);
    setClaudeSessionId(null);
    setUserPrompt(null);

    const updateCwdIfChanged = (cwd: string) => {
      const normalized = normalizePath(cwd);
      const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
      if (session && normalized !== session.config.workingDir) {
        updateConfig(sessionId, { workingDir: normalized });
      }
    };

    const handleEvent = (event: TapEvent) => {
      const sid = sessionIdRef.current;
      if (!sid) return;

      useSessionStore.getState().addSeenEventKind(event.kind);

      if (!getNoisyEventKinds().has(event.kind)) {
        dlog("tap", sid, `[${event.cat || "?"}] ${event.kind}${eventDetail(event)}`, "DEBUG");
      }

      // No UUID dedup — CLI re-serializes conversation messages for JSONL persistence
      // and hook dispatch (2-3 stringify calls per message), but the state reducer is
      // idempotent and metadata accumulator overwrites. The only effect of duplicates
      // is 2-3x subagent messages in the inspector, capped at 200 per agent.
      // Previous UUID dedup caused actionNeeded to get stuck: the set's 500-entry
      // eviction could forget UUIDs, letting stale re-serialized messages race with
      // state transitions and swallow the ConversationMessage(user) that clears it.

      // 1. State reducer
      const prevState = stateRef.current;
      const newState = reduceTapEvent(prevState, event);
      if (newState !== prevState) {
        dlog("inspector", sid, `state ${prevState} → ${newState} (${event.kind})`);
        stateRef.current = newState;
        updateState(sid, newState);
      } else if (!getNoisyEventKinds().has(event.kind)) {
        dlog("inspector", sid, `state ${prevState} unchanged by ${event.kind}`, "DEBUG");
      }

      // Completion signals for queued input dispatch (only when state actually applied, not suppressed)
      if (stateRef.current === "idle" && prevState !== "idle" && isCompletionEvent(event)) {
        dlog("inspector", sid, `completion signal (${event.kind})`, "DEBUG");
        setCompletionCount((c) => c + 1);
      }

      // Read originalCwd BEFORE accumulator clears worktreeInfo
      let worktreeExitCwd: string | null = null;
      if (event.kind === "WorktreeCleared") {
        const session = useSessionStore.getState().sessions.find((s) => s.id === sid);
        worktreeExitCwd = session?.metadata?.worktreeInfo?.originalCwd || null;
      }

      // 2. Metadata accumulator
      const metaDiff = metaAcc.process(event);
      if (metaDiff) {
        updateMetadata(sid, metaDiff);
      }

      // 2a. [TA-02] Track unique tool names seen across all sessions
      if (event.kind === "ToolCallStart") {
        useSessionStore.getState().addSeenToolName(event.toolName);
      }

      // 2b. Model registry — capture observed model IDs + context window sizes
      if (event.kind === "StatusLineUpdate" && event.modelId && event.contextWindowSize > 0) {
        const family = resolveModelFamily(event.modelId);
        if (family) {
          useSettingsStore.getState().updateModelRegistry({
            modelId: event.modelId,
            family: family.keyword,
            contextWindowSize: event.contextWindowSize,
            lastSeenAt: Date.now(),
          });
        }
      }

      // 3. Subagent tracker
      const subActions = subTracker.process(event);
      for (const action of subActions) {
        if (action.type === "clearIdle") {
          clearIdleSubagents(sid);
        } else if (action.type === "add" && action.subagent) {
          dlog("inspector", sid, `subagent discovered id=${action.subagent.id} desc="${action.subagent.description}"`, "DEBUG");
          addSubagent(sid, action.subagent);
        } else if (action.type === "update" && action.subagentId && action.updates) {
          updateSubagent(sid, action.subagentId, action.updates);
        }
      }

      // 4. Skill invocations
      if (event.kind === "SkillInvocation") {
        dlog("tap", sid, `skill invoked: ${event.skill} (success=${event.success})`, "DEBUG");
        addSkillInvocation(sid, {
          id: `skill-${event.ts}-${event.skill}`,
          skill: event.skill,
          success: event.success,
          allowedTools: event.allowedTools,
          timestamp: event.ts,
        });
      }

      // 5. Session-level signals
      // [SS-01] [SS-02] Detect session switches via sid field change (plan-mode fork, /resume, compaction)
      // Gate behind isSubagentInFlight: subagent session init records arrive through TAP
      // before the first sidechain ConversationMessage, so sidechainActive alone is insufficient.
      if (event.kind === "SessionRegistration") {
        if (!subTracker.isSubagentInFlight()) {
          setClaudeSessionId(event.sessionId);
        } else {
          dlog("tap", sid, `SessionRegistration(${event.sessionId}) suppressed — subagent in flight`, "DEBUG");
        }
      }

      // [SL-18] CustomTitle always persists to session store + settings sessionNames map
      if (event.kind === "CustomTitle") {
        const session = useSessionStore.getState().sessions.find((s) => s.id === sid);
        if (session && event.title !== session.name) {
          useSessionStore.getState().renameSession(sid, event.title);
          useSettingsStore.getState().setSessionName(getResumeId(session), event.title);
        }
      }

      if (event.kind === "UserInput" || event.kind === "SlashCommand") {
        setUserPrompt(event.display.slice(0, 200));
      }

      if (event.kind === "SlashCommand") {
        addCommandHistory(sid, event.command, event.ts);
        useSettingsStore.getState().recordCommandUsage(event.command);
      }

      // SystemPromptCapture → collect all unique observed prompts
      if (event.kind === "SystemPromptCapture") {
        useSettingsStore.getState().addObservedPrompt(event.text, event.model);
      }

      // ProcessHealth → store (throttled to ~every 5s)
      if (event.kind === "ProcessHealth") {
        healthCountRef.current++;
        if (healthCountRef.current % 5 === 0) {
          updateProcessHealth(sid, { rss: event.rss, heapUsed: event.heapUsed, uptime: event.uptime });
        }
        if (event.rss > 1_000_000_000) {
          const now = Date.now();
          if (now - lastHighMemWarnRef.current >= 600_000) {
            lastHighMemWarnRef.current = now;
            dlog("inspector", sid, `High memory: ${Math.round(event.rss / 1_000_000)}MB RSS`, "WARN");
          }
        }
      }

      // EffortLevel → persist to config for resume
      if (event.kind === "EffortLevel") {
        updateConfig(sid, { effort: event.level });
      }

      // ModeChange → reactive permission icon
      if (event.kind === "ModeChange") {
        const modeMap: Record<string, PermissionMode> = {
          "default": "default",
          "acceptEdits": "acceptEdits",
          "plan": "planMode",
          "bypassPermissions": "bypassPermissions",
        };
        const mapped = modeMap[event.to];
        if (mapped) {
          updateConfig(sid, { permissionMode: mapped });
        }
      }

      // [SI-20] Worktree cwd detection: SessionRegistration gated behind isSubagentInFlight
      if (event.kind === "ConversationMessage" && event.cwd && !event.isSidechain) {
        updateCwdIfChanged(event.cwd);
      }
      if (event.kind === "SessionRegistration" && event.cwd) {
        if (!subTracker.isSubagentInFlight()) {
          updateCwdIfChanged(event.cwd);
        } else {
          dlog("tap", sid, `SessionRegistration cwd(${event.cwd}) suppressed — subagent in flight`, "DEBUG");
        }
      }
      // WorktreeState: authoritative worktree path from CLI
      if (event.kind === "WorktreeState" && event.worktreePath) {
        updateCwdIfChanged(event.worktreePath);
      }
      // WorktreeCleared: restore original working directory
      if (event.kind === "WorktreeCleared" && worktreeExitCwd) {
        updateCwdIfChanged(worktreeExitCwd);
      }

      // Resolve API IP on first fetch (skip if already resolved by any session)
      if (event.kind === "ApiFetch" && !apiIpResolvedRef.current && !useSettingsStore.getState().apiIp) {
        apiIpResolvedRef.current = true;
        invoke("resolve_api_host")
          .then((ip) => useSettingsStore.getState().setApiIp(ip as string))
          .catch((err: unknown) => dlog("session", sid, `API IP resolve failed: ${err}`, "WARN"));
      }
    };

    const unsub = tapEventBus.subscribe(sessionId, handleEvent);

    return () => {
      unsub();
      metaAcc.reset();
      subTracker.reset();
      metaAccRef.current = null;
      subTrackerRef.current = null;
    };
  }, [sessionId, updateState, updateMetadata, updateConfig, addSubagent, updateSubagent, clearIdleSubagents, addSkillInvocation, addCommandHistory, updateProcessHealth]);

  return { completionCount, claudeSessionId, userPrompt };
}

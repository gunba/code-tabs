import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../store/sessions";
import { tapEventBus } from "../lib/tapEventBus";
import { reduceTapEvent, isCompletionEvent } from "../lib/tapStateReducer";
import { TapMetadataAccumulator } from "../lib/tapMetadataAccumulator";
import { TapSubagentTracker } from "../lib/tapSubagentTracker";
import { normalizePath } from "../lib/paths";
import { getResumeId } from "../lib/claude";
import { useSettingsStore } from "../store/settings";
import { dlog } from "../lib/debugLog";
import type { TapEvent } from "../types/tapEvents";
import type { SessionState, PermissionMode } from "../types/session";

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
  const apiIpResolvedRef = useRef(false);
  const seenUuidsRef = useRef(new Set<string>());
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

      // Dedup ConversationMessage by uuid — CLI re-serializes conversation for JSONL
      // persistence and hook dispatch, which fires duplicate events through the tap pipeline.
      // The _sealed mechanism only operates in INSTALL_HOOK (unused), not INSTALL_TAPS.
      if (event.kind === "ConversationMessage" && event.uuid) {
        if (seenUuidsRef.current.has(event.uuid)) return;
        seenUuidsRef.current.add(event.uuid);
        if (seenUuidsRef.current.size > 500) seenUuidsRef.current.clear();
      }

      // 1. State reducer — filter SSE events when subagents are active
      const prevState = stateRef.current;
      const newState = reduceTapEvent(prevState, event);
      if (newState !== prevState) {
        // SSE events (TurnStart/TurnEnd/etc.) can't distinguish main from subagent API calls.
        // When subagents are active, only apply state changes from reliable main-agent events.
        // ConversationMessage (has isSidechain flag) provides equivalent state info with slight delay.
        const isReliable = event.kind === "UserInput" || event.kind === "SlashCommand"
          || event.kind === "PermissionPromptShown" || event.kind === "PermissionApproved"
          || event.kind === "PermissionRejected" || event.kind === "UserInterruption"
          || (event.kind === "ConversationMessage" && !event.isSidechain)
          || (event.kind === "ToolCallStart" && event.toolName === "ExitPlanMode")
          || event.kind === "IdlePrompt";

        if (!isReliable && subTracker.hasActiveAgents()) {
          dlog("inspector", sid, `suppressed ${prevState} → ${newState} (subagents active, event=${event.kind})`, "DEBUG");
        } else {
          dlog("inspector", sid, `state ${prevState} → ${newState}`);
          stateRef.current = newState;
          updateState(sid, newState);
        }
      }

      // Completion signals for queued input dispatch (only when state actually applied, not suppressed)
      if (stateRef.current === "idle" && prevState !== "idle" && isCompletionEvent(event)) {
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
      if (event.kind === "SessionRegistration") {
        setClaudeSessionId(event.sessionId);
      }

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
        addCommandHistory(sid, event.command);
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
          dlog("inspector", sid, `High memory: ${Math.round(event.rss / 1_000_000)}MB RSS`, "WARN");
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

      // Worktree cwd detection
      if (event.kind === "ConversationMessage" && event.cwd) {
        updateCwdIfChanged(event.cwd);
      }
      if (event.kind === "SessionRegistration" && event.cwd) {
        updateCwdIfChanged(event.cwd);
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
      seenUuidsRef.current.clear();
    };
  }, [sessionId, updateState, updateMetadata, updateConfig, addSubagent, updateSubagent, clearIdleSubagents, addSkillInvocation, addCommandHistory, updateProcessHealth]);

  return { completionCount, claudeSessionId, userPrompt };
}

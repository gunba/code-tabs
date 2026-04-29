import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../store/sessions";
import { tapEventBus } from "../lib/tapEventBus";
import { reduceTapEvent, shouldSuppressParentStateTransition } from "../lib/tapStateReducer";
import { TapMetadataAccumulator } from "../lib/tapMetadataAccumulator";
import { TapSubagentTracker } from "../lib/tapSubagentTracker";
import { getResumeId, resolveModelFamily } from "../lib/claude";
import { useSettingsStore } from "../store/settings";
import { dlog } from "../lib/debugLog";
import { getNoisyEventKinds } from "../lib/noisyEventKinds";
import { traceSync } from "../lib/perfTrace";
import { apiHostForFetch } from "../lib/apiEndpoint";
import type { TapEvent } from "../types/tapEvents";
import type { SessionState, PermissionMode } from "../types/session";
import { getTapCategoryLabel, getTapCategoryMeta } from "../lib/tapCatalog";
import { createTapActivityTracker } from "./tapActivityTracker";
import { createTapCodexNaming } from "./tapCodexNaming";
import { handleTapPromptCaptureBridge } from "./tapPromptCaptureBridge";
import { subscribeTapSettledIdleHandler } from "./tapSettledIdleHandler";
import { createTapWorktreeSync } from "./tapWorktreeSync";

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

function stateTransitionData(prevState: SessionState, newState: SessionState, event: TapEvent) {
  return {
    event: "tap.state_transition",
    data: {
      prevState,
      newState,
      kind: event.kind,
      cat: event.cat ?? null,
      toolName: "toolName" in event ? event.toolName : null,
      stopReason: "stopReason" in event ? event.stopReason : null,
      messageType: "messageType" in event ? event.messageType : null,
      isSidechain: "isSidechain" in event ? event.isSidechain : null,
    },
  };
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
): { claudeSessionId: string | null; userPrompt: string | null } {
  const updateState = useSessionStore((s) => s.updateState);
  const updateMetadata = useSessionStore((s) => s.updateMetadata);
  const updateConfig = useSessionStore((s) => s.updateConfig);
  const addSubagent = useSessionStore((s) => s.addSubagent);
  const updateSubagent = useSessionStore((s) => s.updateSubagent);
  const addCommandHistory = useSessionStore((s) => s.addCommandHistory);
  const updateProcessHealth = useSessionStore((s) => s.updateProcessHealth);

  // useState for values that TerminalPanel reacts to
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
  const [userPrompt, setUserPrompt] = useState<string | null>(null);

  const stateRef = useRef<SessionState>("starting");
  const metaAccRef = useRef<TapMetadataAccumulator | null>(null);
  const subTrackerRef = useRef<TapSubagentTracker | null>(null);
  const healthCountRef = useRef(0);
  const lastHighMemWarnRef = useRef(0);
  const apiIpResolveHostRef = useRef<string | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    if (!sessionId) return;

    // Create per-session instances
    const initialSession = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
    const sessionCli = initialSession?.config.cli ?? "claude";
    const metaAcc = new TapMetadataAccumulator(sessionCli);
    const subTracker = new TapSubagentTracker(sessionId);
    metaAccRef.current = metaAcc;
    subTrackerRef.current = subTracker;
    stateRef.current = "starting";
    const activityTracker = createTapActivityTracker(sessionId);
    const worktreeSync = createTapWorktreeSync(sessionId, updateConfig);
    const codexNaming = createTapCodexNaming(sessionId);
    setClaudeSessionId(null);
    setUserPrompt(null);
    apiIpResolveHostRef.current = null;

    const handleEvent = (event: TapEvent) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      traceSync("tap.handle_event", () => {

      useSessionStore.getState().addSeenEventKind(event.kind);

      if (!getNoisyEventKinds(sessionCli).has(event.kind)) {
        const cat = event.cat || "?";
        const categoryLabel = getTapCategoryLabel(cat);
        dlog("tap", sid, `[${categoryLabel}] ${event.kind}${eventDetail(event)}`, "DEBUG", {
          event: "tap.classified_event",
          data: {
            category: categoryLabel,
            hookSource: getTapCategoryMeta(cat).hookSource,
            kind: event.kind,
          },
        });
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
        const transitionData = stateTransitionData(prevState, newState, event);
        const ambiguousSubagentState = subTracker.isSidechainActive() || subTracker.hasActiveAgents();
        if (shouldSuppressParentStateTransition(event, ambiguousSubagentState)) {
          dlog("inspector", sid, `suppressed ${prevState} → ${newState} (subagent context active, event=${event.kind})`, "DEBUG", {
            ...transitionData,
            data: {
              ...transitionData.data,
              ambiguousSubagentState,
              suppressReason: "active-subagent-ambiguous-event",
            },
          });
        } else {
          dlog("inspector", sid, `state ${prevState} → ${newState} (${event.kind})`, "LOG", transitionData);
          stateRef.current = newState;
          updateState(sid, newState);
        }
      } else if (!getNoisyEventKinds(sessionCli).has(event.kind)) {
        dlog("inspector", sid, `state ${prevState} unchanged by ${event.kind}`, "DEBUG");
      }

      // Read originalCwd BEFORE accumulator clears worktreeInfo.
      const worktreeExitCwd = worktreeSync.captureWorktreeExitCwd(event);
      const suppressSubagentWorktreeEvent =
        worktreeSync.shouldSuppressSubagentWorktreeEvent(event, subTracker);

      // 2. Metadata accumulator
      const metaDiff = suppressSubagentWorktreeEvent ? null : metaAcc.process(event);
      if (suppressSubagentWorktreeEvent) {
        dlog("tap", sid, `${event.kind} suppressed — subagent in flight`, "DEBUG");
      }
      if (metaDiff) {
        updateMetadata(sid, metaDiff);
      }

      if (event.kind === "ApiFetch") {
        const apiHost = apiHostForFetch(event.url, sessionCli);
        if (apiHost && apiHost !== apiIpResolveHostRef.current) {
          apiIpResolveHostRef.current = apiHost;
          updateMetadata(sid, { apiHost, apiIp: null });
          invoke<string>("resolve_api_host", { host: apiHost })
            .then((apiIp) => {
              if (apiIpResolveHostRef.current === apiHost) {
                updateMetadata(sid, { apiHost, apiIp });
              }
            })
            .catch((err: unknown) => {
              if (apiIpResolveHostRef.current === apiHost) {
                apiIpResolveHostRef.current = null;
              }
              dlog("session", sid, `API IP resolve failed for ${apiHost}: ${err}`, "WARN");
            });
        }
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
        if (action.type === "add" && action.subagent) {
          dlog("inspector", sid, `subagent discovered id=${action.subagent.id} desc="${action.subagent.description}"`, "DEBUG");
          addSubagent(sid, action.subagent);
        } else if (action.type === "update" && action.subagentId && action.updates) {
          updateSubagent(sid, action.subagentId, action.updates);
        }
      }

      // 4. Activity tracking — file changes, skills, and context files.
      activityTracker.handleEvent(event, subTracker);

      // 6. Session-level signals
      // [SS-01] [SS-02] Detect session switches via sid field change (plan-mode fork, /resume, compaction)
      // Gate behind isSubagentInFlight: subagent session init records arrive through TAP
      // before the first sidechain ConversationMessage, so sidechainActive alone is insufficient.
      if (event.kind === "SessionRegistration") {
        if (!subTracker.isSubagentInFlight()) {
          setClaudeSessionId(event.sessionId);
          codexNaming.persistSessionRegistrationName(event.sessionId);
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

      // [AS-01] markUserMessage on UserInput/SlashCommand (not TurnStart) — response window starts at real user input
      if (event.kind === "UserInput" || event.kind === "SlashCommand") {
        const acceptedPrompt = activityTracker.markUserMessage(event.display);
        if (acceptedPrompt) {
          setUserPrompt(event.display.slice(0, 200));
        }
        if (event.kind === "UserInput" && acceptedPrompt) {
          codexNaming.handleUserInput(event.display);
        }
      }

      if (event.kind === "SlashCommand") {
        addCommandHistory(sid, event.command, event.ts);
        useSettingsStore.getState().recordCommandUsage(event.command);
      }

      // SystemPromptCapture → collect all unique observed prompts
      if (event.kind === "SystemPromptCapture") {
        handleTapPromptCaptureBridge(sid, event);
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
      if (event.kind === "CodexTurnContext" && event.effort) {
        updateConfig(sid, { effort: event.effort });
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

      worktreeSync.handleEvent(
        event,
        subTracker,
        worktreeExitCwd,
        suppressSubagentWorktreeEvent,
      );

      }, {
        module: "tap",
        sessionId: sid,
        event: "tap.handle_event",
        warnAboveMs: 12,
        data: {
          kind: event.kind,
          category: event.cat ?? null,
        },
      });
    };

    const unsub = tapEventBus.subscribe(sessionId, handleEvent);

    const unsubSettledIdle = subscribeTapSettledIdleHandler(sessionId, activityTracker.endTurn);

    return () => {
      unsub();
      unsubSettledIdle();
      metaAcc.reset();
      subTracker.reset();
      metaAccRef.current = null;
      subTrackerRef.current = null;
    };
  }, [sessionId, updateState, updateMetadata, updateConfig, addSubagent, updateSubagent, addCommandHistory, updateProcessHealth]);

  return { claudeSessionId, userPrompt };
}

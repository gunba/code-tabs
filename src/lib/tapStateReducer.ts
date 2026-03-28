import type { TapEvent } from "../types/tapEvents";
import type { SessionState } from "../types/session";
import { isSessionIdle } from "../types/session";

/** Plan content markers: detect numbered list items "1. " and "2. " in assistant text. */
const PLAN_ITEM_1 = /\b1\.\s/;
const PLAN_ITEM_2 = /\b2\.\s/;

/**
 * Pure state reducer: (state, event) → state.
 * Replaces deriveStateFromPoll() in useInspectorState.ts.
 * No polling, no terminal buffer fallback — event-driven only.
 */
export function reduceTapEvent(state: SessionState, event: TapEvent): SessionState {
  switch (event.kind) {
    case "TurnStart":
      return "thinking";

    case "ThinkingStart":
      return "thinking";

    case "TextStart":
      return "thinking"; // still streaming

    case "ToolCallStart":
      // Still streaming tool input — stay in thinking until turn ends
      if (event.toolName === "ExitPlanMode") return "actionNeeded";
      return "thinking";

    case "TurnEnd":
      if (event.stopReason === "tool_use") {
        // ExitPlanMode sets actionNeeded; the structural TurnEnd(tool_use) must not clobber it
        return state === "actionNeeded" ? "actionNeeded" : "toolUse";
      }
      if (event.stopReason === "end_turn") return "idle";
      return state;

    case "MessageStop":
      // Confirms message is done; state already set by TurnEnd
      return state;

    case "PermissionPromptShown":
      return "waitingPermission";

    case "PermissionApproved":
      return "toolUse";

    case "PermissionRejected":
      return "idle";

    case "UserInterruption":
      return "interrupted";

    case "UserInput":
    case "SlashCommand":
      return "thinking"; // submission detected, API call imminent

    case "ConversationMessage":
      if (event.messageType === "user" && !event.isSidechain) {
        return "thinking";
      }
      if (event.messageType === "assistant") {
        // ExitPlanMode tool detection
        if (event.toolNames.includes("ExitPlanMode")) return "actionNeeded";
        // Content-based plan detection: numbered list (1. + 2.) in the agent's
        // message text with a tool_use stop reason. Mirrors the old terminal
        // buffer scan for "> 1." but reads directly from the TAP message.
        if (event.stopReason === "tool_use" && event.textSnippet &&
            PLAN_ITEM_1.test(event.textSnippet) && PLAN_ITEM_2.test(event.textSnippet)) {
          return "actionNeeded";
        }
        // Preserve actionNeeded set by ToolCallStart(ExitPlanMode) — the
        // ConversationMessage arrives later and must not clobber it.
        if (state === "actionNeeded") return "actionNeeded";
        if (event.stopReason === "tool_use") return "toolUse";
        if (event.stopReason === "end_turn") return "idle";
      }
      return state;

    case "SubagentNotification":
      // Subagent completion/kill doesn't change parent state
      return state;

    // Informational events — no state change
    case "BlockStop":
    case "ApiTelemetry":
    case "SubagentSpawn":
    case "ModeChange":
    case "SessionRegistration":
    case "CustomTitle":
    case "ProcessHealth":
    case "RateLimit":
    case "HookProgress":
    case "ToolInput":
    case "SessionResume":
    case "ApiFetch":
    case "SubprocessSpawn":
    case "ApiRequestInfo":
    case "AccountInfo":
    case "FileHistorySnapshot":
    case "TurnDuration":
    case "ApiStreamError":
    case "ToolResult":
    case "ApiError":
    case "ApiRetry":
    case "StreamStall":
    case "LinesChanged":
    case "ContextBudget":
    case "SubagentLifecycle":
    case "PlanModeEvent":
    case "WorktreeState":
    case "WorktreeCleared":
    case "HookTelemetry":
    case "SystemPromptCapture":
    case "EffortLevel":
      return state;
  }
}

/**
 * Batch reducer: fold multiple events, applying priority rules.
 * waitingPermission always wins if any event in the batch triggers it.
 */
export function reduceTapBatch(state: SessionState, events: TapEvent[]): SessionState {
  let result = state;
  let hasPermission = false;

  for (const event of events) {
    result = reduceTapEvent(result, event);
    if (result === "waitingPermission") hasPermission = true;
  }

  // waitingPermission takes priority over any subsequent state in the same batch
  if (hasPermission && !isSessionIdle(result)) return "waitingPermission";

  return result;
}

/**
 * Check if an event represents a genuine completion (transition to idle).
 * Used by useTapEventProcessor for queued input dispatch signaling.
 */
export function isCompletionEvent(event: TapEvent): boolean {
  return event.kind === "TurnEnd" && event.stopReason === "end_turn";
}

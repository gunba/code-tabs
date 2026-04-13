---
paths:
  - "src/lib/tapMetadataAccumulator.ts"
---

# src/lib/tapMetadataAccumulator.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Session Resume

- [SR-02 L7] Token/cost counters show only NEW conversation usage (inspector starts accumulating from connection time)

## State Metadata

- [SI-07 L5] Tool actions, user prompts, assistant text, subagent descriptions captured inline via tapMetadataAccumulator processing ToolInput, ConversationMessage, and UserInput events.
- [IN-11 L6] apiLatencyMs is updated by both ApiFetch events (from fetch round-trip duration) and HttpPing events (dedicated ping TAP); HttpPing takes precedence when available as a cleaner measurement.
- [IN-14 L106] Model bleed fix: ApiTelemetry only updates runtimeModel when queryDepth===0, preventing subagent model (e.g. Haiku) from overwriting parent tab display. Subagent model tracked separately via tapSubagentTracker update action on ApiTelemetry with queryDepth>0.
- [SI-06 L145] `choiceHint` detection: ToolCallStart event with toolName=AskUserQuestion sets choiceHint in tapMetadataAccumulator. Clears on UserInput, SlashCommand, TurnEnd(end_turn), PermissionApproved, PermissionRejected, or ToolResult(AskUserQuestion). No terminal buffer scanning.
- [IN-09 L146] choiceHint detection via ToolCallStart event with toolName=AskUserQuestion in tapMetadataAccumulator.ts. Full question schema available from ToolInput event.
- [IN-27 L235] Unified rate limit display: tapMetadataAccumulator extracts anthropic-ratelimit-unified-5h-utilization, 5h-reset, 7d-utilization, 7d-reset from ApiFetch headers. Stored as fiveHourPercent (0-100), fiveHourResetsAt, sevenDayPercent, sevenDayResetsAt on SessionMetadata. StatusBar shows 5h/7d usage percentages with time-until-reset, falling back to statusLine data when API headers unavailable.
- [IN-28 L245] Ping/RTT decomposition: tapMetadataAccumulator decomposes ApiFetch duration into network RTT (dur minus x-envoy-upstream-service-time) and server processing time (raw x-envoy-upstream-service-time header). Both EMA-smoothed (alpha=0.3). For requests without the header, total dur used as RTT estimate. StatusBar shows both as separate indicators: XXms (RTT) and srv:XXXms (server).
- [IN-19 L402] System prompt capture: INSTALL_TAPS intercepts API request body and pushes 'system-prompt' category with text, model, msgCount, and blocks array. tapClassifier emits SystemPromptCapture event (maps wire cc to cacheControl). tapMetadataAccumulator stores capturedSystemPrompt (string) and capturedSystemBlocks (SystemPromptBlock[]) on SessionMetadata; blocks excluded from fingerprint to avoid serialization cost, tracked via blocksChanged flag. Both reset on respawn. StatusBar shows 'Context' button when capturedSystemPrompt is truthy; opens ContextViewer modal.
- [SI-25 L421] Status line data capture: INSTALL_TAPS stringify hook matches the serialized status payload shape (session_id + cost.total_cost_usd + context_window.total_input_tokens) and pushes flattened fields to dedicated 'status-line' category. tapClassifier classifies as StatusLineUpdate event. tapMetadataAccumulator stores a grouped nullable statusLine snapshot on SessionMetadata (22 fields, including cumulative input/output tokens and total cost). tapStateReducer treats this as informational (no state change). App tab metadata uses current-turn statusLine context when present and falls back to contextDebug; StatusBar token displays prefer statusLine totals and otherwise fall back to session metadata totals.

## Inspector Tap Pipeline

- [IN-25 L92] Sidechain metadata gating: tapMetadataAccumulator gates all transient metadata (currentEventKind, currentToolName, currentAction, activeSubprocess, hookStatus, lastToolDurationMs, linesAdded/Removed, stallCount, apiErrorStatus, apiRetryCount) behind sidechainActive flag. Prevents subagent events from polluting parent session status bar and tab activity display. sidechainActive set by ConversationMessage.isSidechain, checked at top of process() and in each gated case.
- [IN-18 L268] HttpPing event (cat=ping from Rust backend) sets apiLatencyMs; ApiFetch events also update apiLatencyMs from their round-trip duration, but HttpPing overrides with a cleaner dedicated measurement when available.

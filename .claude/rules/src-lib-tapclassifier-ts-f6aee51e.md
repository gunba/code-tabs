---
paths:
  - "src/lib/tapClassifier.ts"
---

# src/lib/tapClassifier.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## State Metadata

- [SI-25 L681] Status line data capture: INSTALL_TAPS stringify hook matches the serialized status payload shape (session_id + cost.total_cost_usd + context_window.total_input_tokens) and pushes flattened fields to dedicated 'status-line' category. tapClassifier classifies as StatusLineUpdate event. tapMetadataAccumulator stores a grouped nullable statusLine snapshot on SessionMetadata (22 fields, including cumulative input/output tokens and total cost). tapStateReducer treats this as informational (no state change). App tab metadata uses current-turn statusLine context when present and falls back to contextDebug; StatusBar token displays prefer statusLine totals and otherwise fall back to session metadata totals.
- [IN-19 L774] System prompt capture: INSTALL_TAPS intercepts API request body and pushes 'system-prompt' category with text, model, msgCount, and blocks array. tapClassifier emits SystemPromptCapture event (maps wire cc to cacheControl). tapMetadataAccumulator stores capturedSystemPrompt (string) and capturedSystemBlocks (SystemPromptBlock[]) on SessionMetadata; blocks excluded from fingerprint to avoid serialization cost, tracked via blocksChanged flag. Both reset on respawn. StatusBar shows 'Context' button when capturedSystemPrompt is truthy; opens ContextViewer modal.

## Inspector Tap Pipeline

- [IN-10 L200,714] Tap event pipeline: raw entries arrive via TCP socket (TAP_PORT), tapClassifier.ts classifies raw TapEntry values into typed TapEvent objects, tapEventBus.ts dispatches per-session, and reducers/accumulators push store updates. tapClassifier maps normalized cat+op families to ConsoleOutput, SyncFileOp, TimerOp, BunOp, WebSocketOp, and StreamOp, then copies the original entry.cat onto the returned event. classifyStringify() detects PermissionPromptShown via 4 paths: (1) setMode array (Write/Edit permission prompt), (2) addRules array (Bash permission prompt, extracts toolName from rules[0].toolName), (3) tengu_tool_use_show_permission_request telemetry shape, (4) notification_type=permission_prompt. Downstream consumers split responsibilities: tapStateReducer derives session state, tapMetadataAccumulator enriches metadata, and tapSubagentTracker maintains subagent lifecycle data.
  - tapClassifier maps normalized cat+op families to ConsoleOutput, SyncFileOp, TimerOp, BunOp, WebSocketOp, and StreamOp, then copies the original entry.cat onto the returned event.
  - Downstream consumers split responsibilities: tapStateReducer derives session state, tapMetadataAccumulator enriches metadata, and tapSubagentTracker maintains subagent lifecycle data.
- [IN-17 L350] SkillInvocation event: classifier detects user-type messages with toolUseResult.commandName and returns SkillInvocation kind (skill name, success, allowedTools). Early-return before UserInterruption/PermissionRejected checks prevents misclassification. useTapEventProcessor stores invocations via addSkillInvocation store action.
- [IN-15 L470] AccountInfo classifier fix: guard relaxed from requiring subscriptionType to requiring only billingType (newer CLI omits subscriptionType). subscriptionType extracted with fallback to null.
- [IN-30 L546] Subagent completion capture preserves prompt/result metadata for retained UI: tapClassifier keeps SubagentSpawn.prompt as promptText, tapSubagentTracker stores completed summaries as resultText, and clean completion events set completed=true for retained subagent cards/inspector. TurnEnd(end_turn) transitions active agents to idle, while SubagentNotification and SubagentLifecycle completion events mark non-dead agents dead and clear transient tool state. Completion relies on explicit subagent signals rather than a sidechain-exit fallback.
- [IN-18 L755] HttpPing event (cat=ping from Rust backend) sets apiLatencyMs; ApiFetch events also update apiLatencyMs from their round-trip duration, but HttpPing overrides with a cleaner dedicated measurement when available.

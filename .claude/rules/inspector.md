---
paths:
  - "src/lib/inspectorHooks.ts"
  - "src/lib/inspectorPort.ts"
  - "src/hooks/useInspectorConnection.ts"
  - "src/lib/tapClassifier.ts"
  - "src/lib/tapSubagentTracker.ts"
  - "src/components/SubagentInspector/**"
---

# Inspector

<!-- Codes: IN=Inspector -->

- [IN-01] Inspector port allocation and registry in `inspectorPort.ts`. Async `allocateInspectorPort()` probes OS via `check_port_available` IPC (Rust TcpListener::bind) and skips registry-held ports.
- [IN-02] INSTALL_TAPS JS expression in inspectorHooks.ts; wraps 15 function categories (parse, stringify, console, fs, spawn, fetch, exit, timer, stdout, stderr, require, bun, websocket, net, stream). TCP push-based delivery via Bun.connect to TAP_PORT. parse and stringify always on for state detection; other categories opt-in via flags. Status-line detection: stringify wrapper checks hook_event_name==='Status' and pushes flattened fields to dedicated 'status-line' category (bypasses 2000-char snap truncation). Also contains WebFetch domain bypass, HTTPS/fetch timeout patches, and wrapAfter() helper for post-call hooks.
- [IN-03] Subagent tracking: inspector detects Agent tool_use -> queues description -> matches with new session ID system event -> routes events to subagent entry
- [IN-04] Subagent conversation messages captured via tapSubagentTracker.ts processing ConversationMessage events with isSidechain:true and agentId routing. Tool message text strips tool name prefix (e.g. 'Read: path' -> 'path') since the blue toolName label renders it separately in SubagentInspector. Token + cost attribution via lastActiveAgent tracking + queryDepth>0 from ApiTelemetry. SubagentLifecycle events enrich with agentType, isAsync, model, totalToolUses, durationMs. SubagentNotification marks ALL active subagents idle/dead (no break). Model tracked from ApiTelemetry queryDepth>0. Late sidechain ConversationMessage events are gated: if the agent's current state in agentStates is already idle/dead (checked via isSubagentActive), the event is ignored to prevent re-activating completed agents and incorrectly suppressing main-agent SSE events.
  - Files: src/lib/tapSubagentTracker.ts
- [IN-05] Stale subagent detection removed -- push-based architecture handles subagent lifecycle via real-time state events only
  - Files: src/lib/tapSubagentTracker.ts
- [IN-06] Dead subagent purge removed -- push-based architecture relies on real-time state transitions; idle subs remain visible until session ends
  - Files: src/lib/tapSubagentTracker.ts
- [IN-07] Inspector port allocator verifies each candidate port is free via `check_port_available` IPC (Rust TcpListener::bind on 127.0.0.1). Skips ports already in the registry. Throws if all 100 ports (6400-6499) are exhausted.
  - Files: src/lib/inspectorPort.ts, src-tauri/src/commands.rs
- [IN-08] SubagentInspector tool block collapse: MessageBlock wrapped in React.memo to prevent re-rendering unchanged messages (ReactMarkdown is expensive). Uses local useState for collapsed state; getToolPreview extracts first non-empty line (120 char cap). Parent computes lastToolIndex via reduce; only the last tool message auto-expands when subagent is active (not dead/idle). React key={i} ensures stable mounting. Header shows message count diagnostic.
  - Files: src/components/SubagentInspector/SubagentInspector.tsx, src/components/SubagentInspector/SubagentInspector.tsx
- [IN-09] choiceHint detection via ToolCallStart event with toolName=AskUserQuestion in tapMetadataAccumulator.ts. Full question schema available from ToolInput event.
- [IN-10] Tap event pipeline: raw entries arrive via TCP socket (TAP_PORT) -> tapClassifier.ts classifies ~47 typed events (31 original + 16 expansion: ApiStreamError, ToolResult, ApiError, ApiRetry, StreamStall, LinesChanged, ContextBudget, SubagentLifecycle, PlanModeEvent, WorktreeState, WorktreeCleared, HookTelemetry, SystemPromptCapture, EffortLevel, IdlePrompt, StatusLineUpdate) -> tapEventBus.ts dispatches per-session -> tapStateReducer.ts (state), tapMetadataAccumulator.ts (metadata), tapSubagentTracker.ts (subagents) -> store actions. IdlePrompt is classified from notification_type=idle_prompt stringify events. StatusLineUpdate classified from status-line category entries, carries CLI version, rate limits, context usage, vim mode, and other runtime status fields.
  - Files: src/lib/tapClassifier.ts, src/hooks/useTapPipeline.ts, src/types/tapEvents.ts
- [IN-11] StatusBar enrichment from tap events: model + subscription tier + API region (from cf-ray) + Cloudflare edge IP (from resolve_api_host IPC) + API latency (ApiFetch.durationMs time-to-headers, distinct from TTFT), rate limit display, hook execution status, active subprocess indicator, memory in duration tooltip, lines changed (+/-), API retry count, stream stall indicator (yellow pulse), tool duration (ms), and dynamic status text (hookStatus/subprocess) positioned last with flex-fill. StatusLineUpdate event provides authoritative CLI version, rate limit percentages (5h/7d), context window usage, vim mode — available via session.metadata.statusLine for future StatusBar enhancements.
  - Files: src/components/StatusBar/StatusBar.tsx, src/lib/tapMetadataAccumulator.ts, src/hooks/useTapEventProcessor.ts, src/store/settings.ts
- [IN-12] useInspectorConnection.ts: WebSocket lifecycle only (connect, Runtime.evaluate for hook injection, retry, disconnect). No state derivation. useTapPipeline.ts: receives `tap-entry-{sessionId}` Tauri events from Rust TCP tap server, classifies, dispatches to bus, buffers for disk. useTapEventProcessor.ts: subscribes to bus, runs reducers, calls store actions.
  - Files: src/hooks/useInspectorConnection.ts, src/hooks/useTapPipeline.ts, src/hooks/useTapEventProcessor.ts
- [IN-13] SessionState 'interrupted' added: UserInterruption transitions to interrupted (not idle). Visually distinct (red dot, no pulse) but functionally equivalent to idle via isSessionIdle() helper. Auto-clears to thinking on next UserInput/ConversationMessage. clearIdleSubagents also clears interrupted.
  - Files: src/types/session.ts, src/lib/tapStateReducer.ts, src/store/sessions.ts
- [IN-14] Model bleed fix: ApiTelemetry only updates runtimeModel when queryDepth===0, preventing subagent model (e.g. Haiku) from overwriting parent tab display. Subagent model tracked separately via tapSubagentTracker update action on ApiTelemetry with queryDepth>0.
  - Files: src/lib/tapMetadataAccumulator.ts, src/lib/tapSubagentTracker.ts
- [IN-15] AccountInfo classifier fix: guard relaxed from requiring subscriptionType to requiring only billingType (newer CLI omits subscriptionType). subscriptionType extracted with fallback to null.
  - Files: src/lib/tapClassifier.ts
- [IN-16] Subagent costUsd tracking: TapSubagentTracker accumulates costUSD from ApiTelemetry events (queryDepth > 0) into per-agent subagentCost Map. Pushed to store alongside tokenCount. Subagent type extended with optional costUsd field.
  - Files: src/lib/tapSubagentTracker.ts, src/types/session.ts

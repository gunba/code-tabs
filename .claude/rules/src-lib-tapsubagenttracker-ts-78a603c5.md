---
paths:
  - "src/lib/tapSubagentTracker.ts"
---

# src/lib/tapSubagentTracker.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Session Resume

- [SR-05 L17] Nested subagents supported via agentId-based routing (each event tagged with agentId, parentSessionId tracked per subagent)

## Inspector Tap Pipeline

- [SI-09 L14] Subagent descriptions, state, tokens, actions, and messages all captured via inspector tap events (no JSONL subagent watcher). No JSONL file watching for state -- Rust JSONL utilities kept only for `session_has_conversation` and `list_past_sessions`.
- [IN-03 L15,183] Subagent tracking: inspector detects Agent tool_use -> queues spawn data (description, prompt, subagentType, model) in pendingSpawns -> first sidechain ConversationMessage with new agentId creates subagent entry, pops spawn. Spawn dedup via seenSpawnFingerprints Set prevents re-queuing when CLI re-serializes the same Agent input 2-3x. Routing is direct via agentId field on events. CLI-internal aside_question* sidechains are ignored before subagent creation so they do not consume pendingSpawns or surface phantom agents. pendingSpawns is drained (cleared) on UserInterruption, UserInput, and SlashCommand events to prevent stale queued descriptions from keeping isSubagentInFlight() true after an interruption or new user prompt.
- [IN-06 L16] Dead subagent purge removed -- push-based architecture relies on real-time state transitions; idle subs remain visible until session ends
- [IN-04 L168] Subagent conversation messages captured via tapSubagentTracker.ts processing ConversationMessage events with isSidechain:true and agentId routing. UUID-based dedup via processedUuids Set prevents re-processing re-serialized duplicate messages (CLI emits same message 2-3x). Tool message text strips tool name prefix (e.g. 'Read: path' -> 'path') since the blue toolName label renders it separately in SubagentInspector. No message count cap (200-message cap removed). No text truncation on textSnippet (300-char slice removed). ToolInput events enrich the last tool message with structured toolInput data via a new object reference (so React.memo detects the change). Token + cost attribution via lastActiveAgent tracking + queryDepth>0 from ApiTelemetry. SubagentLifecycle events enrich with agentType, isAsync, model, totalToolUses, durationMs. SubagentNotification marks ALL active subagents dead (no break). Late sidechain ConversationMessage events gated: if agent state is already idle/dead (checked via isSubagentActive), event is ignored. Tool result snippets extracted from user messages with tool_result blocks into toolResultSnippets field (populated by tapClassifier), then appended as role=tool messages with toolName='result'.
- [IN-16 L302] Subagent costUsd tracking: TapSubagentTracker accumulates costUSD from ApiTelemetry events (queryDepth > 0) into per-agent subagentCost Map. Pushed to store alongside tokenCount. Subagent type extended with optional costUsd field.
- [IN-30 L317] Subagent completion capture preserves prompt/result metadata for retained UI: tapClassifier keeps SubagentSpawn.prompt as promptText, tapSubagentTracker stores completed summaries as resultText, and clean completion events set completed=true for retained subagent cards/inspector. TurnEnd(end_turn) transitions active agents to idle, while SubagentNotification and SubagentLifecycle completion events mark non-dead agents dead and clear transient tool state. Completion relies on explicit subagent signals rather than a sidechain-exit fallback.
- [IN-26 L430,476] Subagent tool event routing: tapSubagentTracker routes ToolCallStart, ToolInput, and TurnEnd events to the active subagent when sidechainActive is true. ToolCallStart updates currentToolName and currentEventKind. ToolInput updates currentAction and also enriches the last tool message with structured toolInput data (new object reference for React.memo). TurnEnd(end_turn) transitions the agent state to 'idle' and clears currentToolName/currentAction/currentEventKind. Non-noisy event kinds also routed to active subagent in default case. Active-state guard (isSubagentActive) prevents routing to dead/idle subagents.

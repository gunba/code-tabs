---
paths:
  - "src/hooks/useTapEventProcessor.ts"
---

# src/hooks/useTapEventProcessor.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Session Switch

- [SS-01 L241] Inspector detects session switches (plan-mode fork, /resume, compaction) via SessionRegistration event carrying the new sessionId. The useTapEventProcessor compares incoming sessionId against current and fires handleSessionSwitch when they differ.
- [SS-02 L241] Same Bun process, same WebSocket — inspector automatically tracks the new session

## Activity Store Semantics

- [AS-01 L262] markUserMessage() is called by useTapEventProcessor on UserInput and SlashCommand tap events (not on TurnStart). This ensures the Response-mode activity window starts at the actual user input moment, not at the synthetic TurnStart which may fire from subagent turns or internal re-starts that do not represent a real user message.

## State Metadata

- [IN-34 L188] TurnStart subagent model gate: tapMetadataAccumulator gates runtimeModel updates on TurnStart (message_start) by !sidechainActive && !subagentInFlight. The subagentInFlight signal is latched from tapSubagentTracker.isSubagentInFlight() (covers pendingSpawns + sidechainActive + hasActiveAgents) via setSubagentInFlight(flag) called from useTapEventProcessor immediately before metaAcc.process(event). useTapEventProcessor runs subTracker.process(event) BEFORE metaAcc.process(event) so the in-flight signal reflects the current event. Closes the race where a subagent's SSE message_start arrives before the JSONL transcript persists the first sidechain ConversationMessage that would set sidechainActive — the prior single-flag gate let the subagent's Haiku model briefly overwrite the parent's Opus model (Opus->Haiku->Opus). IN-14 gates ApiTelemetry runtimeModel via queryDepth===0; this gate is the parallel mechanism for TurnStart. The cache/turn-token side of the TurnStart case (lastCacheRead/lastTurnInputTokens/lastCacheCreation/hookStatus reset) is still gated only on !sidechainActive — out of scope for this fix.
  - Definitions: src/lib/tapMetadataAccumulator.ts:L107-L110 (private subagentInFlight = false), L139-L141 (setSubagentInFlight(flag) setter), L177-L179 (TurnStart model gate), L729 (reset). Wiring: src/hooks/useTapEventProcessor.ts:L173-L185 (subTracker.process before metaAcc), L188 (metaAcc.setSubagentInFlight(subTracker.isSubagentInFlight())), L189 (metaAcc.process). Test: src/lib/__tests__/subagentAwareness.test.ts 'subagent TurnStart before sidechain ConversationMessage does not overwrite (uses subagentInFlight gate)'.

## State Tap Reducer

- [SI-13 L66] tapStateReducer event priority: actionNeeded is a sticky state preserved by an early-return guard at the top of reduceTapEvent -- only UserInput, SlashCommand, UserInterruption, PermissionPromptShown, ConversationMessage(user, non-sidechain), IdlePrompt, and ToolResult(AskUserQuestion/ExitPlanMode) or TurnStart can clear it. ExitPlanMode tool call -> actionNeeded; PermissionPromptShown -> waitingPermission (always wins via reduceTapBatch); UserInterruption -> interrupted; TurnEnd(end_turn) -> idle; TurnEnd(tool_use) -> toolUse; IdlePrompt -> idle (authoritative).
- [SI-20 L67] Worktree cwd detection: when tap events (ConversationMessage, SessionRegistration, WorktreeState) carry a cwd or worktreePath, useTapEventProcessor updates the session's workingDir via updateConfig. WorktreeCleared restores originalCwd. Fires only on change (normalizePath comparison). SessionRegistration cwd updates are gated behind !subTracker.isSubagentInFlight() to prevent subagent session-init events from overwriting the parent session's cwd during the SubagentSpawn-to-first-sidechain-message window.
- [SI-23 L68] Plan detection relies solely on `ToolCallStart(ExitPlanMode)` -> `actionNeeded`. ToolCallStart fires during the SSE stream, structurally before any UserInput can arrive. actionNeeded is sticky: only UserInput, SlashCommand, UserInterruption, PermissionPromptShown, ToolResult(AskUserQuestion/ExitPlanMode), or TurnStart can clear it.

## Session Launcher

- [SL-18 L253] Custom title always persists: userRenamed guard removed — Claude's CustomTitle TAP event now always persists the name to both session store and settings store sessionNames map, regardless of prior user rename.

## Terminal UI

- [TA-02 L219] Global tool name tracking: seenToolNames Set in sessions store collects unique tool names across all sessions via addSeenToolName() action. Fed by ToolCallStart events in useTapEventProcessor. Immutable Set pattern for reactivity (early return when name already present).

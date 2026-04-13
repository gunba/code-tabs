---
paths:
  - "src/hooks/useTapEventProcessor.ts"
---

# src/hooks/useTapEventProcessor.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Session Launcher

- [SL-18 L401] Custom title always persists: userRenamed guard removed — Claude's CustomTitle TAP event now always persists the name to both session store and settings store sessionNames map, regardless of prior user rename.

## Session Switch

- [SS-01 L390] Inspector detects session switches (plan-mode fork, /resume, compaction) via SessionRegistration event carrying the new sessionId. The useTapEventProcessor compares incoming sessionId against current and fires handleSessionSwitch when they differ.
- [SS-02 L390] Same Bun process, same WebSocket — inspector automatically tracks the new session

## Activity Store Semantics

- [AS-01 L410] markUserMessage() is called by useTapEventProcessor on UserInput and SlashCommand tap events (not on TurnStart). This ensures the Response-mode activity window starts at the actual user input moment, not at the synthetic TurnStart which may fire from subagent turns or internal re-starts that do not represent a real user message.

## State Tap Reducer

- [SI-13 L51] tapStateReducer event priority: actionNeeded is a sticky state preserved by an early-return guard at the top of reduceTapEvent -- only UserInput, SlashCommand, UserInterruption, PermissionPromptShown, ConversationMessage(user, non-sidechain), IdlePrompt, and ToolResult(AskUserQuestion/ExitPlanMode) or TurnStart can clear it. ExitPlanMode tool call -> actionNeeded; PermissionPromptShown -> waitingPermission (always wins via reduceTapBatch); UserInterruption -> interrupted; TurnEnd(end_turn) -> idle; TurnEnd(tool_use) -> toolUse; IdlePrompt -> idle (authoritative).
- [SI-20 L52,508] Worktree cwd detection: when tap events (ConversationMessage, SessionRegistration, WorktreeState) carry a cwd or worktreePath, useTapEventProcessor updates the session's workingDir via updateConfig. WorktreeCleared restores originalCwd. Fires only on change (normalizePath comparison). SessionRegistration cwd updates are gated behind !subTracker.isSubagentInFlight() to prevent subagent session-init events from overwriting the parent session's cwd during the SubagentSpawn-to-first-sidechain-message window.
- [SI-23 L53] Plan detection relies solely on `ToolCallStart(ExitPlanMode)` -> `actionNeeded`. ToolCallStart fires during the SSE stream, structurally before any UserInput can arrive. actionNeeded is sticky: only UserInput, SlashCommand, UserInterruption, PermissionPromptShown, ToolResult(AskUserQuestion/ExitPlanMode), or TurnStart can clear it.

## Terminal UI

- [TA-02 L165] Global tool name tracking: seenToolNames Set in sessions store collects unique tool names across all sessions via addSeenToolName() action. Fed by ToolCallStart events in useTapEventProcessor. Immutable Set pattern for reactivity (early return when name already present).

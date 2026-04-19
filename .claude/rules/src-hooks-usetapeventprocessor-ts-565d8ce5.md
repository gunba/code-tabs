---
paths:
  - "src/hooks/useTapEventProcessor.ts"
---

# src/hooks/useTapEventProcessor.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Session Switch

- [SS-01 L455] Inspector detects session switches (plan-mode fork, /resume, compaction) via SessionRegistration event carrying the new sessionId. The useTapEventProcessor compares incoming sessionId against current and fires handleSessionSwitch when they differ.
- [SS-02 L455] Same Bun process, same WebSocket — inspector automatically tracks the new session

## Activity Store Semantics

- [AS-01 L475] markUserMessage() is called by useTapEventProcessor on UserInput and SlashCommand tap events (not on TurnStart). This ensures the Response-mode activity window starts at the actual user input moment, not at the synthetic TurnStart which may fire from subagent turns or internal re-starts that do not represent a real user message.
- [AS-03 L622] Settled-idle endTurn: useTapEventProcessor subscribes to settledStateManager; on settled-idle it calls endTurn(sessionId) to close the current activity turn and trigger stats recomputation. Immediately after, it calls runGitScanAndValidate(sessionId) which: (1) runs git_list_changes for the session workingDir (gated by isGitRepo cache) and adds any changed paths not already in visitedPaths as external file-activity entries; (2) calls paths_exist on all activity paths and calls confirmEntries to drop false-positive entries (e.g. rm'd files still showing as created). settledStateManager subscription at useTapEventProcessor.ts:L627.
  - src/hooks/useTapEventProcessor.ts:L538

## State Tap Reducer

- [SI-13 L114] tapStateReducer event priority: actionNeeded is a sticky state preserved by an early-return guard at the top of reduceTapEvent -- only UserInput, SlashCommand, UserInterruption, PermissionPromptShown, ConversationMessage(user, non-sidechain), IdlePrompt, and ToolResult(AskUserQuestion/ExitPlanMode) or TurnStart can clear it. ExitPlanMode tool call -> actionNeeded; PermissionPromptShown -> waitingPermission (always wins via reduceTapBatch); UserInterruption -> interrupted; TurnEnd(end_turn) -> idle; TurnEnd(tool_use) -> toolUse; IdlePrompt -> idle (authoritative).
- [SI-20 L115,573] Worktree cwd detection: when tap events (ConversationMessage, SessionRegistration, WorktreeState) carry a cwd or worktreePath, useTapEventProcessor updates the session's workingDir via updateConfig. WorktreeCleared restores originalCwd. Fires only on change (normalizePath comparison). SessionRegistration cwd updates are gated behind !subTracker.isSubagentInFlight() to prevent subagent session-init events from overwriting the parent session's cwd during the SubagentSpawn-to-first-sidechain-message window.
- [SI-23 L116] Plan detection relies solely on `ToolCallStart(ExitPlanMode)` -> `actionNeeded`. ToolCallStart fires during the SSE stream, structurally before any UserInput can arrive. actionNeeded is sticky: only UserInput, SlashCommand, UserInterruption, PermissionPromptShown, ToolResult(AskUserQuestion/ExitPlanMode), or TurnStart can clear it.

## Session Launcher

- [SL-18 L466] Custom title always persists: userRenamed guard removed — Claude's CustomTitle TAP event now always persists the name to both session store and settings store sessionNames map, regardless of prior user rename.

## Data Flow

- [DF-12 L406] parseBashFiles (src/lib/bashFileParser.ts:L155) tokenizes a Bash command string with shell-quote and walks per-statement registries to extract file-mutation operations. Recognized commands: rm (deleted), rmdir (deleted, isFolder), mv (source=deleted, dest=created), cp (dest=created), touch (created), mkdir (created, isFolder), tee (created or modified with -a), ln (link=created), and > / >> redirections. Skips options (tokens starting with -), handles sudo/doas prefixes, and splits compound commands on &&, ||, ;, |. Paths resolved via canonicalizePath(joinPath(cwd, arg)). Results are heuristic: subshells, variable expansion, and globs are not handled. Called by useTapEventProcessor on ToolInput(Bash) events; path existence is validated by confirmEntries on settled-idle.

## Terminal UI

- [TA-02 L228] Global tool name tracking: seenToolNames Set in sessions store collects unique tool names across all sessions via addSeenToolName() action. Fed by ToolCallStart events in useTapEventProcessor. Immutable Set pattern for reactivity (early return when name already present).

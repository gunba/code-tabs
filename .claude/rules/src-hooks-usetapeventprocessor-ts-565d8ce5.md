---
paths:
  - "src/hooks/useTapEventProcessor.ts"
---

# src/hooks/useTapEventProcessor.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Codex Apply Patch Activity

- [CP-01 L75] useTapEventProcessor.parseApplyPatchFiles (at L75) parses apply_patch tool input text by splitting on newlines and matching '*** (Add|Update|Delete) File: <path>' markers. Matched paths are resolved relative to session workingDir (unless already absolute). Feeds activityStore.addFileActivity per matched path with kind created/modified/deleted respectively. Called from ToolInput(apply_patch) event handling.

## Session Switch

- [SS-01 L682] Inspector detects session switches (plan-mode fork, /resume, compaction) via SessionRegistration event carrying the new sessionId. The useTapEventProcessor compares incoming sessionId against current and fires handleSessionSwitch when they differ.
- [SS-02 L682] Same Bun process, same WebSocket — inspector automatically tracks the new session

## Activity Store Semantics

- [AS-01 L706] markUserMessage() is called by useTapEventProcessor on UserInput and SlashCommand tap events (not on TurnStart). This ensures the Response-mode activity window starts at the actual user input moment, not at the synthetic TurnStart which may fire from subagent turns or internal re-starts that do not represent a real user message.
- [AS-03 L898] Settled-idle endTurn: useTapEventProcessor subscribes to settledStateManager; on settled-idle it calls endTurn(sessionId) to close the current activity turn and trigger stats recomputation. Immediately after, it calls runGitScanAndValidate(sessionId) which: (1) runs git_list_changes for the session workingDir (gated by isGitRepo cache) and adds any changed paths not already in visitedPaths as external file-activity entries; (2) calls paths_exist on all activity paths and calls confirmEntries to drop false-positive entries (e.g. rm'd files still showing as created). settledStateManager subscription at useTapEventProcessor.ts:L627.
  - src/hooks/useTapEventProcessor.ts:L538

## State Tap Reducer

- [SI-13 L268] tapStateReducer event priority: actionNeeded is a sticky state preserved by an early-return guard at the top of reduceTapEvent -- only UserInput, SlashCommand, UserInterruption, PermissionPromptShown, ConversationMessage(user, non-sidechain), IdlePrompt, and ToolResult(AskUserQuestion/ExitPlanMode) or TurnStart can clear it. ExitPlanMode tool call -> actionNeeded; PermissionPromptShown -> waitingPermission (always wins via reduceTapBatch); UserInterruption -> interrupted; TurnEnd(end_turn) -> idle; TurnEnd(tool_use) -> toolUse; IdlePrompt -> idle (authoritative).
- [SI-20 L269,340,846] Worktree cwd detection: when tap events (ConversationMessage, SessionRegistration, WorktreeState) carry a cwd or worktreePath, useTapEventProcessor updates the session's workingDir via updateConfig. WorktreeCleared restores originalCwd. Fires only on change (normalizePath comparison). SessionRegistration cwd updates are gated behind !subTracker.isSubagentInFlight() to prevent subagent session-init events from overwriting the parent session's cwd during the SubagentSpawn-to-first-sidechain-message window.
- [SI-23 L270] Plan detection relies solely on `ToolCallStart(ExitPlanMode)` -> `actionNeeded`. ToolCallStart fires during the SSE stream, structurally before any UserInput can arrive. actionNeeded is sticky: only UserInput, SlashCommand, UserInterruption, PermissionPromptShown, ToolResult(AskUserQuestion/ExitPlanMode), or TurnStart can clear it.

## Session Launcher

- [SL-18 L697] Custom title always persists: userRenamed guard removed — Claude's CustomTitle TAP event now always persists the name to both session store and settings store sessionNames map, regardless of prior user rename.
- [SL-23 L715] Codex tabs auto-rename via LLM upgrade after the heuristic word-truncation: on first UserInput event, after maybeAutoNameCodexSession applies a fast heuristic title (deriveCodexPromptTitle → 7-word truncation, 54-char cap), useTapEventProcessor fire-and-forget invokes generate_codex_session_title via Tauri (spawning 'codex exec --model gpt-5-mini' by default, configurable per codexAutoRenameLLMModel setting). On resolve, the LLM result replaces the tab name only if session.name still equals the heuristicTitle — manual user renames mid-flight are respected. codexLLMUpgraded Set<string> prevents a second exec spawn for the same session. Toggle: settings.codexAutoRenameLLMEnabled (default true, opt-out via Code Tabs preferences section in SettingsTab when cli==='codex'). codexAutoRenameLLMModel default 'gpt-5-mini' — free-text input since Codex accepts any model string at runtime. Sibling to SL-18 (Claude's CustomTitle) — no Op::SetThreadName round-trip into Codex (tab name is a Code Tabs concept; PTY injection would surface as TUI noise in the user's session).

## Data Flow

- [DF-12 L612] parseBashFiles tokenizes a Bash command string with shell-quote and walks per-statement registries to extract file activity. Mutation commands: rm (deleted), rmdir (deleted+isFolder), mv (sources=deleted, dest=created), cp (dest=created), touch (created), mkdir (created+isFolder), tee (created or modified with -a), ln (link=created), and > / >> redirections (created/modified) and < (read). Read commands (kind=read): cat, bat, less, more, nl, wc, file, stat, readlink, realpath, head, tail, sed, awk. Search commands (kind=searched, isFolder=isFolderLike): rg, grep (handles --files/--files-with-matches/-l files-mode and -e/-f/--regexp/--file pattern-from-option), fd, find, ls, tree. stripOptions strips long/short options with values per-command via OptionSpec. looksLikePath rejects flag tokens, env-var assignments (VAR=value), nul bytes, '*' / '**'. looksLikeFilePath: basename has dot AND base != '.'/'..'; isFolderLike: '.', '..', trailing slash, or not file-like. joinPath canonicalizes after collapsing './' and resolving '.' to cwd. Splits compound commands on &&, ||, ;, |, &, |&, ;;, (, ). Skips options (tokens starting with -), handles sudo/doas prefixes. Heuristic: subshells, variable expansion, and globs are not handled. Called by useTapEventProcessor on ToolInput(Bash); path existence is validated by confirmEntries on settled-idle.

## Terminal UI

- [TA-02 L414] Global tool name tracking: seenToolNames Set in sessions store collects unique tool names across all sessions via addSeenToolName() action. Fed by ToolCallStart events in useTapEventProcessor. Immutable Set pattern for reactivity (early return when name already present).

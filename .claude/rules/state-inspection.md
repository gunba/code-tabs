---
paths:
  - "src/lib/inspectorHooks.ts"
  - "src/lib/tapStateReducer.ts"
  - "src/lib/tapMetadataAccumulator.ts"
  - "src/hooks/useTapEventProcessor.ts"
  - "src/hooks/useTapPipeline.ts"
---

# State Inspection

<!-- Codes: SI=State Inspection -->

- [SI-01] Sole source: BUN_INSPECT WebSocket inspector via JSON.stringify interception (~2-6ms latency)
- [SI-02] Inspector connects immediately; retries up to 30x at 100ms intervals (~3s total) for initial connection (Bun init time). After established connection drops, reconnects with backoff delays [2s, 4s, 8s].
- [SI-03] reduceTapEvent() / reduceTapBatch() -- pure state reducer: (SessionState, TapEvent) → SessionState. Replaces poll-based deriveStateFromPoll(). Event-driven, no polling, no terminal buffer fallback.
  - Files: src/lib/tapStateReducer.ts:10
- [SI-04] Permission detection via `PermissionPromptShown` tap event (not PTY regex). tapStateReducer transitions to waitingPermission; permPending flag still exists in INSTALL_HOOK state but is no longer polled.
- [SI-05] Idle detection via TurnEnd(end_turn) tap event in tapStateReducer (not PTY regex). `idleDetected` flag still exists in INSTALL_HOOK state object but is no longer polled. ConversationMessage(assistant, end_turn) also transitions to idle.
  - Files: src/lib/tapStateReducer.ts:30, src/lib/inspectorHooks.ts:78
- [SI-06] `choiceHint` detection: ToolCallStart event with toolName=AskUserQuestion sets choiceHint in tapMetadataAccumulator. Clears on UserInput, TurnEnd, or PermissionApproved events. No terminal buffer scanning.
  - Files: src/lib/tapMetadataAccumulator.ts:99, src/lib/tapMetadataAccumulator.ts:122
- [SI-07] Tool actions, user prompts, assistant text, subagent descriptions captured inline
- [SI-08] State is NEVER inferred from timers or arbitrary delays — only from real signals
- [SI-09] Subagent descriptions, state, tokens, actions, and messages all captured via inspector (no JSONL subagent watcher)
- [SI-10] No JSONL file watching for state — Rust JSONL utilities kept only for `session_has_conversation` and `list_past_sessions`
- [SI-11] Sealed flag (`_sealed`) on result event prevents post-completion JSON.stringify re-serializations (JSONL persistence, hook dispatch) from overwriting `state.stop` back to `tool_use`; tokens/model still accumulate while sealed; cleared on user event
  - Files: src/lib/inspectorHooks.ts:53, src/lib/inspectorHooks.ts:181, src/lib/inspectorHooks.ts:211, src/lib/inspectorHooks.ts:235
- [SI-12] idleDetected is sticky in INSTALL_HOOK state: set on idle_prompt notification, cleared only by user events. Retained in hook for POLL_STATE compatibility; idle state in the running app is now derived from TurnEnd(end_turn) tap events by tapStateReducer.
  - Files: src/lib/inspectorHooks.ts:78, src/lib/inspectorHooks.ts:240
- [SI-13] tapStateReducer event priority: ExitPlanMode tool call → actionNeeded; PermissionPromptShown → waitingPermission (always wins via reduceTapBatch); UserInterruption → interrupted; TurnEnd(end_turn) → idle; TurnEnd(tool_use) → toolUse (unless actionNeeded from ExitPlanMode).
  - Files: src/lib/tapStateReducer.ts:10, src/lib/tapStateReducer.ts:106
- [SI-14] Push-based architecture: INSTALL_TAPS injects hooks via BUN_INSPECT WebSocket; events pushed via TCP to Rust tap server, forwarded as Tauri events to useTapPipeline. INSTALL_HOOK / POLL_STATE still exist in inspectorHooks.ts but are not used by the running app (retained for test coverage).
  - Files: src/lib/inspectorHooks.ts:27, src/lib/inspectorHooks.ts:414, src/hooks/useTapPipeline.ts:31
- [SI-15] POLL_STATE expression fields (retained in inspectorHooks.ts for tests/legacy): n, sid, cost, model, stop, tools, inTok/outTok, events (ring buffer), permPending/idleDetected (notification flags), subs, inputBuf/inputTs, choiceHint, promptDetected, cwd. Not consumed by running app — state now derives from tap events. slashCmd detection moved to LineAccumulator in ptyRegistry.ts.
  - Files: src/lib/inspectorHooks.ts:1110
- [SI-20] Worktree cwd detection: when tap events (ConversationMessage, SessionRegistration, WorktreeState) carry a cwd or worktreePath, useTapEventProcessor updates the session's workingDir via updateConfig. Enables tab acronym display, correct resume cwd, and worktree prune on close. Fires only on change (normalizePath comparison).
  - Files: src/hooks/useTapEventProcessor.ts:54
- [SI-16] WebFetch domain blocklist bypass: intercepts require('https').request to return can_fetch:true for api.anthropic.com/api/web/domain_info, eliminating the 10s preflight that blocks all WebFetch calls. Axios in Bun uses the Node http adapter (not globalThis.fetch), so the hook targets the shared https module singleton. Bypass count exposed as fetchBypassed in poll state.
  - Files: src/lib/inspectorHooks.ts:298
- [SI-17] Interrupt signal detection: Ctrl+C (\x03) and Escape (\x1b) on stdin emit a synthetic result event, set state to end_turn, clear permission/tool flags, and mark all subagents idle — enabling immediate idle detection without waiting for Claude's actual response.
  - Files: src/lib/inspectorHooks.ts:272
- [SI-19] Terminal buffer prompt fallback removed: tap event pipeline is push-based; idle detection via TurnEnd/ConversationMessage events does not require terminal buffer scanning or poll tick counting. `promptDetected` field retained in POLL_STATE for backward compatibility but not consumed.
  - Files: src/lib/tapStateReducer.ts:30
- [SI-21] Tap hooks: INSTALL_TAPS expression for capturing raw internal traffic. 9 categories: parse (JSON.parse), console (log/warn/error), fs (read/write/exists/stat/readdir), spawn (child_process spawn/exec/spawnSync/execSync), fetch (request metadata + timing), exit (process.exit), timer (setTimeout/clearTimeout with caller stack), stdout (process.stdout.write), require (module loading). Dormant by default — enabled per-session via tab context menu. Ring buffer (500) in hooked process, drained at 500ms, flushed to JSONL at 2s intervals via append_tap_data IPC. Files written to %LOCALAPPDATA%/claude-tabs/taps/{session-id}.jsonl.
  - Files: src/lib/inspectorHooks.ts:414, src/hooks/useTapPipeline.ts, src-tauri/src/commands.rs
- [SI-18] WebFetch timeout protection: two hooks prevent indefinite hangs. (1) globalThis.fetch wrapper applies 120s timeout to non-streaming Anthropic API calls (the summarization path via callSmallModel), distinguishing from streaming main conversation by checking for "stream":true in the request body. Wires caller's AbortSignal through a wrapper AbortController. (2) https.request hard timeout applies 90s wall clock to all non-bypassed external HTTPS requests (the axios HTTP GET path), via setTimeout + req.destroy. Counters fetchTimeouts and httpsTimeouts exposed in poll state.
  - Files: src/lib/inspectorHooks.ts:339, src/lib/inspectorHooks.ts:357
- [SI-22] Duration timer: sole source is client-side useDurationTimer (1s setInterval in TerminalPanel, accumulates active-state time). TAP accumulator does NOT emit durationSecs — TurnDuration events fall through to default:null. Timer resets accumulatedRef and lastTickRef on respawnCounter change to prevent stale values after respawn.
  - Files: src/components/Terminal/TerminalPanel.tsx, src/lib/tapMetadataAccumulator.ts

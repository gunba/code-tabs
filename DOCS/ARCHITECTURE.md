# Architecture

<!-- Codes: DF=Data Flow, SI=State Inspection, PT=PTY Internals, PS=Persistence, RS=Respawn & Resume, SS=Session Switch, IN=Inspector, BF=Background Buffering, RC=Rust Commands, CM=Config Manager -->

Technical implementation details. Code implementing a tagged entry is not dead code.

## Data Flow

- [DF-01] User types in xterm.js -> `onData` -> PTY `write` -> ConPTY -> Claude stdin
- [DF-02] Claude stdout -> ConPTY -> direct PTY wrapper `invoke('plugin:pty|read')` -> `Uint8Array`
  - Files: src/lib/ptyProcess.ts:79
- [DF-03] PTY data handler: `writeBytes(data)` to xterm.js (debounce-batched, 4ms/50ms). Background tabs buffer PTY data in bgBufferRef, flushed as single merged write on tab focus.
- [DF-04] React re-renders from Zustand store: tab state dots, status bar, subagent cards
- [DF-05] xterm.js 6.0 with DEC 2026 synchronized output — prevents ink rendering flash on rapid writes
- [DF-06] WebGL renderer for performance, with context loss recovery (retry once after 1s, fallback to canvas)
- [DF-07] Visibility change handler: clears texture atlas and redraws on OS wake / tab restore (fixes GPU corruption after sleep)
- [DF-08] Icons module: src/components/Icons/Icons.tsx exports 24 inline SVG icon components (stroke-based, 16x16 viewBox, currentColor inheritance, pointerEvents none). No dependencies. All UI icons are monochrome SVGs — no emoji or unicode icon chars.
  - Files: src/components/Icons/Icons.tsx:1
- [DF-09] groupSessionsByDir() and swapWithinGroup() in paths.ts: pure functions for tab grouping by normalized workingDir (Map-based, O(n) single pass, insertion-order groups) and position swapping within group boundaries. TabGroup type exported.
  - Files: src/lib/paths.ts:53, src/lib/paths.ts:68

## State Inspection

- [SI-01] Sole source: BUN_INSPECT WebSocket inspector via JSON.stringify interception (~2-6ms latency)
- [SI-02] Inspector connects after 1s delay (Bun init time), retries 3x with backoff on failure
- [SI-03] `deriveStateFromPoll()` — pure function for direct state derivation from inspector data
- [SI-04] Permission detection via `permPending` notification flag (not PTY regex)
- [SI-05] Idle detection via `idleDetected` notification flag (not PTY regex); sticky across polls, cleared only by user event
- [SI-06] `choiceHint` detection: POLL_STATE checks for numbered list items (`\n\s*[1-9]\.\s`) in last 200 chars of assistant text when `stop === 'end_turn'`; auto-clears on user input
- [SI-07] Tool actions, user prompts, assistant text, subagent descriptions captured inline
- [SI-08] State is NEVER inferred from timers or arbitrary delays — only from real signals
- [SI-09] Subagent descriptions, state, tokens, actions, and messages all captured via inspector (no JSONL subagent watcher)
- [SI-10] No JSONL file watching for state — Rust JSONL utilities kept only for `session_has_conversation` and `list_past_sessions`
- [SI-11] Sealed flag (`_sealed`) on result event prevents post-completion JSON.stringify re-serializations (JSONL persistence, hook dispatch) from overwriting `state.stop` back to `tool_use`; tokens/model still accumulate while sealed; cleared on user event
  - Files: src/lib/inspectorHooks.ts:57, src/lib/inspectorHooks.ts:215, src/lib/inspectorHooks.ts:239
- [SI-12] `idleDetected` is sticky (not reset by POLL_STATE) — cleared only by user events in the hook; prevents state oscillation between idle and stale tool_use
  - Files: src/lib/inspectorHooks.ts:239, src/lib/inspectorHooks.ts:363
- [SI-13] `deriveStateFromPoll` override chain: ExitPlanMode refines toolUse→actionNeeded; idleDetected overrides to idle; choiceHint refines idle→actionNeeded; permPending always wins (waitingPermission)
  - Files: src/hooks/useInspectorState.ts:82

## PTY Internals

- [PT-01] Direct PTY wrapper (`ptyProcess.ts`) calls `invoke('plugin:pty|...')` for PTY data — not the `tauri-pty` npm package or raw Tauri event listeners
  - Files: src/lib/ptyProcess.ts:1
- [PT-02] Never pass `env: {}` to PTY spawn — omit `env` to inherit (empty object wipes environment)
- [PT-03] `CLAUDECODE` env var must not leak into spawned PTYs
- [PT-04] Kill button (`pty.kill()`) always fires exitCallback exactly once via `exitFired` guard — whether kill or natural exit completes first
- [PT-05] Tab action buttons (edit/kill/close) suppress focus outline on mouse click via `:focus:not(:focus-visible)`, preserving keyboard accessibility
- [PT-06] Fixed 100K scrollback buffer in `useTerminal` — no dynamic resizing
- [PT-07] OS PID registered in global cleanup registry (`ptyProcess.ts`) immediately on PTY spawn; unregistered on explicit kill. Dual-layer: frontend fires `kill_process_tree` on `beforeunload`, Rust `ActivePids` state kills on `RunEvent::Exit` as backstop
  - Files: src/lib/ptyProcess.ts:9, src-tauri/src/lib.rs:14
- [PT-08] Scroll desync fix: xterm-viewport uses overflow-y:scroll with hidden scrollbar (scrollbar-width:none + ::-webkit-scrollbar) instead of overflow:hidden. isAtBottom/wasAtBottom use 2-line tolerance for near-bottom snap.
  - Files: src/components/Terminal/TerminalPanel.css:55, src/hooks/useTerminal.ts:211, src/hooks/useTerminal.ts:295
- [PT-09] FitAddon dimension guard: fit() calls check proposeDimensions() first — if rows <= 1, container is not laid out yet and fit is skipped. Applied in useTerminal wrapper, initial attach, and ResizeObserver.
  - Files: src/hooks/useTerminal.ts:176, src/hooks/useTerminal.ts:183, src/hooks/useTerminal.ts:312

## Persistence

- [PS-01] Frontend-owned via `persist_sessions_json` — Rust session manager does NOT own persistence (metadata would be stale)
- [PS-02] `beforeunload` event flushes sessions so they survive app restart
- [PS-03] Debounced auto-persist every 2s on session array changes
- [PS-04] `beforeunload` kills all active PTY process trees before persisting — prevents orphaned CLI processes holding session locks on restart
  - Files: src/App.tsx:153, src/lib/ptyProcess.ts:22
- [PS-05] init() awaits both kill_orphan_sessions and detect_claude_cli in parallel via Promise.all before setting claudePath — gates PTY spawning on cleanup completion (previous code set claudePath via fire-and-forget .then() which raced with spawning)
  - Files: src/store/sessions.ts:91

## Respawn & Resume

- [RS-01] `triggerRespawn` cleans up old PTY/watchers/inspector, allocates new inspector port, increments respawn counter
- [RS-02] Resume target chain: `resumeSession || sessionId || id` (chains through multiple respawns)
- [RS-03] Check conversation existence via `nodeSummary || resumeSession` (in-memory, no JSONL)
- [RS-04] `resumeSession` and `continueSession` are one-shot flags — never persist in `lastConfig`
- [RS-05] Skip `--session-id` CLI arg when using `--resume` or `--continue`
- [RS-06] Session-in-use auto-recovery: checks process ancestry to distinguish own orphans from external processes; own descendants (stale orphans from crashed tabs) killed automatically and resume retries

## Session Switch

- [SS-01] Inspector detects session switches (plan-mode fork, `/resume`, compaction) via `sid` field change
- [SS-02] Same Bun process, same WebSocket — inspector automatically tracks the new session
- [SS-03] No JSONL file scanning or polling required

## Inspector

- [IN-01] Inspector port allocation and registry in `inspectorPort.ts`
- [IN-02] `INSTALL_HOOK` + `POLL_STATE` JS expressions in `inspectorHooks.ts`
- [IN-03] Subagent tracking: inspector detects Agent tool_use -> queues description -> matches with new session ID system event -> routes events to subagent entry
- [IN-04] Subagent messages drained on poll and appended to store for SubagentInspector
- [IN-05] Stale subagents (no events for 30s while active) auto-marked dead
- [IN-06] Dead subagent purge: when new subagent appears and no subs are actively running (thinking/toolUse/starting), idle subs are marked dead and physically removed from store
- [IN-07] Inspector port allocator uses random start offset (Date.now() mod range) to reduce collisions with orphan processes during the brief window between app startup and cleanup
  - Files: src/lib/inspectorPort.ts:9

## Background Buffering

- [BF-01] Background tabs: PTY data buffered in `bgBufferRef`, flushed as single batched write on tab focus (O(1) rendering)
- [BF-02] `visibleRef` tracks tab visibility for buffering decisions

## Rust Commands

- [RC-01] `create_session` / `close_session` — Session CRUD
- [RC-02] `build_claude_args` — SessionConfig -> CLI args (`--resume`, `--session-id`, `--project-dir`, etc.)
- [RC-03] `start_jsonl_watcher` / `stop_jsonl_watcher` — Tail JSONL files, emit events (fast scan for resumed sessions)
- [RC-04] `find_continuation_session` — Detect plan-mode forks via sessionId in first events of other JSONL files
- [RC-05] `detect_claude_cli` / `check_cli_version` / `get_cli_help` — CLI discovery
- [RC-06] `list_past_sessions` — Scan `~/.claude/projects/` for resumable sessions (async, `spawn_blocking`)
- [RC-07] `get_first_user_message` — Read first user message from session JSONL
- [RC-08] `persist_sessions_json` / `load_persisted_sessions` — Save/restore sessions
- [RC-09] `discover_builtin_commands` / `discover_plugin_commands` — Slash command discovery
- [RC-10] `discover_hooks` / `save_hooks` — Hook configuration
- [RC-11] register_active_pid / unregister_active_pid — frontend registers OS PIDs of PTY children; RunEvent::Exit handler iterates ActivePids and calls kill_process_tree_sync for each
  - Files: src-tauri/src/commands.rs:1098, src-tauri/src/lib.rs:114
- [RC-12] Config files read/write: read_config_file and write_config_file handle settings JSON, CLAUDE.md (3 scopes), and agent files (3 scopes: user=~/.claude/agents/, project={wd}/.claude/agents/, local={wd}/.claude/local/agents/). list_agents takes scope param. Parent dirs auto-created on write.
  - Files: src-tauri/src/commands.rs:1487, src-tauri/src/commands.rs:1498
- [RC-13] kill_orphan_sessions: takes Vec<String> session IDs, finds processes by command line match (WMIC on Windows, pgrep on Unix), kills all without ancestry check (safe at startup since no live sessions exist yet). Returns count of killed processes
  - Files: src-tauri/src/commands.rs:1366, src-tauri/src/lib.rs:101
- [RC-14] send_notification: Custom WinRT toast command bypassing Tauri notification plugin. Uses tauri-winrt-notification Toast with on_activated callback that emits 'notification-clicked' event to frontend. Dev mode uses PowerShell app ID, production uses bundle identifier. spawn_blocking + CREATE_NO_WINDOW compliant.
  - Files: src-tauri/src/commands.rs:1565, src/hooks/useNotifications.ts:44

## Config Manager


- [CM-01] Config modal header uses CSS grid (auto 1fr auto) instead of flexbox space-between, so tab row stays centered regardless of left (title) or right (project selector + close) content width.
  - Files: src/components/ConfigManager/ConfigManager.css:20, src/components/ConfigManager/ConfigManager.tsx:67
- [CM-02] formatScopePath() normalizes backslashes to forward slashes and abbreviates project-scope paths via abbreviatePath(). User-scope paths (~/...) pass through unchanged.
  - Files: src/lib/paths.ts:43
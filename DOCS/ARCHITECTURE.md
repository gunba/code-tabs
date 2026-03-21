# Architecture

<!-- Codes: DF=Data Flow, SI=State Inspection, PT=PTY Internals, PS=Persistence, RS=Respawn & Resume, SS=Session Switch, IN=Inspector, BF=Background Buffering, RC=Rust Commands -->

Technical implementation details. Code implementing a tagged entry is not dead code.

## Data Flow

- [DF-01] User types in xterm.js -> `onData` -> PTY `write` -> ConPTY -> Claude stdin
- [DF-02] Claude stdout -> ConPTY -> `tauri-pty` npm `onData` -> `Uint8Array`
- [DF-03] PTY data handler: `writeBytes(data)` to xterm.js (debounce-batched, 4ms/50ms) + `feed(text)` for permission detection
- [DF-04] React re-renders from Zustand store: tab state dots, status bar, subagent cards
- [DF-05] xterm.js 6.0 with DEC 2026 synchronized output — prevents ink rendering flash on rapid writes
- [DF-06] WebGL renderer for performance, with context loss recovery (retry once after 1s, fallback to canvas)
- [DF-07] Visibility change handler: clears texture atlas and redraws on OS wake / tab restore (fixes GPU corruption after sleep)

## State Inspection

- [SI-01] Sole source: BUN_INSPECT WebSocket inspector via JSON.stringify interception (~2-6ms latency)
- [SI-02] Inspector connects after 1s delay (Bun init time), retries 3x with backoff on failure
- [SI-03] `deriveStateFromPoll()` — pure function for direct state derivation from inspector data
- [SI-04] Permission detection via `permPending` notification flag (not PTY regex)
- [SI-05] Idle detection via `idleDetected` notification flag (not PTY regex)
- [SI-06] `choiceHint` detection: POLL_STATE checks for numbered list items (`\n\s*[1-9]\.\s`) in last 200 chars of assistant text when `stop === 'end_turn'`; auto-clears on user input
- [SI-07] Tool actions, user prompts, assistant text, subagent descriptions captured inline
- [SI-08] State is NEVER inferred from timers or arbitrary delays — only from real signals
- [SI-09] Subagent descriptions, state, tokens, actions, and messages all captured via inspector (no JSONL subagent watcher)
- [SI-10] No JSONL file watching for state — Rust JSONL utilities kept only for `session_has_conversation` and `list_past_sessions`

## PTY Internals

- [PT-01] Use `tauri-pty` npm wrapper for PTY data — not raw Tauri event listeners
- [PT-02] Never pass `env: {}` to PTY spawn — omit `env` to inherit (empty object wipes environment)
- [PT-03] `CLAUDECODE` env var must not leak into spawned PTYs
- [PT-04] Kill button (`pty.kill()`) always fires exitCallback exactly once via `exitFired` guard — whether kill or natural exit completes first
- [PT-05] Tab action buttons (edit/kill/close) suppress focus outline on mouse click via `:focus:not(:focus-visible)`, preserving keyboard accessibility
- [PT-06] Fixed 100K scrollback buffer in `useTerminal` — no dynamic resizing
- [PT-07] OS PID registered in global cleanup registry (`ptyProcess.ts`) immediately on PTY spawn; unregistered on explicit kill. Dual-layer: frontend fires `kill_process_tree` on `beforeunload`, Rust `ActivePids` state kills on `RunEvent::Exit` as backstop
  - Files: src/lib/ptyProcess.ts:9, src-tauri/src/lib.rs:14
- [PT-08] Scroll desync fix: xterm-viewport uses overflow-y:scroll with hidden scrollbar (scrollbar-width:none + ::-webkit-scrollbar) instead of overflow:hidden. isAtBottom/wasAtBottom use 2-line tolerance for near-bottom snap.
  - Files: src/components/Terminal/TerminalPanel.css:55, src/hooks/useTerminal.ts:282

## Persistence

- [PS-01] Frontend-owned via `persist_sessions_json` — Rust session manager does NOT own persistence (metadata would be stale)
- [PS-02] `beforeunload` event flushes sessions so they survive app restart
- [PS-03] Debounced auto-persist every 2s on session array changes
- [PS-04] `beforeunload` kills all active PTY process trees before persisting — prevents orphaned CLI processes holding session locks on restart
  - Files: src/App.tsx:155, src/lib/ptyProcess.ts:22

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
- [RC-11] [RC-07] `register_active_pid` / `unregister_active_pid` — frontend registers OS PIDs of PTY children; `RunEvent::Exit` handler iterates `ActivePids` and calls `kill_process_tree_sync` for each
  - Files: src-tauri/src/commands.rs:1098, src-tauri/src/lib.rs:109
- [RC-12] Config files read/write: read_config_file and write_config_file handle settings JSON, CLAUDE.md (3 scopes), and agent files. Parent dirs auto-created on write.
  - Files: src-tauri/src/commands.rs:1397

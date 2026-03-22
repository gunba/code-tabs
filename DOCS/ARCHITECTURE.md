# Architecture

<!-- Codes: DF=Data Flow, SI=State Inspection, PT=PTY Internals, PS=Persistence, RS=Respawn & Resume, SS=Session Switch, IN=Inspector, BF=Background Buffering, RC=Rust Commands, CM=Config Manager -->

Technical implementation details. Code implementing a tagged entry is not dead code.

## Data Flow

- [DF-01] User types in xterm.js -> `onData` -> PTY `write` -> ConPTY -> Claude stdin
- [DF-02] Claude stdout -> ConPTY -> direct PTY wrapper `invoke('plugin:pty|read')` -> `Uint8Array`
  - Files: src/lib/ptyProcess.ts:88
- [DF-03] PTY data handler: `writeBytes(data)` to xterm.js (debounce-batched, 4ms/50ms). Background tabs buffer PTY data in bgBufferRef, flushed as single merged write on tab focus.
- [DF-04] React re-renders from Zustand store: tab state dots, status bar, subagent cards
- [DF-05] xterm.js 6.0 with DEC 2026 synchronized output — prevents ink rendering flash on rapid writes
- [DF-06] WebGL renderer for performance, with context loss recovery (retry once after 1s, fallback to canvas)
- [DF-07] Visibility change handler: clears texture atlas and redraws on OS wake / tab restore (fixes GPU corruption after sleep)
- [DF-08] Icons module: src/components/Icons/Icons.tsx exports 24 inline SVG icon components (stroke-based, 16x16 viewBox, currentColor inheritance, pointerEvents none). No dependencies. All UI icons are monochrome SVGs — no emoji or unicode icon chars.
  - Files: src/components/Icons/Icons.tsx:1
- [DF-09] groupSessionsByDir() and swapWithinGroup() in paths.ts: pure functions for tab grouping by normalized workingDir (Map-based, O(n) single pass, insertion-order groups) and position swapping within group boundaries. TabGroup type exported.
  - Files: src/lib/paths.ts:49, src/lib/paths.ts:64

## State Inspection

- [SI-01] Sole source: BUN_INSPECT WebSocket inspector via JSON.stringify interception (~2-6ms latency)
- [SI-02] Inspector connects after 1s delay (Bun init time), retries 3x with backoff on failure
- [SI-03] `deriveStateFromPoll()` — pure function for state derivation from poll payloads; replaces poll-based derivation
  - Files: src/hooks/useInspectorState.ts:37
- [SI-04] Permission detection via `permPending` notification flag (not PTY regex)
- [SI-05] Idle detection via `idleDetected` notification flag (not PTY regex); sticky, cleared only by user event; pushed in real-time via `__ispPush`
  - Files: src/lib/inspectorHooks.ts:77
- [SI-06] `choiceHint` detection: poll result computes choiceHint from numbered list items in last 200 chars of assistant text when stop=end_turn and no tools in turn; auto-clears on user input (resets stop to null)
  - Files: src/lib/inspectorHooks.ts:315, src/hooks/useInspectorState.ts:69
- [SI-07] Tool actions, user prompts, assistant text, subagent descriptions captured inline
- [SI-08] State is NEVER inferred from timers or arbitrary delays — only from real signals
- [SI-09] Subagent descriptions, state, tokens, actions, and messages all captured via inspector (no JSONL subagent watcher)
- [SI-10] No JSONL file watching for state — Rust JSONL utilities kept only for `session_has_conversation` and `list_past_sessions`
- [SI-11] Sealed flag (`_sealed`) on result event prevents post-completion JSON.stringify re-serializations (JSONL persistence, hook dispatch) from overwriting `state.stop` back to `tool_use`; tokens/model still accumulate while sealed; cleared on user event
  - Files: src/lib/inspectorHooks.ts:53, src/lib/inspectorHooks.ts:181, src/lib/inspectorHooks.ts:211, src/lib/inspectorHooks.ts:235
- [SI-12] idleDetected is sticky: cleared only by user events in the hook; prevents state oscillation between idle and stale tool_use
  - Files: src/lib/inspectorHooks.ts:236
- [SI-13] `deriveStateFromPoll` override chain: ExitPlanMode refines toolUse to actionNeeded; idleDetected overrides to idle; choiceHint refines idle to actionNeeded; permPending always wins (waitingPermission)
  - Files: src/hooks/useInspectorState.ts:37, src/hooks/useInspectorState.ts:63
- [SI-14] Poll-based architecture: INSTALL_HOOK wraps JSON.stringify to capture state into globalThis.__inspectorState; useInspectorState polls via POLL_STATE expression every 250ms, draining events and transient flags each cycle. No push binding; state detection disabled if hook install fails.
  - Files: src/hooks/useInspectorState.ts:203, src/lib/inspectorHooks.ts:27
- [SI-15] Poll result fields: InspectorPollResult includes n (event count), sid, cost, model, stop, tools, inTok/outTok, events (ring buffer), permPending/idleDetected (notification flags), subs (subagent state with spliced msgs), inputBuf/inputTs (stdin capture), choiceHint (computed from lastText)
  - Files: src/lib/inspectorHooks.ts:296, src/hooks/useInspectorState.ts:7

## PTY Internals

- [PT-01] Direct PTY wrapper (`ptyProcess.ts`) calls `invoke('plugin:pty|...')` for PTY data — not the `tauri-pty` npm package or raw Tauri event listeners
  - Files: src/lib/ptyProcess.ts:1
- [PT-02] Never pass `env: {}` to PTY spawn — omit `env` to inherit (empty object wipes environment)
- [PT-03] `CLAUDECODE` env var must not leak into spawned PTYs
- [PT-04] Kill button (`pty.kill()`) always fires exitCallback exactly once via `exitFired` guard — whether kill or natural exit completes first
- [PT-05] Tab action buttons (edit/kill/close) suppress focus outline on mouse click via `:focus:not(:focus-visible)`, preserving keyboard accessibility
- [PT-06] Fixed 100K scrollback buffer in `useTerminal` — no dynamic resizing
- [PT-07] OS PID registered in global cleanup registry (`ptyProcess.ts`) immediately on PTY spawn; unregistered on explicit kill. Dual-layer: frontend fires `kill_process_tree` on `beforeunload`, Rust `ActivePids` state kills on `RunEvent::Exit` as backstop
  - Files: src/lib/ptyProcess.ts:9, src-tauri/src/lib.rs:16
- [PT-08] Scroll desync fix: xterm-viewport uses overflow-y:scroll with hidden scrollbar (scrollbar-width:none + ::-webkit-scrollbar) instead of overflow:hidden. isAtBottom/wasAtBottom use 2-line tolerance for near-bottom snap.
  - Files: src/components/Terminal/TerminalPanel.css:59, src/hooks/useTerminal.ts:299, src/hooks/useTerminal.ts:214, src/hooks/useTerminal.ts:9
- [PT-09] FitAddon dimension guard: fit() calls check proposeDimensions() first — if rows <= 1, container is not laid out yet and fit is skipped. Applied in useTerminal wrapper, initial attach, and ResizeObserver.
  - Files: src/hooks/useTerminal.ts:312, src/hooks/useTerminal.ts:178, src/hooks/useTerminal.ts:184
- [PT-10] Parallel exit waiter: fire-and-forget invoke('plugin:pty|exitstatus') runs alongside read loop. On Windows ConPTY, read pipe may hang after Ctrl+C; exitstatus uses WaitForSingleObject which reliably returns. exitFired guard ensures exactly one callback fires
  - Files: src/lib/ptyProcess.ts:112
- [PT-11] Respawn clears both bgBufferRef and useTerminal's writeBatchRef (via clearPending()) before writing \x1bc. Without this, stale PTY data from previous sessions survives the terminal reset and gets flushed when the tab becomes visible, causing duplicated conversation content.
  - Files: src/components/Terminal/TerminalPanel.tsx:306, src/hooks/useTerminal.ts:366
- [PT-12] Pre-spawn fit() + post-spawn rAF dimension verification prevents 80-col race when font metrics or WebGL renderer aren't ready during initial layout
  - Files: src/components/Terminal/TerminalPanel.tsx:382, src/components/Terminal/TerminalPanel.tsx:396-402

## Persistence

- [PS-01] Frontend-owned via `persist_sessions_json` — Rust session manager does NOT own persistence (metadata would be stale)
- [PS-02] `beforeunload` event flushes sessions so they survive app restart
- [PS-03] Debounced auto-persist every 2s on session array changes
- [PS-04] `beforeunload` kills all active PTY process trees before persisting — prevents orphaned CLI processes holding session locks on restart
  - Files: src/App.tsx:151, src/lib/ptyProcess.ts:22
- [PS-05] init() awaits both kill_orphan_sessions and detect_claude_cli in parallel via Promise.all before setting claudePath — gates PTY spawning on cleanup completion (previous code set claudePath via fire-and-forget .then() which raced with spawning)
  - Files: src/store/sessions.ts:86

## Respawn & Resume

- [RS-01] `triggerRespawn` cleans up old PTY/watchers/inspector, allocates new inspector port, increments respawn counter
- [RS-02] Resume target chain: `resumeSession || sessionId || id` (chains through multiple respawns)
- [RS-03] Check conversation existence via `nodeSummary || resumeSession` (in-memory, no JSONL)
- [RS-04] `resumeSession` and `continueSession` are one-shot flags — never persist in `lastConfig`
- [RS-05] Skip `--session-id` CLI arg when using `--resume` or `--continue`
- [RS-06] Session-in-use auto-recovery: checks process ancestry to distinguish own orphans from external processes; own descendants (stale orphans from crashed tabs) killed automatically and resume retries
- [RS-07] Spawn effect guards against dead sessions (session.state === 'dead') -- prevents restored dead sessions from auto-spawning with --session-id on startup. Respawns still work because triggerRespawn sets state to 'starting' before incrementing respawnCounter
  - Files: src/components/Terminal/TerminalPanel.tsx:376
- [RS-08] Auto-resume effect uses prevVisibleRef to detect hidden-to-visible transitions; only fires when tab becomes visible AND session is dead AND conversation is resumable; 150ms delay for render settling
  - Files: src/components/Terminal/TerminalPanel.tsx:420
- [RS-09] Terminal reset on respawn: writes ANSI RIS (\x1bc) to clear content and scrollback, then fit() to sync xterm.js dimensions before spawning new PTY
  - Files: src/components/Terminal/TerminalPanel.tsx:308

## Session Switch

- [SS-01] Inspector detects session switches (plan-mode fork, `/resume`, compaction) via `sid` field change
- [SS-02] Same Bun process, same WebSocket — inspector automatically tracks the new session
- [SS-03] No JSONL file scanning or polling required

## Inspector

- [IN-01] Inspector port allocation and registry in `inspectorPort.ts`
- [IN-02] `INSTALL_HOOK` JS expression in `inspectorHooks.ts`; wraps JSON.stringify to capture events into globalThis.__inspectorState. Polled every 250ms via POLL_STATE.
  - Files: src/lib/inspectorHooks.ts:27
- [IN-03] Subagent tracking: inspector detects Agent tool_use -> queues description -> matches with new session ID system event -> routes events to subagent entry
- [IN-04] Subagent conversation messages captured via POLL_STATE splice (sub.msgs.splice(0)) each poll cycle; messages accumulated in INSTALL_HOOK's subagent tracking and drained by the frontend poller
  - Files: src/lib/inspectorHooks.ts:317, src/hooks/useInspectorState.ts:120
- [IN-05] Stale subagent detection removed -- push-based architecture handles subagent lifecycle via real-time state events only
  - Files: src/hooks/useInspectorState.ts:149
- [IN-06] Dead subagent purge removed -- push-based architecture relies on real-time state transitions; idle subs remain visible until session ends
  - Files: src/hooks/useInspectorState.ts:149
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
- [RC-11] register_active_pid / unregister_active_pid -- frontend registers OS PIDs of PTY children; RunEvent::Exit handler iterates ActivePids and calls kill_process_tree_sync for each
  - Files: src-tauri/src/commands.rs:1133, src-tauri/src/lib.rs:115
- [RC-12] Config files read/write: read_config_file and write_config_file handle settings JSON, CLAUDE.md (3 scopes), and agent files (3 scopes: user=~/.claude/agents/, project={wd}/.claude/agents/, local={wd}/.claude/local/agents/). list_agents takes scope param. Parent dirs auto-created on write.
  - Files: src-tauri/src/commands.rs:1501, src-tauri/src/commands.rs:1512
- [RC-13] kill_orphan_sessions: takes Vec<String> session IDs, finds processes by command line match (WMIC on Windows, pgrep on Unix), kills all without ancestry check (safe at startup since no live sessions exist yet). Returns count of killed processes
  - Files: src-tauri/src/commands.rs:1400, src/store/sessions.ts:90
- [RC-14] send_notification: Custom WinRT toast command bypassing Tauri notification plugin. Uses tauri-winrt-notification Toast with on_activated callback that emits notification-clicked event to frontend. Dev mode uses PowerShell app ID, production uses bundle identifier. spawn_blocking + CREATE_NO_WINDOW compliant.
  - Files: src-tauri/src/commands.rs:1599, src/hooks/useNotifications.ts:44

## Config Manager


- [CM-01] Config modal header uses CSS grid (auto 1fr auto) instead of flexbox space-between, so tab row stays centered regardless of left (title) or right (project selector + close) content width.
  - Files: src/components/ConfigManager/ConfigManager.css:18, src/components/ConfigManager/ConfigManager.tsx:66
- [CM-02] formatScopePath() normalizes backslashes to forward slashes and abbreviates project-scope paths via abbreviatePath(). User-scope paths (~/...) pass through unchanged.
  - Files: src/lib/paths.ts:89
- [CM-03] Settings schema discovery uses 4-tier priority: (1) JSON Schema from schemastore.org fetched via Rust fetch_settings_schema command (reqwest, avoids CORS), cached in localStorage by CLI version; (2) CLI --help flag parsing; (3) Binary Zod regex scan; (4) Static field registry. parseJsonSchema() unwraps Zod anyOf optionals, maps JSON Schema types to SettingField types, extracts descriptions/enums. buildSettingsSchema() deduplicates across all tiers.
  - Files: src/lib/settingsSchema.ts:62, src-tauri/src/commands.rs:650, src/store/settings.ts:233
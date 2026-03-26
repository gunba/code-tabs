# Architecture

<!-- Codes: DF=Data Flow, SI=State Inspection, PT=PTY Internals, PS=Persistence, RS=Respawn & Resume, SS=Session Switch, IN=Inspector, BF=Background Buffering, RC=Rust Commands, CI=Config Implementation -->

Technical implementation details. Code implementing a tagged entry is not dead code.

## Data Flow

- [DF-01] User types in xterm.js -> `onData` -> `writeToPty()` (ptyRegistry.ts: LineAccumulator detects slash commands) -> PTY `write` -> PTY (ConPTY on Windows, openpty on Linux) -> Claude stdin
- [DF-02] Claude stdout -> PTY -> background reader thread (8 KiB) -> sync_channel(64) -> OutputFilter (security) -> SyncBlockDetector (DEC 2026 coalescing) -> IPC response -> Uint8Array
  - Files: src-tauri/pty-patch/src/lib.rs:179, src/lib/ptyProcess.ts:88
- [DF-03] PTY data handler: `writeBytes(data)` to xterm.js (debounce-batched, 4ms/50ms). Background tabs buffer PTY data in bgBufferRef, flushed as single merged write on tab focus.
- [DF-04] React re-renders from Zustand store: tab state dots, status bar, subagent cards
- [DF-05] xterm.js 6.0 with DEC 2026 synchronized output — prevents ink rendering flash on rapid writes
- [DF-06] WebGL renderer for performance, with context loss recovery (retry once after 1s, fallback to canvas)
- [DF-07] Visibility change handler: clears texture atlas and redraws on OS wake / tab restore (fixes GPU corruption after sleep)
- [DF-08] Icons module: src/components/Icons/Icons.tsx exports 25 inline SVG icon components (stroke-based, 16x16 viewBox, currentColor inheritance, pointerEvents none). No dependencies. All UI icons are monochrome SVGs — no emoji or unicode icon chars.
  - Files: src/components/Icons/Icons.tsx:1
- [DF-09] groupSessionsByDir() and swapWithinGroup() in paths.ts: pure functions for tab grouping by normalized workingDir (Map-based, O(n) single pass, insertion-order groups) and position swapping within group boundaries. TabGroup type exported. parseWorktreePath() detects `.claude/worktrees/<slug>` paths, worktreeAcronym() abbreviates slugs by hyphen initials.
  - Files: src/lib/paths.ts:73, src/lib/paths.ts:88, src/lib/paths.ts:22, src/lib/paths.ts:33
- [DF-10] toSideBySide(hunks) in diffParser.ts: transforms unified DiffHunk[] into aligned SideBySideRow[] for dual-pane rendering. Context lines go to both sides. Consecutive del+add runs are paired 1:1 (excess gets null on the other side). Hunk headers become separator rows. Pure function, memoized in DiffModal via useMemo.
  - Files: src/lib/diffParser.ts:268

## State Inspection

- [SI-01] Sole source: BUN_INSPECT WebSocket inspector via JSON.stringify interception (~2-6ms latency)
- [SI-02] Inspector connects after 1s delay (Bun init time), retries 3x with backoff on failure
- [SI-03] deriveStateFromPoll() -- pure function for state derivation from poll payloads; replaces poll-based derivation
  - Files: src/hooks/useInspectorState.ts:44
- [SI-04] Permission detection via `permPending` notification flag (not PTY regex)
- [SI-05] Idle detection via `idleDetected` notification flag (not PTY regex); sticky, cleared only by user event; set synchronously in JSON.stringify hook, drained by poll loop. Fallback: `promptDetected` scans terminal buffer tail for Claude Code prompt markers (NBSP-delimited) after 2+ polls with no events.
  - Files: src/lib/inspectorHooks.ts:77, src/hooks/useInspectorState.ts:152
- [SI-06] `choiceHint` detection: terminal buffer tail scan (last 15 lines via `getSessionBufferTail`) detects numbered list items when stop=end_turn and no tools in turn; auto-clears on user input (resets stop to null)
- [SI-07] Tool actions, user prompts, assistant text, subagent descriptions captured inline
- [SI-08] State is NEVER inferred from timers or arbitrary delays — only from real signals
- [SI-09] Subagent descriptions, state, tokens, actions, and messages all captured via inspector (no JSONL subagent watcher)
- [SI-10] No JSONL file watching for state — Rust JSONL utilities kept only for `session_has_conversation` and `list_past_sessions`
- [SI-11] Sealed flag (`_sealed`) on result event prevents post-completion JSON.stringify re-serializations (JSONL persistence, hook dispatch) from overwriting `state.stop` back to `tool_use`; tokens/model still accumulate while sealed; cleared on user event
  - Files: src/lib/inspectorHooks.ts:53, src/lib/inspectorHooks.ts:181, src/lib/inspectorHooks.ts:211, src/lib/inspectorHooks.ts:235
- [SI-12] idleDetected is sticky: cleared only by user events in the hook; prevents state oscillation between idle and stale tool_use
  - Files: src/lib/inspectorHooks.ts:236
- [SI-13] deriveStateFromPoll override chain: ExitPlanMode refines toolUse to actionNeeded; idleDetected overrides to idle; promptDetected overrides thinking/toolUse to idle (no-events guard); choiceHint refines idle to actionNeeded; permPending always wins (waitingPermission)
  - Files: src/hooks/useInspectorState.ts:44, src/hooks/useInspectorState.ts:70
- [SI-14] Poll-based architecture: INSTALL_HOOK wraps JSON.stringify to capture state into globalThis.__inspectorState; useInspectorState polls via POLL_STATE expression every 250ms. POLL_STATE drains events unconditionally before subs processing; subs iteration wrapped in try/catch to prevent cascading failures. Evaluation errors logged via onmessage exceptionDetails check.
  - Files: src/hooks/useInspectorState.ts:285, src/lib/inspectorHooks.ts:27, src/lib/inspectorHooks.ts:737
- [SI-15] Poll result fields: InspectorPollResult includes n (event count), sid, cost, model, stop, tools, inTok/outTok, events (ring buffer), permPending/idleDetected (notification flags), subs (subagent state with spliced msgs), inputBuf/inputTs (stdin capture), choiceHint (terminal selector), promptDetected (terminal prompt fallback), cwd (process.cwd() for worktree detection). Note: slashCmd is still captured in POLL_STATE but no longer consumed — slash command detection moved to LineAccumulator in ptyRegistry.ts
  - Files: src/lib/inspectorHooks.ts:737, src/hooks/useInspectorState.ts:8
- [SI-20] Worktree cwd detection: when POLL_STATE returns a changed cwd (e.g., after Claude enters a worktree via -w), useInspectorState updates the session's workingDir. Enables tab acronym display, correct resume cwd, and worktree prune on close. Uses a ref to fire only on change, not every poll cycle.
  - Files: src/hooks/useInspectorState.ts:186
- [SI-16] WebFetch domain blocklist bypass: intercepts require('https').request to return can_fetch:true for api.anthropic.com/api/web/domain_info, eliminating the 10s preflight that blocks all WebFetch calls. Axios in Bun uses the Node http adapter (not globalThis.fetch), so the hook targets the shared https module singleton. Bypass count exposed as fetchBypassed in poll state.
  - Files: src/lib/inspectorHooks.ts:298
- [SI-17] Interrupt signal detection: Ctrl+C (\x03) and Escape (\x1b) on stdin emit a synthetic result event, set state to end_turn, clear permission/tool flags, and mark all subagents idle — enabling immediate idle detection without waiting for Claude's actual response.
  - Files: src/lib/inspectorHooks.ts:272
- [SI-19] Terminal buffer prompt fallback: when no events flow for 2+ consecutive polls (noEventTicksRef) and the terminal tail's last line contains a Claude Code prompt marker (`>\u00A0` or `❯`), `promptDetected` is set. deriveStateFromPoll overrides thinking/toolUse to idle when promptDetected is true and events are empty. Prevents stuck states from POLL_STATE failures or missed events.
  - Files: src/hooks/useInspectorState.ts:152, src/hooks/useInspectorState.ts:77
- [SI-21] Tap hooks: separate INSTALL_TAPS/POLL_TAPS expressions for capturing raw internal traffic. 9 categories: parse (JSON.parse), console (log/warn/error), fs (read/write/exists/stat/readdir), spawn (child_process spawn/exec/spawnSync/execSync), fetch (request metadata + timing), exit (process.exit), timer (setTimeout/clearTimeout with caller stack), stdout (process.stdout.write), require (module loading). Dormant by default — enabled per-session via tab context menu. Ring buffer (500) in hooked process, drained at 500ms, flushed to JSONL at 2s intervals via append_tap_data IPC. Files written to %LOCALAPPDATA%/claude-tabs/taps/{session-id}.jsonl.
  - Files: src/lib/inspectorHooks.ts, src/hooks/useTapRecorder.ts, src-tauri/src/commands.rs
- [SI-18] WebFetch timeout protection: two hooks prevent indefinite hangs. (1) globalThis.fetch wrapper applies 120s timeout to non-streaming Anthropic API calls (the summarization path via callSmallModel), distinguishing from streaming main conversation by checking for "stream":true in the request body. Wires caller's AbortSignal through a wrapper AbortController. (2) https.request hard timeout applies 90s wall clock to all non-bypassed external HTTPS requests (the axios HTTP GET path), via setTimeout + req.destroy. Counters fetchTimeouts and httpsTimeouts exposed in poll state.
  - Files: src/lib/inspectorHooks.ts:339, src/lib/inspectorHooks.ts:357

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
  - Files: src/components/Terminal/TerminalPanel.css:60, src/hooks/useTerminal.ts:300, src/hooks/useTerminal.ts:215, src/hooks/useTerminal.ts:10
- [PT-09] FitAddon dimension guard: fit() calls check proposeDimensions() first — if rows <= 1, container is not laid out yet and fit is skipped. Applied in useTerminal wrapper, initial attach, and ResizeObserver.
  - Files: src/hooks/useTerminal.ts:313, src/hooks/useTerminal.ts:180, src/hooks/useTerminal.ts:187
- [PT-10] Parallel exit waiter: fire-and-forget invoke('plugin:pty|exitstatus') runs alongside read loop. On Windows ConPTY, read pipe may hang after Ctrl+C; exitstatus uses WaitForSingleObject which reliably returns. exitFired guard ensures exactly one callback fires
  - Files: src/lib/ptyProcess.ts:112
- [PT-11] Respawn clears both bgBufferRef and useTerminal's writeBatchRef (via clearPending()) before writing \x1bc. Without this, stale PTY data from previous sessions survives the terminal reset and gets flushed when the tab becomes visible, causing duplicated conversation content.
  - Files: src/components/Terminal/TerminalPanel.tsx:314, src/hooks/useTerminal.ts:386
- [PT-12] Pre-spawn fit() + post-spawn rAF dimension verification prevents 80-col race when font metrics or WebGL renderer aren't ready during initial layout
  - Files: src/components/Terminal/TerminalPanel.tsx:417, src/components/Terminal/TerminalPanel.tsx:431-437
- [PT-13] Same-dimension gate: handleResize tracks last PTY dims in a ref; skips redundant pty.resize() calls when cols/rows unchanged. Prevents ConPTY reflow duplication from layout-triggered ResizeObserver events.
  - Files: src/components/Terminal/TerminalPanel.tsx:375
- [PT-15] Background reader thread per session: OS thread reads ConPTY pipe (8 KiB buffer) into bounded sync_channel(64). Decouples blocking pipe reads from IPC, enabling timeout-based sync block coalescing in the read command.
  - Files: src-tauri/pty-patch/src/lib.rs:127
- [PT-16] DEC 2026 sync coalescing: read command filters output through OutputFilter then SyncBlockDetector. When mid-sync-block (BSU seen, ESU pending), reads continue with 50ms timeout to coalesce the complete synchronized update into a single IPC response. Eliminates scroll jumping from ConPTY-fragmented redraws.
  - Files: src-tauri/pty-patch/src/lib.rs:179, src-tauri/pty-patch/src/sync_detector.rs:1
- [PT-17] Output security filter: byte-level state machine strips OSC 52 (clipboard hijack), OSC 50 (font query), DCS sequences, C1 controls (including cross-chunk PendingC2 state), ESC[3J (scrollback erase). ESC[2J stripped outside sync blocks after startup grace period of 2. Device queries (DA1/DA2/DSR/CPR/DECRQM/Kitty keyboard) pass through for ConPTY handshake. OSC 2 titles sanitized. All hyperlinks pass through.
- [PT-18] Shutdown drain: drain_output command empties the channel (500ms deadline, 10ms intervals) before session destroy, preventing the background reader thread from blocking on a full channel.
  - Files: src-tauri/pty-patch/src/lib.rs:348, src/lib/ptyProcess.ts:170
- [PT-19] Sync block re-wrapping: completed sync blocks are re-wrapped with BSU/ESU before sending to xterm.js. Full-redraw blocks (`is_full_redraw: true`) replace ESC[2J with ESC[H ESC[J (cursor home + erase below). ESC[3J is conditionally emitted only when content newlines >= terminal rows (overflow prevention). `strip_clear_screen_into` uses memchr::memmem to efficiently remove all ESC[2J occurrences. Session tracks terminal rows via AtomicU16 (set in spawn, updated in resize).
  - Files: src-tauri/pty-patch/src/lib.rs:27, src-tauri/pty-patch/src/lib.rs:42
- [PT-20] Conditional scrollback clearing: ESC[3J is emitted only when full-redraw content exceeds terminal height (prevents scrollback duplication from overflow). When content fits the viewport, scrollback is preserved and scroll position is maintained. Frontend `flushWrites` detects scrollback clear (baseY shrinkage) and scrolls to bottom; detects unexpected viewport movement and restores absolute position. handleResize defers PTY resize for hidden tabs (visibility gate) in addition to the bgBuffer gate.
  - Files: src-tauri/pty-patch/src/lib.rs:42, src/hooks/useTerminal.ts:239, src/components/Terminal/TerminalPanel.tsx:380

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
  - Files: src/components/Terminal/TerminalPanel.tsx:411
- [RS-08] Auto-resume effect uses prevVisibleRef to detect hidden-to-visible transitions; only fires when tab becomes visible AND session is dead AND conversation is resumable; 150ms delay for render settling
  - Files: src/components/Terminal/TerminalPanel.tsx:456
- [RS-09] Terminal reset on respawn: writes ANSI RIS (\x1bc) to clear content and scrollback, then fit() to sync xterm.js dimensions before spawning new PTY
  - Files: src/components/Terminal/TerminalPanel.tsx:316, src/hooks/useTerminal.ts:386

## Session Switch

- [SS-01] Inspector detects session switches (plan-mode fork, `/resume`, compaction) via `sid` field change
- [SS-02] Same Bun process, same WebSocket — inspector automatically tracks the new session
- [SS-03] No JSONL file scanning or polling required

## Inspector

- [IN-01] Inspector port allocation and registry in `inspectorPort.ts`. Async `allocateInspectorPort()` probes OS via `check_port_available` IPC (Rust TcpListener::bind) and skips registry-held ports.
- [IN-02] `INSTALL_HOOK` JS expression in `inspectorHooks.ts`; wraps JSON.stringify to capture events into globalThis.__inspectorState. Polled every 250ms via POLL_STATE.
  - Files: src/lib/inspectorHooks.ts:27
- [IN-03] Subagent tracking: inspector detects Agent tool_use -> queues description -> matches with new session ID system event -> routes events to subagent entry
- [IN-04] Subagent conversation messages captured via POLL_STATE splice (sub.msgs.splice(0)) in a try/catch for-loop each poll cycle; messages accumulated in INSTALL_HOOK's subagent tracking and drained by the frontend poller
  - Files: src/lib/inspectorHooks.ts:748, src/hooks/useInspectorState.ts:190
- [IN-05] Stale subagent detection removed -- push-based architecture handles subagent lifecycle via real-time state events only
  - Files: src/hooks/useInspectorState.ts:156
- [IN-06] Dead subagent purge removed -- push-based architecture relies on real-time state transitions; idle subs remain visible until session ends
  - Files: src/hooks/useInspectorState.ts:156
- [IN-07] Inspector port allocator verifies each candidate port is free via `check_port_available` IPC (Rust TcpListener::bind on 127.0.0.1). Skips ports already in the registry. Throws if all 100 ports (6400-6499) are exhausted.
  - Files: src/lib/inspectorPort.ts:17, src-tauri/src/commands.rs:1914
- [IN-08] SubagentInspector tool block collapse: MessageBlock uses local useState for collapsed state; getToolPreview extracts first non-empty line (120 char cap). Parent computes lastToolIndex via reduce; only the last tool message auto-expands when subagent is active (not dead/idle). React key={i} ensures stable mounting.
  - Files: src/components/SubagentInspector/SubagentInspector.tsx:12, src/components/SubagentInspector/SubagentInspector.tsx:78
- [IN-09] choiceHint detection uses terminal buffer tail (last 15 lines from xterm.js) to find active Ink selectors via "> 1." + "2." pattern, replacing the previous lastText regex approach. getBufferTail reads only the last N lines for efficiency.
  - Files: src/hooks/useInspectorState.ts:147, src/lib/terminalRegistry.ts:30, src/hooks/useTerminal.ts:345

## Background Buffering

- [BF-01] Background tabs: PTY data buffered in `bgBufferRef`, flushed via `useLayoutEffect` on tab focus with `visibility:hidden` trick (event-driven callback reveals, no timer). O(1) rendering.
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
  - Files: src-tauri/src/commands.rs:1370, src-tauri/src/lib.rs:176
- [RC-12] Config files read/write: read_config_file and write_config_file handle settings JSON, CLAUDE.md (3 scopes), and agent files (3 scopes: user=~/.claude/agents/, project={wd}/.claude/agents/, local={wd}/.claude/local/agents/). list_agents takes scope param. Parent dirs auto-created on write.
  - Files: src-tauri/src/commands.rs:1758, src-tauri/src/commands.rs:1769
- [RC-13] kill_orphan_sessions: takes Vec<String> session IDs, finds processes by command line match (WMIC on Windows, pgrep on Unix), kills all without ancestry check (safe at startup since no live sessions exist yet). Returns count of killed processes
  - Files: src-tauri/src/commands.rs:1637, src/store/sessions.ts:90
- [RC-14] send_notification: Custom WinRT toast command bypassing Tauri notification plugin. Uses tauri-winrt-notification Toast with on_activated callback that emits notification-clicked event to frontend. Dev mode uses PowerShell app ID, production uses bundle identifier. spawn_blocking + CREATE_NO_WINDOW compliant.
  - Files: src-tauri/src/commands.rs:1836, src/hooks/useNotifications.ts:44
- [RC-15] drain_output -- drain channel before session destroy (spawn_blocking, 500ms deadline)
  - Files: src-tauri/pty-patch/src/lib.rs:348
- [RC-16] read_claude_binary(cli_path) resolves Claude Code binary through 5-step chain: .cmd shim parse -> direct CLI path -> sibling node_modules -> legacy versions dir -> npm root -g. Enables slash command/settings discovery on standalone installs.
  - Files: src-tauri/src/commands.rs:624
- [RC-17] search_session_content: async Rust command scanning JSONL files for substring matches. Walks ~/.claude/projects/, skips files >20MB, stops at 50 results, returns sessionId + 200-char snippet. Uses extract_message_text helper for full text extraction from user/assistant events.
  - Files: src-tauri/src/commands.rs:407, src-tauri/src/lib.rs:137
- [RC-18] Plugin management IPC: plugin_list (claude plugin list --available --json), plugin_install (--scope), plugin_uninstall, plugin_enable, plugin_disable. All async with spawn_blocking + CREATE_NO_WINDOW (via run_claude_cli helper). Raw JSON passthrough for plugin_list; string result for mutations.
  - Files: src-tauri/src/commands.rs:1879, src-tauri/src/lib.rs:167
- [RC-19] prune_worktree: runs `git worktree remove --force <path>` (always forced — dialog is the confirmation). Async with spawn_blocking + CREATE_NO_WINDOW. Takes worktree_path and project_root (cwd for git). Returns error string on failure.
  - Files: src-tauri/src/commands.rs:1877, src-tauri/src/lib.rs:168

## Config Implementation


- [CI-01] Config modal header uses CSS grid (1fr auto 1fr) instead of flexbox space-between, so tab row stays centered regardless of left (title) or right (project selector + close) content width.
  - Files: src/components/ConfigManager/ConfigManager.css:18, src/components/ConfigManager/ConfigManager.tsx:66
- [CI-02] formatScopePath() normalizes backslashes to forward slashes and abbreviates project-scope paths via abbreviatePath(). User-scope paths (~/...) pass through unchanged.
  - Files: src/lib/paths.ts:89
- [CI-03] Settings schema discovery uses 4-tier priority: (1) JSON Schema from schemastore.org fetched via Rust fetch_settings_schema command (reqwest, avoids CORS), cached in localStorage by CLI version; (2) CLI --help flag parsing; (3) Binary Zod regex scan; (4) Static field registry. parseJsonSchema() unwraps Zod anyOf optionals, maps JSON Schema types to SettingField types, extracts descriptions/enums. buildSettingsSchema() deduplicates across all tiers.
  - Files: src/lib/settingsSchema.ts:62, src-tauri/src/commands.rs:890, src/store/settings.ts:257

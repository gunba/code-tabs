# Feature Contract

Expected behaviors that MUST be preserved. **Agents: read this before modifying or removing code.** If you don't understand why code exists, check here first. Breaking these behaviors is a regression.

## Tab Bar

- Tabs are 62px tall with `box-sizing: border-box` — padding is included in height
- Launch (+) and Resume (↩) buttons are 62px x 62px square, flush with tab bottoms — no gap
- Native Windows dark-themed titlebar — `decorations: true` + `"theme": "Dark"` in tauri.conf.json, no custom window controls HTML
- No `-webkit-app-region` drag regions — native titlebar handles window dragging
- State dot colors: idle=green, thinking=clay pulse, toolUse=blue scale, waitingPermission=orange pulse, error=red, dead=muted, starting=muted pulse
- Non-active tabs flash green briefly when transitioning to idle from an active state
- Dead tabs dimmed (opacity 0.45), clickable to switch (overlay provides actions)
- Shift+click tab opens relaunch modal; unified blue top-bar + tint when Shift is held (active tab shows both clay bottom bar and blue top bar; permission-pulsing tabs pause animation)
- Tabs draggable for reorder via native drag-and-drop
- Right-click context menu: Rename, Copy Session ID, Copy Working Dir, Open in Explorer, Revive/Close

## Session Resume (JSONL Replay)

- Resumed sessions suppress ALL state/metadata store updates until Rust watcher emits `jsonl-caught-up`
- On caught-up: reset `inputTokens`, `outputTokens`, `costUsd`, `currentAction`, `currentToolName`, `subagentActivity` in **both** the store metadata AND the accumulator (`accRef.current`)
- Token/cost counters show only NEW conversation usage — not historical totals from the resumed session
- Interrupted sessions (replay ends in thinking/toolUse) force state to idle after caught-up
- Historical subagents suppressed during initial JSONL replay (not shown in subagent bar)
- First user message (`firstUserMessage`) preserved from replay for tab naming

## Activity Feed

- Shows only LIVE events from the current conversation
- Must NOT seed with persisted state on app startup
- Must NOT show historical events from resumed sessions — the accumulator reset on caught-up prevents stale values from leaking back into the store
- Shows detailed tool info (file paths, commands, patterns) — progress events do NOT overwrite with timers
- Driven by metadata fingerprint changes in Zustand store

## Dead Session Overlay & In-Tab Respawn

- Dead sessions show an overlay with Resume, Resume other, and New session buttons
- All actions respawn the PTY in the same tab — no new tab created, no old tab destroyed
- Resume button only shown if session has conversation (`session_has_conversation` check)
- Enter key on dead tab resumes same session; all other input swallowed
- Ctrl+R on dead tab opens resume picker targeting that tab (reuses tab via `requestRespawn`)
- ResumePicker detects active dead tab and respawns in place instead of creating new session
- `triggerRespawn` cleans up old PTY/watchers, resets JSONL accumulator, increments respawn counter
- Resume target chain: `resumeSession || sessionId || id` (chains through multiple respawns)
- Check JSONL file existence via `session_has_conversation`, not `assistantMessageCount`
- `resumeSession` and `continueSession` are one-shot flags — never persist in `lastConfig`
- Skip `--session-id` CLI arg when using `--resume` or `--continue`

## JSONL Session Switch Detection

- Detects when user uses `/resume` within Claude to switch conversations mid-session
- On `/resume` input: polls `find_active_jsonl_session` every 3s for 30s to find new JSONL file
- On conversation end: tries `find_continuation_session` first, falls back to `find_active_jsonl_session`
- `switchJsonlWatcher` stops old watcher, resets accumulator, starts new watcher
- Tab name picked up from matching dead tabs when switching to a previously-seen session

## Terminal Rendering

- xterm.js 6.0 with DEC 2026 synchronized output — prevents ink rendering flash on rapid writes
- WebGL renderer for performance, with context loss recovery (retry once after 1s, fallback to canvas)
- Visibility change handler: clears texture atlas and redraws on OS wake / tab restore (fixes GPU corruption after sleep)
- Hidden tabs use CSS `display: none` — never unmount/remount xterm.js (destroys state)
- Background tabs: PTY data buffered in `bgBufferRef`, flushed as single batched write on tab focus
- Dynamic scrollback: 5K default, grows to 10K on scroll-to-top, shrinks back at bottom
- Write batching: debounce at 4ms/50ms intervals

## PTY Management

- Use `tauri-pty` npm wrapper for PTY data — not raw Tauri event listeners
- Never pass `env: {}` to PTY spawn — omit `env` to inherit (empty object wipes environment)
- `CLAUDECODE` env var must not leak into spawned PTYs

## State Detection

- Primary source: JSONL events from Rust file watcher
- PTY output scan only for: idle prompt (❯) and permission prompt detection
- State is NEVER inferred from timers or arbitrary delays — only from real signals
- Permission prompts detected via regex on PTY output, only during toolUse/thinking states
- When JSONL gives definitive state (idle/thinking), clear permission buffer to prevent stale re-triggers

## Persistence

- Frontend-owned via `persist_sessions_json` — Rust session manager does NOT own persistence (metadata would be stale)
- `beforeunload` event flushes sessions so they survive app restart
- Debounced auto-persist every 2s on session array changes

## Session Launcher

- Modal for new session or resume — Ctrl+T opens fresh (clears resume/continue flags)
- Quick launch: Shift+click "+" or Ctrl+Shift+T uses saved defaults without showing modal; "+" button swaps to blue background when Shift is held
- Ctrl+R opens resume picker (browse past Claude sessions); cards show blue top-bar + tint when Shift is held
- CLI command pills sorted by usage frequency (same heat gradient as Command Bar)
- **CLI option pills**: flags from `claude --help` shown as clickable pills; flags with dedicated UI controls (model, permissions, effort, etc.) are excluded from the grid
- **Active flag indicators**: pills highlight with accent color when their flag is present in the command line (reactive to manual edits in textarea)
- **Toggle behavior**: clicking an active pill removes the flag; clicking an inactive pill adds it
- **Non-session flags** (`--version`, `--help`): rendered at start of grid with muted styling; selecting them changes Launch button to "Run" (blue) and removes the working directory requirement
- **Subcommand toggle**: clicking a subcommand replaces command line with `claude <cmd>`; clicking again resets to generated command

## Command Bar

- Slash command pills sorted by usage frequency, then alphabetically
- **Heat gradient**: pills show 4-tier visual heat (muted → accent) based on usage relative to most-used command
  - Level 0: default muted (unused), Level 1: 30% accent blend, Level 2: 65% accent blend, Level 3: full accent with tinted background
- **History bootstrap**: on first install, scans up to 200 recent JSONL files for slash command usage so heat map starts warm
- **Click** a pill → sends the command to the PTY immediately (records usage)
- **Shift+click** a pill → queues the command for auto-send when Claude becomes idle (records usage only when dispatched, not on queue)
- Queued command shows a pulsing indicator; clicking the same queued command again toggles it off
- Holding Shift shows unified blue top-bar + tint on non-queued pills (no animation); heat gradient suppressed while Shift is held; tooltips show queue hint
- Queue auto-clears when session dies

## Window

- Native Windows decorations with dark theme — no custom HTML titlebar or window control buttons
- App uses `decorations: true` and `"theme": "Dark"` in Tauri window config

# Feature Contract

Expected behaviors that MUST be preserved. **Agents: read this before modifying or removing code.** If you don't understand why code exists, check here first. Breaking these behaviors is a regression.

## Tab Bar

- Tabs are 62px tall with `box-sizing: border-box` — padding is included in height
- Launch (+) and Resume (↩) buttons are 62px x 62px square, flush with tab bottoms — no gap
- Native Windows dark-themed titlebar — `decorations: true` + `"theme": "Dark"` in tauri.conf.json, no custom window controls HTML
- No `-webkit-app-region` drag regions — native titlebar handles window dragging
- State dot colors: idle=green, thinking=clay pulse, toolUse=blue scale, waitingPermission=orange pulse, error=red, dead=muted, starting=muted pulse
- Non-active tabs flash green briefly when transitioning to idle from an active state
- Dead tabs dimmed (opacity 0.45), clickable to revive
- Shift+click tab opens relaunch modal; visual border hint when Shift is held
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
- Driven by metadata fingerprint changes in Zustand store

## Session Revival (Dead Tab Click)

- Create new session BEFORE closing old one — avoids visual flash/gap in tab bar
- Resume target chain: `resumeSession || sessionId || id` (chains through multiple revivals)
- Preserve color index and metadata (nodeSummary, tokens, assistantMessageCount) across revival
- Check JSONL file existence via `session_has_conversation`, not `assistantMessageCount`
- `resumeSession` and `continueSession` are one-shot flags — never persist in `lastConfig`
- Skip `--session-id` CLI arg when using `--resume` or `--continue`

## Terminal Rendering

- xterm.js 6.0 with DEC 2026 synchronized output — prevents ink rendering flash on rapid writes
- WebGL renderer for performance
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
- Quick launch: Shift+click "+" or Ctrl+Shift+T uses saved defaults without showing modal
- Ctrl+R opens resume picker (browse past Claude sessions)

## Window

- Native Windows decorations with dark theme — no custom HTML titlebar or window control buttons
- App uses `decorations: true` and `"theme": "Dark"` in Tauri window config

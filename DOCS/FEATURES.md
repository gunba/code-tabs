# Features

<!-- Codes: TB=Tab Bar, SR=Session Resume, DS=Dead Session, TR=Terminal, SL=Session Launcher, CB=Command Bar, HM=Hooks Manager, CM=Config Manager, TP=Thinking Panel, DP=Debug Panel, WN=Window, KB=Keyboard Shortcuts, MO=Modal Overlay -->

User-facing behaviors. Code implementing a tagged entry is not dead code.

## Tab Bar

- [TB-01] Tabs are 66px tall with `box-sizing: border-box` — padding is included in height
- [TB-02] Launch (+) and Resume (↩) and Config (⚙) buttons are 66px x 66px square, flush with tab bottoms — no gap
- [TB-03] Three distinct top-right buttons: Resume (blue tint + blue icon), Config (purple tint + purple icon), New (orange/accent bg)
- [TB-04] Native Windows dark-themed titlebar — `decorations: true` + `"theme": "Dark"` in tauri.conf.json, no custom window controls HTML
- [TB-05] No `-webkit-app-region` drag regions — native titlebar handles window dragging
- [TB-06] State dot colors: idle=green, thinking=clay pulse, toolUse=blue pulse, waitingPermission=orange pulse, error=red, dead=muted, starting=muted pulse, choice-pending=amber/gold pulse (idle + numbered choice detected)
- [TB-07] All dot pulse animations unified: `dot-pulse 2s ease infinite` with min opacity 0.5 (no separate scale animation)
- [TB-08] Tab meta text color-coded: model color matches type (Opus=purple, Sonnet=blue, Haiku=green), effort=clay, agents=purple; muted dot separators
- [TB-09] F2 hotkey renames the active tab (universal rename shortcut)
- [TB-10] Non-active tabs flash green for 5s when transitioning to idle from an active state; hovering or clicking dismisses early
- [TB-11] Dead tabs dimmed (opacity 0.45), clickable to switch (overlay provides actions)
- [TB-12] Ctrl+Click tab opens relaunch modal; blue top-bar + tint when Ctrl is held
- [TB-13] Tabs preferred at 200px, shrink to 90px min-width before scrolling; CSS ellipsis handles name truncation
- [TB-14] Tabs draggable for reorder via native drag-and-drop
- [TB-15] Tab rename: action buttons hidden during edit (`:has(.tab-name-input)`); summary/meta lines remain visible during rename
- [TB-16] Right-click context menu: Rename, Copy Session ID, Copy Working Dir, Open in Explorer, Open Inspector / Copy Inspector URL / Reconnect Inspector (live sessions only), Revive/Close
- [TB-17] Open Inspector: opens `https://debug.bun.sh/#HOST:PORT/PATH` in the default browser, disconnects the internal WebSocket, and marks session as inspector-off (hollow tab dot, status bar indicator)
- [TB-18] Copy Inspector URL: copies the inspector URL to clipboard without disconnecting the internal WebSocket
- [TB-19] Reconnect Inspector: re-establishes the internal WebSocket after closing the external debugger; only shown when inspector is disconnected
- [TB-20] Inspector-off visual feedback: tab dot becomes hollow (transparent with inset border, no animation) when inspector is manually disconnected; status bar shows muted "◌ Inspector off" label with reconnect hint in tooltip
- [TB-21] Inspector-off state cleared on session respawn

## Session Resume

- [SR-01] Resumed sessions show loading spinner until inspector connects (~1s) and confirms session is responsive
- [SR-02] Token/cost counters show only NEW conversation usage (inspector starts accumulating from connection time)
- [SR-03] First user message captured by inspector's `firstMsg` field for tab naming
- [SR-04] Subagent card colors: plain `--bg-surface` base; active cards get `--bg-surface-hover` + clay border-left accent; idle at 0.5 opacity; icon uses `--accent` (warm clay)
- [SR-05] Nested subagents supported via session ID stack

## Dead Session Overlay

- [DS-01] Dead sessions show an overlay with Resume, Resume other, and New session buttons
- [DS-02] All actions respawn the PTY in the same tab — no new tab created, no old tab destroyed
- [DS-03] Resume button only shown if session has conversation (derived from `nodeSummary` or `resumeSession` — no JSONL check)
- [DS-04] Enter key on dead tab resumes same session; all other input swallowed
- [DS-05] Ctrl+R on dead tab opens resume picker targeting that tab (reuses tab via `requestRespawn`)
- [DS-06] ResumePicker detects active dead tab and respawns in place instead of creating new session
- [DS-07] Session-in-use auto-recovery: own orphans killed automatically and resume retries; external processes show "Session in use externally" overlay with "Kill and resume" / "Cancel" — never killed without user confirmation

## Terminal

- [TR-01] Scroll-to-top button appears at top-right when scrolled down; scroll-to-bottom button at bottom-right when scrolled up
- [TR-02] Per-session token badge: semi-transparent overlay (top-left of terminal) showing session token count; tooltip shows input/output breakdown; hidden when dead or zero tokens
- [TR-03] Clear input button uses standard backspace icon (pointed rectangle with X); Lucide/Feather style
- [TR-04] Ctrl+Home scrolls to top, Ctrl+End scrolls to bottom
- [TR-05] Hidden tabs use CSS `display: none` — never unmount/remount xterm.js (destroys state)
- [TR-06] Fixed 100K scrollback buffer — no dynamic resizing
- [TR-07] Vertical button bar (28px): permanent right-side column with scroll-to-top, scroll-to-last-message, clear input, clear all input, queue input, and scroll-to-bottom. Replaces absolute-positioned overlay buttons. Visibility-toggled (not removed) to prevent layout shift.
  - Files: src/components/Terminal/TerminalPanel.tsx:569, src/components/Terminal/TerminalPanel.css:77
- [TR-08] Scroll to last user message: scans buffer backwards for prompt marker (❯), accessible via button bar and Ctrl+middle-click on terminal
  - Files: src/hooks/useTerminal.ts:249, src/components/Terminal/TerminalPanel.tsx:555
- [TR-09] Ctrl+wheel scrolls by page (not line); uses xterm.js 6 attachCustomWheelEventHandler
  - Files: src/hooks/useTerminal.ts:78

## Session Launcher

- [SL-01] Modal for new session or resume — Ctrl+T opens fresh (clears resume/continue flags)
- [SL-02] Quick launch: Ctrl+Click "+" or Ctrl+Shift+T instantly launches without showing modal; uses saved defaults if set, otherwise falls back to last-used config (including folder)
- [SL-03] Ctrl+R opens resume picker (browse past Claude sessions); 660px modal, 520px list max-height; cards show blue top-bar + tint when Ctrl is held
- [SL-04] Resume picker enriched data: each session card shows firstMessage, lastMessage (from tail scan), model badge (short label like "Sonnet 4"), and file size
- [SL-05] Chain grouping: sessions linked by `parentId` (plan-mode forks) grouped under parent with left accent border + 16px indent; max 3 visible children per chain with "+N more" expander
- [SL-06] Custom names: tab renames persist in `sessionNames` map (localStorage); shown as bold primary name with directory as secondary text in resume picker
- [SL-07] Config caching: session configs cached in `sessionConfigs` map (localStorage) when inspector connects; used as fallback when resuming sessions not in the dead tab map
- [SL-08] Config pruning: both `sessionNames` and `sessionConfigs` maps pruned to only IDs present in loaded past sessions
- [SL-09] Config restore: SessionLauncher spreads all `lastConfig` fields (not just 8), clearing only one-shot fields (`continueSession`, `sessionId`, `runMode`)
- [SL-10] CLI command pills sorted by usage frequency (same heat gradient as Command Bar)
- [SL-11] CLI option pills: flags from `claude --help` shown as clickable pills; flags with dedicated UI controls (model, permissions, effort, etc.) are excluded from the grid
- [SL-12] Active flag indicators: pills highlight with accent color when their flag is present in the command line (reactive to manual edits in textarea)
- [SL-13] Toggle behavior: clicking an active pill removes the flag; clicking an inactive pill adds it
- [SL-14] Non-session flags (`--version`, `--help`, `--print`, etc.): rendered in separate Utility Commands section (collapsed by default) with muted styling; selecting them changes Launch button to "Run" (blue) and removes the working directory requirement
- [SL-15] Utility mode mutual exclusion: clicking a non-session flag or subcommand replaces the entire command line (not toggle-into); session controls disabled and dimmed; clicking the flag again restores; reset button (↺) escapes utility mode
- [SL-16] Subcommand toggle: clicking a subcommand replaces command line with `claude <cmd>`; clicking again resets to generated command

## Command Bar

- [CB-01] Slash command pills sorted by usage frequency, then alphabetically
- [CB-02] Heat gradient: pills show 4-tier visual heat (muted -> accent) based on usage relative to most-used command
  - Level 0: default muted (unused), Level 1: 30% accent blend, Level 2: 65% accent blend, Level 3: full accent with tinted background
- [CB-03] History bootstrap: on first install, scans up to 200 recent JSONL files for slash command usage so heat map starts warm
- [CB-04] Click a pill sends the command to the PTY immediately (records usage)
- [CB-05] Ctrl+Click a pill queues the command for auto-send when Claude becomes idle (records usage only when dispatched, not on queue)
- [CB-06] Queued command shows a pulsing indicator; clicking the same queued command again toggles it off
- [CB-07] Holding Ctrl shows blue border on non-queued pills; heat gradient suppressed while Ctrl is held; tooltips show queue hint
- [CB-08] Queue auto-clears when session dies

## Hooks Manager

- [HM-01] Three scopes: User (`~/.claude/settings.json`), Project (`.claude/settings.json`), Project Local (`.claude/settings.local.json`)
- [HM-02] Scope separation: Rust backend returns distinct keys per scope — project and project-local hooks never conflated
- [HM-03] Non-destructive saves: merges hooks into existing settings file (preserves other keys like `permissions`)
- [HM-04] Edit preserves unknown fields: editing a hook spreads the original entry before applying form values, so fields added by future CLI versions are not stripped
- [HM-05] Custom events: event dropdown includes a "Custom event..." option with freeform text input, so users aren't locked to the hardcoded event list
- [HM-06] Existing hooks with unknown event names (from file) are displayed and editable
- [HM-07] Status bar hook count reflects actual hook entries (sums `hooks[]` within each `MatcherGroup`), not matcher group count
- [HM-08] StatusBar total tokens: when >1 non-dead session exists, shows `Σ` total token count across all active sessions in the right section
- [HM-09] Three hook types supported: `command`, `prompt`, `agent`

## Config Manager

- [CM-01] Opens via `Ctrl+,` or cogwheel (⚙) in tab bar; wide modal (92vw, max 1400px, 88vh)
- [CM-02] Five header tabs: Settings / CLAUDE.md / Hooks / Plugins / Agents — each with icon
- [CM-03] Project dir selector shown when multiple project dirs exist; defaults to active session's working dir
- [CM-04] Keystrokes blocked via shared ModalOverlay component (`onKeyDown` stopPropagation); Escape and `Ctrl+,` pass through to global handler
- [CM-05] Settings/CLAUDE.md/Hooks/Plugins tabs use ThreePaneEditor: 3-column grid showing User/Project/Local scopes side by side with color-coded borders and tinted headers
- [CM-06] Per-scope raw JSON settings editor (SettingsPane) and CLAUDE.md editor (MarkdownPane) with own dirty tracking and Save per pane. Tab key inserts 2 spaces in markdown.
- [CM-07] Agent editor: self-contained tab with agent pills at top, editor below
  - Lists `.claude/agents/*.md` files, create new, edit body, delete
  - New agent template includes model frontmatter
- [CM-08] Save via Rust `read_config_file`/`write_config_file` commands (JSON validated before write, parent dirs auto-created)
- [CM-09] Escape closes modal; clicking overlay closes modal
- [CM-10] Settings schema cached in localStorage (`binarySettingsSchema`) to avoid re-scanning on every startup
- [CM-11] Wide modal (92vw, max 1400px, 88vh) with 5 tabs: Settings, CLAUDE.md, Hooks, Plugins, Agents. Store value controls which tab opens.
  - Files: src/components/ConfigManager/ConfigManager.tsx:18, src/store/settings.ts:49
- [CM-12] ThreePaneEditor: Settings/CLAUDE.md/Hooks/Plugins tabs use 3-column grid showing User/Project/Local scopes side by side. Color coded: User=clay, Project=blue, Local=purple (left border + tinted header).
  - Files: src/components/ConfigManager/ThreePaneEditor.tsx:1, src/components/ConfigManager/ConfigManager.css:75
- [CM-13] SettingsPane: raw JSON textarea per scope with own dirty tracking and Save button. Ctrl+S to save. Replaces schema-driven form (settingsSchema.ts retained for future re-introduction).
  - Files: src/components/ConfigManager/SettingsPane.tsx:1
- [CM-14] MarkdownPane: per-scope CLAUDE.md textarea. Tab key inserts 2 spaces. Scope-to-fileType mapping: user=claudemd-user, project=claudemd-root, project-local=claudemd-dotclaude.
  - Files: src/components/ConfigManager/MarkdownPane.tsx:1
- [CM-15] HooksPane: per-scope CRUD absorbed from standalone HooksManager. Hook cards, inline Add/Edit form. Scope is a prop, not a dropdown. Calls bumpHookChange() after save.
  - Files: src/components/ConfigManager/HooksPane.tsx:1
- [CM-16] PluginsPane: per-scope enabledPlugins (tag/pill list with add/remove) + mcpServers (cards showing name, command, args, env). Reads/writes full settings JSON.
  - Files: src/components/ConfigManager/PluginsPane.tsx:1
- [CM-17] StatusBar hooks button opens config manager directly to Hooks tab. Store: showConfigManager is string|false (tab name or closed), replacing old boolean + separate showHooksManager.
  - Files: src/components/StatusBar/StatusBar.tsx:143, src/store/settings.ts:49

## Thinking Panel

- [TP-01] Collapsible right-side panel (350px fixed, 250px min, 50% max) showing Claude's extended thinking blocks
- [TP-02] Toggle via `Ctrl+I` keyboard shortcut or "Thinking" button in status bar right section
- [TP-03] Renders as flex sibling of `terminal-area` — shrinks terminal horizontally (not an overlay); ResizeObserver auto-fires `fit()` on width change
- [TP-04] Captures `type === 'thinking'` and `type === 'redacted_thinking'` content blocks via inspector JSON.stringify interception
- [TP-05] Thinking text truncated at 10K chars per block in inspector; ring buffer capped at 30 in inspector, 50 per session in store
- [TP-06] Long blocks (>500 chars) collapsed by default with "[show more]" toggle
- [TP-07] Redacted thinking blocks shown as muted italic `[redacted thinking]` placeholder
- [TP-08] Auto-scrolls to bottom on new blocks (same pattern as SubagentInspector)
- [TP-09] Relative timestamps refreshed every 10s
- [TP-10] Escape dismisses panel (checked before config/hooks/resume in Escape chain)
- [TP-11] Not persisted — resets to closed on app restart (follows hooks/config manager pattern)
- [TP-12] Thinking blocks cleared on respawn (`clearThinkingBlocks` in `triggerRespawn`) and session close (Map entry deleted in `closeSession`)

## Debug Panel

- [DP-01] Collapsible right-side panel (350px fixed, 250px min, 50% max) following ThinkingPanel pattern
- [DP-02] Toggle via `Ctrl+Shift+D` keyboard shortcut or "Toggle Debug Log" in command palette
- [DP-03] Captures ALL `console.log`, `console.warn`, `console.error` with `[HH:MM:SS.mmm] [LOG|WARN|ERR]` prefix
- [DP-04] Buffer size: 500 entries (ring buffer, oldest evicted first)
- [DP-05] Polls `globalThis.__consoleLogs` every 500ms
- [DP-06] Filter input for searching/filtering log entries
- [DP-07] Auto-scrolls to bottom on new entries (pauses if user scrolls up)
- [DP-08] Copy button copies all visible (filtered) logs to clipboard; Clear button empties buffer
- [DP-09] Color-coded by severity: LOG=default, WARN=`--warning`, ERR=`--error`
- [DP-10] Monospace font, 10px
- [DP-11] Escape dismisses panel (checked before ThinkingPanel in Escape chain)
- [DP-12] Strategic logging at key points: PTY spawn/kill/exit, TerminalPanel kill/respawn/exit, inspector connect/disconnect/state changes

## Window

- [WN-01] Native Windows decorations with dark theme — no custom HTML titlebar or window control buttons
- [WN-02] App uses `decorations: true` and `"theme": "Dark"` in Tauri window config

## Keyboard Shortcuts

- [KB-01] Ctrl+T — New session
- [KB-02] Ctrl+W — Close active tab
- [KB-03] Ctrl+R — Resume from history
- [KB-04] Ctrl+Tab / Ctrl+Shift+Tab — Cycle tabs
- [KB-05] Alt+1-9 — Jump to tab N
- [KB-06] Ctrl+K — Command palette
- [KB-07] Ctrl+Shift+U — Clear all input lines
- [KB-08] Ctrl+, — Open Config Manager
- [KB-09] Esc — Close modal / dismiss inspector (ordered: contextMenu -> palette -> debug -> thinking -> config -> resume -> launcher -> inspector)
- [KB-10] Alt+1-9 blocked from PTY (return false in attachCustomKeyEventHandler) -- handled by App.tsx global tab-switch handler without escape code artifacts
  - Files: src/hooks/useTerminal.ts:73

## Modal Overlay


- [MO-01] Shared modal wrapper: fixed overlay, inset 0, z-index 100, backdrop-filter blur(4px). Blocks all keystrokes except Escape and Ctrl+comma via stopPropagation. Backdrop click calls onClose.
  - Files: src/components/ModalOverlay/ModalOverlay.tsx:1, src/components/ModalOverlay/ModalOverlay.css:1
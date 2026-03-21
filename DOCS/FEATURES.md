# Features

<!-- Codes: TB=Tab Bar, SR=Session Resume, DS=Dead Session, TR=Terminal, SL=Session Launcher, CB=Command Bar, HM=Hooks Manager, CM=Config Manager, TP=Thinking Panel, DP=Debug Panel, WN=Window, KB=Keyboard Shortcuts, MO=Modal Overlay -->

User-facing behaviors. Code implementing a tagged entry is not dead code.

## Tab Bar

- [TB-01] Tabs are 66px tall with `box-sizing: border-box` — padding is included in height
- [TB-02] Launch (+) and Resume (↩) and Config (⚙) buttons are 66px x 66px square, flush with tab bottoms — no gap
- [TB-03] Three distinct top-right buttons: Resume (blue tint + blue icon), Config (purple tint + purple icon), New (orange/accent bg)
- [TB-04] Native Windows dark-themed titlebar — `decorations: true` + `"theme": "Dark"` in tauri.conf.json, no custom window controls HTML
- [TB-05] No `-webkit-app-region` drag regions — native titlebar handles window dragging
- [TB-06] State dot colors: idle=green, thinking=clay pulse, toolUse=blue pulse, actionNeeded=purple pulse, waitingPermission=orange pulse, error=red, dead=muted, starting=muted pulse
- [TB-07] All dot pulse animations unified: `dot-pulse 2s ease infinite` with min opacity 0.5 (no separate scale animation)
- [TB-08] Tab meta text color-coded: model color matches type (Opus=orange, Sonnet=purple, Haiku=blue via hardcoded hex), effort=clay, agents=muted text-secondary; dot separators
  - Files: src/App.tsx:296, src/lib/claude.ts:25
- [TB-09] Ctrl+E renames the active tab (inline input, Enter to confirm, Esc to cancel)
  - Files: src/App.tsx:247
- [TB-10] Non-active tabs flash green for 5s when transitioning to idle from an active state; hovering or clicking dismisses early
- [TB-11] Dead tabs dimmed (opacity 0.45), clickable to switch (overlay provides actions)
- [TB-12] Ctrl+Click tab opens relaunch modal; blue top-bar + tint when Ctrl is held
- [TB-13] Tabs preferred at 200px, shrink to 90px min-width before scrolling; CSS ellipsis handles name truncation
- [TB-14] Tabs draggable for reorder via native drag-and-drop; constrained to same workspace group
- [TB-15] Tab rename: action buttons hidden during edit (`:has(.tab-name-input)`); summary/meta lines remain visible during rename
- [TB-16] Right-click context menu: Rename, Copy Session ID, Copy Working Dir, Open in Explorer, Open Inspector / Copy Inspector URL / Reconnect Inspector (live sessions only), Revive/Close
- [TB-17] Open Inspector: opens `https://debug.bun.sh/#HOST:PORT/PATH` in the default browser, disconnects the internal WebSocket, and marks session as inspector-off (hollow tab dot, status bar indicator)
- [TB-18] Copy Inspector URL: copies the inspector URL to clipboard without disconnecting the internal WebSocket
- [TB-19] Reconnect Inspector: re-establishes the internal WebSocket after closing the external debugger; only shown when inspector is disconnected
- [TB-20] Inspector-off visual feedback: tab dot becomes hollow (transparent with inset border, no animation) when inspector is manually disconnected; status bar shows muted "◌ Inspector off" label with reconnect hint in tooltip
- [TB-21] Inspector-off state cleared on session respawn
- [TB-22] All tab bar icons (rename, kill, close, resume, config, subagent arrow) are inline SVG components — no platform-dependent emoji
  - Files: src/App.tsx:28, src/components/Icons/Icons.tsx:1
- [TB-23] Tab grouping by workspace directory: tabs with the same workingDir are visually grouped with uppercase folder-label separators between groups. Multi-tab groups show hover-visible left/right arrow buttons (‹/›) for reorder within group. Drag-and-drop constrained to same group.
  - Files: src/App.tsx:272, src/App.tsx:291, src/App.css:388
- [TB-24] actionNeeded state: purple pulsing dot (--accent-tertiary) for ExitPlanMode approval and numbered choice questions; active tab gets pulsing purple underline; supersedes old choice-pending amber styling
  - Files: src/App.css:127, src/App.css:157, src/App.tsx:316, src/App.tsx:384
- [TB-25] actionNeeded notification: background sessions entering actionNeeded state trigger 'Action Needed' / 'A session needs your input.' desktop notification (same cooldown as other states)
  - Files: src/hooks/useNotifications.ts:90

## Session Resume

- [SR-01] Resumed sessions show loading spinner until inspector connects (~1s) and confirms session is responsive
- [SR-02] Token/cost counters show only NEW conversation usage (inspector starts accumulating from connection time)
- [SR-03] First user message captured by inspector's `firstMsg` field for tab naming
- [SR-04] Subagent card colors: plain `--bg-surface` base; active cards get `--bg-surface-hover` + clay border-left accent; idle at 0.5 opacity; icon uses `--accent` (warm clay)
- [SR-05] Nested subagents supported via agentId-based routing (each event tagged with agentId, parentSessionId tracked per subagent)

## Dead Session Overlay

- [DS-01] Dead sessions show an overlay with Resume, Resume other, and New session buttons
- [DS-02] All actions respawn the PTY in the same tab — no new tab created, no old tab destroyed
- [DS-03] Resume button only shown if session has conversation (derived from `nodeSummary` or `resumeSession` — no JSONL check)
- [DS-04] Enter key on dead tab resumes same session; all other input swallowed
- [DS-05] Ctrl+Shift+R on dead tab opens resume picker targeting that tab (reuses tab via `requestRespawn`); dead overlay hint shows Ctrl+R for the "Resume other..." button
  - Files: src/components/Terminal/TerminalPanel.tsx:65, src/components/ResumePicker/ResumePicker.tsx:250, src/App.tsx:200
- [DS-06] ResumePicker detects active dead tab and respawns in place instead of creating new session
- [DS-07] Session-in-use auto-recovery: own orphans killed automatically and resume retries; external processes show "Session in use externally" overlay with "Kill and resume" / "Cancel" — never killed without user confirmation
- [DS-08] Proactive orphan cleanup on startup: init() collects all persisted session IDs, calls kill_orphan_sessions to kill leftover CLI processes before any PTY spawning. Prevents 'session ID already in use' and port conflicts on app restart after crash/force-close
  - Files: src/store/sessions.ts:83

## Terminal

- [TR-01] Scroll-to-top button appears at top-right when scrolled down; scroll-to-bottom button at bottom-right when scrolled up
- [TR-02] Per-session token badge: semi-transparent overlay (top-left of terminal) showing session token count; tooltip shows input/output breakdown; hidden when dead or zero tokens
- [TR-03] Clear input button uses standard backspace icon (pointed rectangle with X); Lucide/Feather style
- [TR-04] Ctrl+Home scrolls to top, Ctrl+End scrolls to bottom
- [TR-05] Hidden tabs use CSS `display: none` — never unmount/remount xterm.js (destroys state)
- [TR-06] Fixed 100K scrollback buffer — no dynamic resizing
- [TR-07] Vertical button bar (28px): permanent right-side column with scroll-to-top, scroll-to-last-message, queue input, clear input, clear all input, thinking toggle, and scroll-to-bottom. Visibility-toggled (not removed) to prevent layout shift.
  - Files: src/components/Terminal/TerminalPanel.tsx:609
- [TR-08] Scroll to last user message: uses xterm.js buffer markers registered on user Enter presses (not prompt scanning), accessible via button bar and Ctrl+middle-click on terminal (capture phase listener)
  - Files: src/hooks/useTerminal.ts:283, src/components/Terminal/TerminalPanel.tsx:566
- [TR-09] Ctrl+wheel snaps to top/bottom; requires zoomHotkeysEnabled: false in tauri.conf.json to prevent WebView2 zoom interception
  - Files: src/hooks/useTerminal.ts:82, src-tauri/tauri.conf.json
- [TR-10] fit() deferred on tab switch via double requestAnimationFrame — waits for browser layout reflow before sizing, prevents tiny-terminal bug. Cancels on rapid tab switching.
  - Files: src/components/Terminal/TerminalPanel.tsx:435

## Session Launcher

- [SL-01] Modal for new session or resume — Ctrl+T opens fresh (clears resume/continue flags)
- [SL-02] Quick launch: Ctrl+Click "+" or Ctrl+Shift+T instantly launches without showing modal; uses saved defaults if set, otherwise falls back to last-used config (including folder)
- [SL-03] Ctrl+R opens resume picker (browse past Claude sessions); 660px modal, 520px list max-height; cards show blue top-bar + tint when Ctrl is held; resume banner uses orange accent (not blue)
  - Files: src/components/SessionLauncher/SessionLauncher.css:402
- [SL-04] Resume picker enriched data: each session card shows firstMessage, lastMessage (from tail scan), settings badges (model, skip-perms, permission mode, effort, agent), and file size
  - Files: src/components/ResumePicker/ResumePicker.tsx:364
- [SL-05] Chain merging: sessions linked by parentId merged into a single card — latest session used for resume, names resolved from any member, suppressed plan-mode artifact messages skipped, sizes summed; stacked box-shadow when chainLength > 1
  - Files: src/components/ResumePicker/ResumePicker.tsx:155
- [SL-06] Custom names: tab renames persist in `sessionNames` map (localStorage); shown as bold primary name with directory as secondary text in resume picker
- [SL-07] Config caching: session configs cached in sessionConfigs map (localStorage) when inspector connects (model, permissionMode, dangerouslySkipPermissions, effort, agent, maxBudget, runMode); used as fallback when resuming sessions not in the dead tab map
  - Files: src/store/settings.ts:201
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
- [CB-03] History bootstrap: on each launch, scans up to 200 recent JSONL files for slash command usage so heat map stays warm
- [CB-04] Click a pill sends the command to the PTY immediately (records usage)
- [CB-05] Ctrl+Click a pill queues the command for auto-send when Claude becomes idle (records usage only when dispatched, not on queue)
- [CB-06] Queued command shows a pulsing indicator; clicking the same queued command again toggles it off
- [CB-07] Holding Ctrl shows blue border on non-queued pills; heat gradient suppressed while Ctrl is held; tooltips show queue hint
- [CB-08] Queue auto-clears when session dies
- [CB-09] Command history strip: horizontal scrollable row above command pills showing per-session command execution history (newest left). Clicking a history pill re-sends that command. Strip only visible when history exists. Per-session -- switching tabs shows different history. Cleaned up on session close.
  - Files: src/components/CommandBar/CommandBar.tsx:95, src/store/sessions.ts:306

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
- [HM-10] All status bar icons (context, tokens, clock, budget, warning, hooks, sessions, permissions) are inline SVG components — no emoji. Greek sigma kept as text.
  - Files: src/components/StatusBar/StatusBar.tsx:8

## Config Manager

- [CM-01] Config modal header uses CSS grid (auto 1fr auto) instead of flexbox space-between, so tab row stays centered regardless of left (title) or right (project selector + close) content width.
  - Files: src/components/ConfigManager/ConfigManager.css:20, src/components/ConfigManager/ConfigManager.tsx:67
- [CM-02] Five header tabs: Settings / Claude / Hooks / Plugins / Agents — each with icon
- [CM-03] Project dir selector shown when multiple project dirs exist; defaults to active session's working dir
- [CM-04] Keystrokes blocked via shared ModalOverlay component (`onKeyDown` stopPropagation); Escape and `Ctrl+,` pass through to global handler
- [CM-05] All five content tabs (Settings/Claude/Hooks/Plugins/Agents) use ThreePaneEditor: 3-column grid showing User/Project/Local scopes side by side with color-coded borders and tinted headers.
  - Files: src/components/ConfigManager/ConfigManager.tsx:103
- [CM-06] Per-scope raw JSON settings editor (SettingsPane) and CLAUDE.md editor (MarkdownPane) with own dirty tracking and Save per pane. Tab key inserts 2 spaces in markdown.
- [CM-07] Agent editor: scoped via ThreePaneEditor (user/project/local) with agent pills at top, editor below. User scope scans ~/.claude/agents/, project scans {wd}/.claude/agents/, local scans {wd}/.claude/local/agents/. Create, edit, delete per scope.
  - Files: src/components/ConfigManager/AgentEditor.tsx:6, src/components/ConfigManager/ConfigManager.tsx:116
- [CM-08] Save via Rust `read_config_file`/`write_config_file` commands (JSON validated before write, parent dirs auto-created)
- [CM-09] Escape closes modal; clicking overlay closes modal
- [CM-10] Settings schema cached in localStorage (`binarySettingsSchema`) to avoid re-scanning on every startup
- [CM-11] Wide modal (96vw, max 1900px, 88vh) with 5 tabs: Settings, Claude, Hooks, Plugins, Agents. Store value controls which tab opens.
- [CM-12] ThreePaneEditor: Settings/CLAUDE.md/Hooks/Plugins tabs use 3-column grid showing User/Project/Local scopes side by side. Color coded: User=clay, Project=blue, Local=purple (left border + tinted header).
  - Files: src/components/ConfigManager/ThreePaneEditor.tsx:1, src/components/ConfigManager/ConfigManager.css:133
- [CM-13] SettingsPane: JSON textarea with syntax highlighting overlay (pre behind transparent textarea). Keys=clay, strings=blue, numbers/bools=purple. Scroll synced between layers. Ctrl+S to save.
  - Files: src/components/ConfigManager/SettingsPane.tsx:8, src/components/ConfigManager/ConfigManager.css:866
- [CM-14] MarkdownPane: per-scope CLAUDE.md textarea. Tab key inserts 2 spaces. Scope-to-fileType mapping: user=claudemd-user, project=claudemd-root, project-local=claudemd-dotclaude.
  - Files: src/components/ConfigManager/MarkdownPane.tsx:1
- [CM-15] HooksPane: per-scope CRUD absorbed from standalone HooksManager. Hook cards, inline Add/Edit form. Scope is a prop, not a dropdown. Calls bumpHookChange() after save.
  - Files: src/components/ConfigManager/HooksPane.tsx:1
- [CM-16] PluginsPane: enabledPlugins stored as Record<string,boolean> (Claude Code native format). Array format auto-normalized on load. Tags show enabled/disabled state (click to toggle, x to remove). Disabled plugins: dimmed with strikethrough. mcpServers shown as cards.
  - Files: src/components/ConfigManager/PluginsPane.tsx:14, src/components/ConfigManager/ConfigManager.css:555
- [CM-17] StatusBar hooks button opens config manager directly to Hooks tab. Store: showConfigManager is string|false (tab name or closed), replacing old boolean + separate showHooksManager.
  - Files: src/components/StatusBar/StatusBar.tsx:139, src/store/settings.ts:49
- [CM-18] Config tabs use inline SVG icons (gear, document, hook, puzzle, bot) instead of emoji — monochrome, consistent cross-platform
  - Files: src/components/ConfigManager/ConfigManager.tsx:17
- [CM-19] ThreePaneEditor compact mode: Hooks and Plugins tabs pass compact prop, constraining grid to max-width 1300px centered. Settings, CLAUDE.md, and Agents fill full modal width (up to 1900px) for wider text editing.
  - Files: src/components/ConfigManager/ThreePaneEditor.tsx:16, src/components/ConfigManager/ConfigManager.tsx:109, src/components/ConfigManager/ConfigManager.css:140
- [CM-20] Tab label reads "Claude" instead of "CLAUDE.md" for the markdown editor tab.
  - Files: src/components/ConfigManager/ConfigManager.tsx:19
- [CM-21] Compact modal: Hooks/Plugins tabs apply config-modal-compact class (max-width 1400px) to the ModalOverlay, narrowing the entire modal — not just the grid. Settings/Claude/Agents remain at full 1900px width.
  - Files: src/components/ConfigManager/ConfigManager.tsx:63, src/components/ConfigManager/ConfigManager.css:13
- [CM-22] ThreePaneEditor scope headers show actual file paths per tab (e.g. ~/.claude/settings.json, {dir}/CLAUDE.md, {dir}/.claude/agents/) instead of generic directory stubs. Paths normalized to forward slashes via formatScopePath().
  - Files: src/components/ConfigManager/ThreePaneEditor.tsx:21, src/lib/paths.ts:40
- [CM-23] MarkdownPane preview toggle: footer has Preview/Edit button (left-aligned via margin-right:auto). Preview mode renders markdown via ReactMarkdown with dark-themed styles for headings, code, tables, blockquotes, lists, and links.
  - Files: src/components/ConfigManager/MarkdownPane.tsx:61, src/components/ConfigManager/ConfigManager.css:908

## Thinking Panel

- [TP-01] Collapsible right-side panel (350px fixed, 250px min, 50% max) showing Claude's extended thinking blocks
- [TP-02] Toggle via Ctrl+I keyboard shortcut or thought-bubble button in terminal button bar (purple active state, dot badge when blocks exist)
  - Files: src/components/Terminal/TerminalPanel.tsx:674
- [TP-03] Renders as flex sibling of `terminal-area` — shrinks terminal horizontally (not an overlay); ResizeObserver auto-fires `fit()` on width change
- [TP-04] Captures thinking via JSON.parse SSE interception: hooks `content_block_start` (thinking/redacted_thinking), accumulates `thinking_delta` events, finalizes on `content_block_stop`
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
- [WN-03] Desktop notifications for background sessions (response complete, permission needed, error). Clicking toast switches to target tab and focuses window. Rate-limited to 1 per session per 30s. Uses custom Rust WinRT toast with on_activated callback instead of Tauri notification plugin (which lacks desktop click support).
  - Files: src/hooks/useNotifications.ts:1

## Keyboard Shortcuts

- [KB-01] Ctrl+T — New session
- [KB-02] Ctrl+W — Close active tab
- [KB-03] Ctrl+Shift+R — Resume from history
  - Files: src/App.tsx:199
- [KB-04] Ctrl+Tab / Ctrl+Shift+Tab — Cycle tabs
- [KB-05] Alt+1-9 — Jump to tab N
- [KB-06] Ctrl+K — Command palette
- [KB-07] Ctrl+Shift+U — Clear all input lines
- [KB-08] Ctrl+, — Open Config Manager
- [KB-09] Esc — Close modal / dismiss inspector (ordered: contextMenu -> palette -> debug -> thinking -> config -> resume -> launcher -> inspector)
- [KB-10] Alt+1-9 blocked from PTY (return false in attachCustomKeyEventHandler) -- handled by App.tsx global tab-switch handler without escape code artifacts
  - Files: src/hooks/useTerminal.ts:74

## Modal Overlay


- [MO-01] Shared modal wrapper: fixed overlay, inset 0, z-index 100, backdrop-filter blur(4px). Blocks all keystrokes except Escape and Ctrl+comma via stopPropagation. Backdrop click calls onClose.
  - Files: src/components/ModalOverlay/ModalOverlay.tsx:1, src/components/ModalOverlay/ModalOverlay.css:1
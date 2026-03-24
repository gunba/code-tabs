# Features

<!-- Codes: TB=Tab Bar, SR=Session Resume, DS=Dead Session, TR=Terminal, SL=Session Launcher, CB=Command Bar, HM=Hooks Manager, CM=Config Manager, TP=Thinking Panel, DP=Debug Panel, WN=Window, KB=Keyboard Shortcuts, MO=Modal Overlay -->

User-facing behaviors. Code implementing a tagged entry is not dead code.

## Tab Bar

- [TB-01] Tabs are 66px tall with `box-sizing: border-box` — padding is included in height
- [TB-02] Launch (+) and Resume (↩) and Config (⚙) buttons are 66px x 66px square, flush with tab bottoms — no gap
- [TB-03] Three distinct top-right buttons: Resume (blue tint + blue icon), Config (purple tint + purple icon), New (orange/accent bg)
- [TB-04] Native Windows dark-themed titlebar — `decorations: true` + `"theme": "Dark"` in tauri.conf.json, no custom window controls HTML
- [TB-05] No `-webkit-app-region` drag regions — native titlebar handles window dragging
- [TB-06] State dot colors: idle=green, thinking=clay pulse, toolUse=blue pulse, actionNeeded=purple pulse, waitingPermission=purple pulse, error=red, dead=muted, starting=muted pulse
- [TB-07] All dot pulse animations unified: `dot-pulse 2s ease infinite` with min opacity 0.5 (no separate scale animation)
- [TB-08] Tab meta text color-coded: model color matches type (Opus=orange, Sonnet=purple, Haiku=blue via hardcoded hex), effort=clay, agents=muted text-secondary, worktree acronym=blue accent-secondary; dot separators
  - Files: src/App.tsx:294, src/lib/claude.ts:30
- [TB-09] Ctrl+E renames the active tab (inline input, Enter to confirm, Esc to cancel)
  - Files: src/App.tsx:239
- [TB-10] Non-active tabs flash green for 5s when transitioning to idle from an active state; hovering or clicking dismisses early
- [TB-11] Dead tabs dimmed (opacity 0.45), clickable to switch (overlay provides actions)
- [TB-12] Ctrl+Click tab opens relaunch modal; blue top-bar + tint when Ctrl is held
- [TB-13] Tabs preferred at 200px, shrink to 90px min-width before scrolling; CSS ellipsis handles name truncation
- [TB-14] Tabs draggable for reorder via native drag-and-drop; constrained to same workspace group
- [TB-15] Tab rename: action buttons hidden during edit (`:has(.tab-name-input)`); summary/meta lines remain visible during rename
- [TB-16] Right-click context menu: Rename, Copy Session ID, Copy Working Dir, Open in Explorer, Open Inspector / Copy Inspector URL / Reconnect Inspector (live sessions only), Revive with Options (dead only), Close (live only), Close Group
- [TB-17] Open Inspector: opens `https://debug.bun.sh/#HOST:PORT/PATH` in the default browser, disconnects the internal WebSocket, and marks session as inspector-off (hollow tab dot, status bar indicator)
- [TB-18] Copy Inspector URL: copies the inspector URL to clipboard without disconnecting the internal WebSocket
- [TB-19] Reconnect Inspector: re-establishes the internal WebSocket after closing the external debugger; only shown when inspector is disconnected
- [TB-20] Inspector-off visual feedback: tab dot becomes hollow (transparent with inset border, no animation) when inspector is manually disconnected; status bar shows muted "◌ Inspector off" label with reconnect hint in tooltip
- [TB-21] Inspector-off state cleared on session respawn
- [TB-22] All tab bar icons (rename, kill, close, resume, config, subagent arrow) are inline SVG components — no platform-dependent emoji
  - Files: src/App.tsx:27, src/components/Icons/Icons.tsx:1
- [TB-23] Tab grouping by workspace directory: tabs with the same workingDir are visually grouped with uppercase folder-label separators between groups. Multi-tab groups show hover-visible left/right arrow buttons for reorder within group. Drag-and-drop constrained to same group.
  - Files: src/App.tsx:263, src/App.tsx:282, src/App.css:406
- [TB-24] actionNeeded state: purple pulsing dot (--accent-tertiary) for ExitPlanMode approval and CLI selector inputs; active tab gets pulsing purple underline; supersedes old choice-pending amber styling
- [TB-25] actionNeeded notification: background sessions entering actionNeeded state trigger 'Action Needed' / 'A session needs your input.' desktop notification (same cooldown as other states)
  - Files: src/hooks/useNotifications.ts:92
- [TB-26] Tab rename focus return: Enter/Escape in tab rename input queues requestAnimationFrame to re-focus the visible terminal's textarea, preventing focus from being lost in the tab bar
  - Files: src/App.tsx:391, src/App.tsx:401, src/App.tsx:405
- [TB-27] Tab group separator only renders between groups (gi > 0), not before the first group -- prevents a spurious pip appearing at the start of the tab bar
  - Files: src/App.tsx:282
- [TB-28] Purple pulse (actionNeeded) triggers for CLI selectors: plan approval, permission prompts, and checkbox inputs. Detected by scanning terminal buffer for Ink selector pattern ("> 1." + "2."), not by lastText regex.
  - Files: src/hooks/useInspectorState.ts:126
- [TB-29] Worktree indicator: when workingDir is a `.claude/worktrees/<slug>` path, tab shows project name as title (not slug) and a hyphen-acronym badge in the meta row (e.g., "sorted-marinating-dove" → "SMD") in blue (accent-secondary). Hover the acronym for the full worktree name. Tab tooltip includes `Worktree: <full-name>`.
  - Files: src/lib/paths.ts:18, src/App.tsx:293, src/App.tsx:304

## Session Resume

- [SR-01] Resumed sessions show loading spinner until inspector connects (~1s) and confirms session is responsive
- [SR-02] Token/cost counters show only NEW conversation usage (inspector starts accumulating from connection time)
- [SR-03] First user message captured by inspector's `firstMsg` field for tab naming
- [SR-04] Subagent card colors: plain --bg-surface base; active cards get muted border-left (--text-muted) with pulsing text color (subagent-text-pulse on name/msg); idle at 0.4 opacity; icon uses --accent (warm clay); selected cards get accent-secondary border + tinted bg with animation suppressed
- [SR-05] Nested subagents supported via agentId-based routing (each event tagged with agentId, parentSessionId tracked per subagent)
- [SR-06] Loading spinner @keyframes spin rule defined in TerminalPanel.css — animates border-top rotation at 0.8s linear infinite
  - Files: src/components/Terminal/TerminalPanel.css:33
- [SR-07] Content search: typing 3+ chars in the filter bar triggers a debounced (400ms) Rust backend scan of all conversation JSONL files, matching user and assistant messages. Results appear below metadata matches with a blue left border and snippet. Stale results discarded via counter-based ref.
  - Files: src/components/ResumePicker/ResumePicker.tsx:121, src-tauri/src/commands.rs:407

## Dead Session Overlay

- [DS-01] Dead sessions show an overlay with Resume, Resume other, and New session buttons
- [DS-02] All actions respawn the PTY in the same tab — no new tab created, no old tab destroyed
- [DS-03] Resume button only shown if session has conversation (derived from `sessionId`, `resumeSession`, or `nodeSummary` via `canResumeSession()` — no JSONL check)
  - Files: src/components/Terminal/TerminalPanel.tsx:48, src/lib/claude.ts:20
- [DS-04] Enter key on dead tab resumes same session; all other input swallowed
- [DS-05] Ctrl+Shift+R on dead tab opens resume picker targeting that tab (reuses tab via requestRespawn); dead overlay hint shows Ctrl+Shift+R for the 'Resume other...' button
- [DS-06] ResumePicker detects active dead tab and respawns in place instead of creating new session
- [DS-07] Session-in-use auto-recovery: own orphans killed automatically and resume retries; external processes show "Session in use externally" overlay with "Kill and resume" / "Cancel" — never killed without user confirmation
- [DS-08] Proactive orphan cleanup on startup: init() collects all persisted session IDs, calls kill_orphan_sessions to kill leftover CLI processes before any PTY spawning. Prevents 'session ID already in use' and port conflicts on app restart after crash/force-close
  - Files: src/store/sessions.ts:90
- [DS-09] Auto-resume: switching to a dead tab with a resumable conversation (sessionId/resumeSession/nodeSummary) automatically triggers respawn; only fires on hidden-to-visible transitions, not when session dies while visible
  - Files: src/components/Terminal/TerminalPanel.tsx:433

## Terminal

- [TR-01] Scroll-to-top button appears at top-right when scrolled down; scroll-to-bottom button at bottom-right when scrolled up
- [TR-02] Per-session token badge: shown on the tab card (top-right, absolutely positioned, hidden on hover to make room for action buttons) showing session token count; tooltip shows input/output breakdown; hidden when dead or zero tokens
- [TR-03] Clear input button uses standard backspace icon (pointed rectangle with X); Lucide/Feather style
- [TR-04] Ctrl+Home scrolls to top, Ctrl+End scrolls to bottom
- [TR-05] Hidden tabs use CSS `display: none` — never unmount/remount xterm.js (destroys state)
- [TR-06] Fixed 100K scrollback buffer — no dynamic resizing
- [TR-07] Vertical button bar (28px): right-side column with scroll-to-top, scroll-to-last-message, queue input, clear input, clear all input, and scroll-to-bottom. Conditionally rendered when visible and not dead; individual scroll buttons within use visibility toggling.
  - Files: src/components/Terminal/TerminalPanel.tsx:666
- [TR-08] Scroll to last user message: uses xterm.js buffer markers registered on user Enter presses (not prompt scanning), accessible via button bar and Ctrl+middle-click on terminal (capture phase listener)
  - Files: src/hooks/useTerminal.ts:277, src/components/Terminal/TerminalPanel.tsx:615
- [TR-09] Ctrl+wheel snaps to top/bottom; requires zoomHotkeysEnabled: false in tauri.conf.json to prevent WebView2 zoom interception
  - Files: src/components/Terminal/TerminalPanel.tsx:619, src-tauri/tauri.conf.json:25
- [TR-10] fit() deferred on tab switch via double requestAnimationFrame -- waits for browser layout reflow before sizing, prevents tiny-terminal bug. Cancels on rapid tab switching.
  - Files: src/components/Terminal/TerminalPanel.tsx:488
- [TR-11] Subagent card shows selected highlight (accent-secondary left border + tinted background) when its inspector is open.
  - Files: src/App.tsx:515, src/App.css:574
- [TR-12] Tool blocks in SubagentInspector are collapsible: collapsed by default with tool name + one-line preview, click to expand. Last tool block auto-expands while subagent is active.
  - Files: src/components/SubagentInspector/SubagentInspector.tsx:18, src/components/SubagentInspector/SubagentInspector.css:122
- [TR-13] Context clear detection: terminal scrollback auto-clears when Claude session ID changes (/clear, plan approval, compaction). Signal-based via inspector — no input parsing or timers.
  - Files: src/components/Terminal/TerminalPanel.tsx:183
- [TR-14] Scroll position preservation: full-redraw sync blocks replace ESC[2J with ESC[H ESC[J (viewport-only clear). Scrollback is never erased (no ESC[3J), so the user's scroll position is maintained when Claude enters new text. Ink re-renders may duplicate content into scrollback; bounded by xterm.js 100K scrollback limit.
  - Files: src-tauri/pty-patch/src/lib.rs:42

## Session Launcher

- [SL-01] Modal for new session or resume — Ctrl+T opens fresh (clears resume/continue flags)
- [SL-02] Quick launch: Ctrl+Click "+" or Ctrl+Shift+T instantly launches without showing modal; uses saved defaults if set, otherwise falls back to last-used config (including folder)
- [SL-03] Ctrl+Shift+R opens resume picker (browse past Claude sessions); 660px modal, 520px list max-height; cards show blue top-bar + tint when Ctrl is held; resume banner uses orange accent (not blue)
  - Files: src/components/SessionLauncher/SessionLauncher.css:404
- [SL-04] Resume picker enriched data: each session card shows firstMessage, lastMessage (from tail scan), settings badges (model, skip-perms, permission mode, effort, agent), and file size
  - Files: src/components/ResumePicker/ResumePicker.tsx:418
- [SL-05] Chain merging: sessions linked by parentId (resolved via sourceToolAssistantUUID -> message UUID map in Rust) merged into a single card; latest session used for resume, names resolved from any member, suppressed plan-mode artifact messages skipped, sizes summed; stacked box-shadow when chainLength > 1; clickable chain count badge expands to show individual members for resuming older sessions
  - Files: src/components/ResumePicker/ResumePicker.tsx:163, src-tauri/src/commands.rs:337
- [SL-06] Custom names: tab renames persist in `sessionNames` map (localStorage); shown as bold primary name with directory as secondary text in resume picker
- [SL-07] Config caching: session configs cached in sessionConfigs map (localStorage) when inspector connects (model, permissionMode, dangerouslySkipPermissions, effort, agent, maxBudget, verbose, debug, projectDir, extraFlags, systemPrompt, appendSystemPrompt, allowedTools, disallowedTools, additionalDirs, mcpConfig); used as fallback when resuming sessions not in the dead tab map
  - Files: src/store/settings.ts:199
- [SL-08] Config pruning: both `sessionNames` and `sessionConfigs` maps pruned to only IDs present in loaded past sessions
- [SL-09] Config restore: SessionLauncher uses savedDefaults (explicit "Save defaults") with lastConfig fallback, clearing one-shot fields (continueSession, sessionId, runMode); resume fields preserved from lastConfig when set by configure flow
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
- [CB-04] Click a pill types the command into the terminal without sending; Ctrl+Click sends immediately
- [CB-05] Ctrl+Click a pill sends the command to the PTY immediately (records usage on send)
- [CB-07] Holding Ctrl shows blue border on pills; heat gradient suppressed while Ctrl is held
- [CB-09] Command history strip: horizontal scrollable row above command pills showing per-session command execution history (newest left). Clicking a history pill re-sends that command. Strip only visible when history exists. Per-session -- switching tabs shows different history. Cleaned up on session close.
  - Files: src/components/CommandBar/CommandBar.tsx:81, src/store/sessions.ts:287

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
- [HM-10] All status bar icons (context, tokens, clock, budget, warning, hooks, sessions, permissions) are inline SVG components -- no emoji. Greek sigma kept as text.
  - Files: src/components/StatusBar/StatusBar.tsx:7

## Config Manager

- [CM-01] Config modal header uses CSS grid (auto 1fr auto) instead of flexbox space-between, so tab row stays centered regardless of left (title) or right (project selector + close) content width.
  - Files: src/components/ConfigManager/ConfigManager.css:16, src/components/ConfigManager/ConfigManager.tsx:66
- [CM-02] formatScopePath() normalizes backslashes to forward slashes and abbreviates project-scope paths via abbreviatePath(). User-scope paths (~/...) pass through unchanged.
  - Files: src/lib/paths.ts:89
- [CM-03] Project directory selector: when multiple working dirs exist across sessions, the config modal header shows a dropdown to switch between project-level scopes. settingsSchema.ts builds the schema; fetch_settings_schema provides the Rust backend.
  - Files: src/lib/settingsSchema.ts:223, src-tauri/src/commands.rs:890
- [CM-04] Keystrokes blocked via shared ModalOverlay component (`onKeyDown` stopPropagation); Escape and `Ctrl+,` pass through to global handler
- [CM-05] Three content tabs (Claude/Hooks/Agents) use ThreePaneEditor: 3-column grid showing User/Project/Local scopes side by side with color-coded borders and tinted headers. Plugins tab uses dedicated PluginsTab component (single-pane, CLI-driven). Settings tab uses dedicated SettingsTab component with unified reference panel.
  - Files: src/components/ConfigManager/ConfigManager.tsx:102, src/components/ConfigManager/SettingsTab.tsx:1, src/components/ConfigManager/PluginsPane.tsx:75
- [CM-06] Per-scope raw JSON settings editor (SettingsPane) and CLAUDE.md editor (MarkdownPane) with own dirty tracking and Save per pane. Tab key inserts 2 spaces in markdown.
- [CM-07] Agent editor: scoped via ThreePaneEditor (user/project/local) with agent pills at top, editor below. Auto-selects first agent on load (or enters new-agent mode if none). Textarea always visible -- no empty state. Dashed '+ new agent' pill replaces old + New button/inline form. Duplicate name validation on create. Ctrl+S dispatches to create or save based on mode. User scope scans ~/.claude/agents/, project scans {wd}/.claude/agents/, local scans {wd}/.claude/local/agents/.
  - Files: src/components/ConfigManager/AgentEditor.tsx:6, src/components/ConfigManager/ConfigManager.css:701
- [CM-08] Save via Rust `read_config_file`/`write_config_file` commands (JSON validated before write, parent dirs auto-created)
- [CM-09] Escape closes modal; clicking overlay closes modal
- [CM-10] Settings schema cached in localStorage (`binarySettingsSchema`) to avoid re-scanning on every startup
- [CM-11] Wide modal (96vw, max 1900px, 88vh) with 5 tabs: Settings, Claude, Hooks, Plugins, Agents. All tabs render at full width. Store value controls which tab opens.
  - Files: src/components/ConfigManager/ConfigManager.tsx:64, src/components/ConfigManager/ConfigManager.css:1
- [CM-12] ThreePaneEditor: Claude/Hooks/Agents tabs use 3-column grid showing User/Project/Local scopes side by side. Color coded: User=clay, Project=blue, Local=purple (left border + tinted header). Plugins tab excluded (uses single-pane PluginsTab).
  - Files: src/components/ConfigManager/ThreePaneEditor.tsx:1, src/components/ConfigManager/ConfigManager.css:129
- [CM-13] SettingsPane: JSON textarea with syntax highlighting overlay (pre behind transparent textarea). Both layers use position: absolute; inset: 0 inside sh-container for proper fill. Keys=clay, strings=blue, numbers/bools=purple. Scroll synced between layers. Ctrl+S to save.
  - Files: src/components/ConfigManager/SettingsPane.tsx:15, src/components/ConfigManager/ConfigManager.css:1050
- [CM-14] MarkdownPane: per-scope CLAUDE.md textarea. Tab key inserts 2 spaces. Scope-to-fileType mapping: user=claudemd-user, project=claudemd-root, project-local=claudemd-dotclaude.
  - Files: src/components/ConfigManager/MarkdownPane.tsx:1
- [CM-15] HooksPane: per-scope CRUD absorbed from standalone HooksManager. Hook cards, inline Add/Edit form. Scope is a prop, not a dropdown. Calls bumpHookChange() after save.
  - Files: src/components/ConfigManager/HooksPane.tsx:1
- [CM-16] PluginsTab (was PluginsPane): CLI-driven plugin management via 5 IPC commands (plugin_list/install/uninstall/enable/disable). Installed plugins as cards with toggle + uninstall. Marketplace grid with search/scope filter. normalizePlugins export retained for test compatibility. MCP servers shown as cards with manual save.
  - Files: src/components/ConfigManager/PluginsPane.tsx:75, src/components/ConfigManager/ConfigManager.css:517
- [CM-17] StatusBar hooks button opens config manager directly to Hooks tab. Store: showConfigManager is string|false (tab name or closed), replacing old boolean + separate showHooksManager.
  - Files: src/components/StatusBar/StatusBar.tsx:140, src/store/settings.ts:49
- [CM-18] Config tabs use inline SVG icons (gear, document, hook, puzzle, bot) instead of emoji — monochrome, consistent cross-platform
  - Files: src/components/ConfigManager/ConfigManager.tsx:17
- [CM-20] Tab label reads "Claude" instead of "CLAUDE.md" for the markdown editor tab.
  - Files: src/components/ConfigManager/ConfigManager.tsx:19
- [CM-22] ThreePaneEditor scope headers show actual file paths per tab (e.g. ~/.claude/settings.json, {dir}/CLAUDE.md, {dir}/.claude/agents/) instead of generic directory stubs. Paths normalized to forward slashes via formatScopePath().
  - Files: src/components/ConfigManager/ThreePaneEditor.tsx:19, src/lib/paths.ts:89
- [CM-23] MarkdownPane preview toggle: footer has Preview/Edit button (left-aligned via margin-right:auto). Preview mode renders markdown via ReactMarkdown with dark-themed styles for headings, code, tables, blockquotes, lists, and links.
  - Files: src/components/ConfigManager/MarkdownPane.tsx:86, src/components/ConfigManager/ConfigManager.css:1086
- [CM-24] Unified Settings Reference: full-width panel below the 3 editor columns, alphabetically sorted in a 3-column CSS grid (left-to-right flow). Type badges (boolean=blue, string=green, number=purple, enum=purple, array=yellow, object=clay), search/filter, click-to-insert into the active scope's editor, 2-line CSS-clamped descriptions with full text on hover, isSet highlight when key exists in active scope. Collapse state persisted to localStorage.
- [CM-25] Settings validation footer: shows 'Valid' when JSON is well-formed with all recognized keys. Unknown keys show names inline (up to 3, then '+N more') with a tooltip explaining schema source status (schemastore.org loaded vs CLI-only vs limited). Type mismatches show key, expected type, and actual type. Each validation segment is a separate span so tooltips are correctly scoped.
  - Files: src/components/ConfigManager/SettingsPane.tsx:298, src/lib/settingsSchema.ts:295
- [CM-26] PluginsTab: CLI-driven plugin manager replacing manual tag-based editor. Single-pane layout (no ThreePaneEditor). Installed plugins shown as cards with toggle switch (enable/disable) and uninstall button. Collapsible marketplace section with search filter, scope selector (user/project), and 2-column grid. Install count formatting via formatTokenCount. Graceful fallback for older CLI versions. MCP servers section retained for manual settings.json config.
  - Files: src/components/ConfigManager/PluginsPane.tsx:75, src/components/ConfigManager/ConfigManager.css:517

## Thinking Panel


## Debug Panel

- [DP-01] Collapsible right-side panel (350px fixed, 250px min, 50% max)
- [DP-02] Toggle via `Ctrl+Shift+D` keyboard shortcut or "Toggle Debug Log" in command palette
- [DP-03] Captures ALL `console.log`, `console.warn`, `console.error` with `[HH:MM:SS.mmm] [LOG|WARN|ERR]` prefix
- [DP-04] Buffer size: 500 entries (ring buffer, oldest evicted first)
- [DP-05] Polls `globalThis.__consoleLogs` every 500ms
- [DP-06] Filter input for searching/filtering log entries
- [DP-07] Auto-scrolls to bottom on new entries (pauses if user scrolls up)
- [DP-08] Copy button copies all visible (filtered) logs to clipboard; Clear button empties buffer
- [DP-09] Color-coded by severity: LOG=default, WARN=`--warning`, ERR=`--error`
- [DP-10] Monospace font, 10px
- [DP-11] Escape dismisses panel (checked before config manager in Escape chain)
- [DP-12] Strategic logging at key points: PTY spawn/kill/exit, TerminalPanel kill/respawn/exit, inspector connect/disconnect/state changes

## Window

- [WN-01] Native Windows decorations with dark theme — no custom HTML titlebar or window control buttons
- [WN-02] App uses `decorations: true` and `"theme": "Dark"` in Tauri window config
- [WN-03] Desktop notifications for background sessions (response complete, permission needed, error). Clicking toast switches to target tab and focuses window. Rate-limited to 1 per session per 30s. Uses custom Rust WinRT toast with on_activated callback instead of Tauri notification plugin (which lacks desktop click support).
  - Files: src/hooks/useNotifications.ts:1

## Keyboard Shortcuts

- [KB-01] Ctrl+T — New session
- [KB-02] Ctrl+W — Close active tab
- [KB-03] Ctrl+Shift+R -- Resume from history
  - Files: src/App.tsx:197
- [KB-04] Ctrl+Tab / Ctrl+Shift+Tab — Cycle tabs
- [KB-05] Alt+1-9 — Jump to tab N
- [KB-06] Ctrl+K — Command palette
- [KB-07] Ctrl+Shift+X — Clear all input lines
- [KB-08] Ctrl+, — Open Config Manager
- [KB-09] Esc — Close modal / dismiss inspector (ordered: contextMenu -> palette -> debug -> config -> resume -> launcher -> inspector)
- [KB-10] Alt+1-9 blocked from PTY (return false in attachCustomKeyEventHandler) -- handled by App.tsx global tab-switch handler without escape code artifacts
  - Files: src/hooks/useTerminal.ts:80

## Modal Overlay


- [MO-01] Shared modal wrapper: fixed overlay, inset 0, z-index 100, backdrop-filter blur(4px). Blocks all keystrokes except Escape and Ctrl+comma via stopPropagation. Backdrop click calls onClose.
  - Files: src/components/ModalOverlay/ModalOverlay.tsx:1, src/components/ModalOverlay/ModalOverlay.css:1
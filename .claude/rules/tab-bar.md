---
paths:
  - "src/App.tsx"
  - "src/App.css"
---

# Tab Bar

<!-- Codes: TB=Tab Bar -->

- [TB-01] Tabs are 66px tall with `box-sizing: border-box` — padding is included in height
- [TB-02] Launch (+) and Resume (↩) and Config (⚙) buttons are 66px x 66px square, flush with tab bottoms — no gap
- [TB-03] Three distinct top-right buttons: Resume (blue tint + blue icon), Config (purple tint + purple icon), New (orange/accent bg)
- [TB-04] Native Windows dark-themed titlebar — `decorations: true` + `"theme": "Dark"` in tauri.conf.json, no custom window controls HTML
- [TB-05] No `-webkit-app-region` drag regions — native titlebar handles window dragging
- [TB-06] State dot colors: idle=green, thinking=clay pulse, toolUse=blue pulse, actionNeeded=purple pulse, waitingPermission=purple pulse, error=red, interrupted=red (static), dead=muted, starting=muted pulse. Same dot system reused for subagent cards.
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
- [TB-16] Right-click context menu: Rename, Copy Session ID, Copy Working Dir, Open in Explorer, Open Inspector / Copy Inspector URL / Reconnect Inspector (live sessions only), Tap Recording (per-category toggles, Stop All Taps, Open Tap Log), Revive with Options (dead only), Close (live only), Close Group
- [TB-17] Open Inspector: opens `https://debug.bun.sh/#HOST:PORT/PATH` in the default browser, disconnects the internal WebSocket, and marks session as inspector-off (hollow tab dot, status bar indicator)
- [TB-18] Copy Inspector URL: copies the inspector URL to clipboard without disconnecting the internal WebSocket
- [TB-19] Reconnect Inspector: re-establishes the internal WebSocket after closing the external debugger; only shown when inspector is disconnected
- [TB-20] Inspector-off visual feedback: tab dot becomes hollow (transparent with inset border, no animation) when inspector is manually disconnected; status bar shows muted "◌ Inspector off" label with reconnect hint in tooltip
- [TB-21] Inspector-off state cleared on session respawn
- [TB-24] Tap recording: per-session, per-category hooks for deep inspection of Claude Code internals. 9 categories (JSON.parse, console, fs, child_process, fetch, process.exit, setTimeout, stdout, require) toggled individually via tab context menu. Data captured to ring buffer in hooked process, drained at 500ms, flushed to JSONL at 2s intervals. Files at %LOCALAPPDATA%/claude-tabs/taps/{session-id}.jsonl. Status bar shows accent-colored "TAP" indicator when active. Auto-cleanup of files >48h on startup.
  - Files: src/lib/inspectorHooks.ts, src/hooks/useTapPipeline.ts, src-tauri/src/commands.rs
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
- [TB-28] Purple pulse (actionNeeded) triggers for CLI selectors: plan approval (ExitPlanMode tool call) and permission prompts (PermissionPromptShown event). State transitions driven by tapStateReducer event-based logic, not terminal buffer scanning.
  - Files: src/lib/tapStateReducer.ts:23, src/lib/tapStateReducer.ts:38
- [TB-29] Worktree indicator: when workingDir is a `.claude/worktrees/<slug>` path, tab shows project name as title (not slug) and a hyphen-acronym badge in the meta row (e.g., "sorted-marinating-dove" → "SMD") in purple (accent-tertiary). Hover the acronym for the full worktree name. Tab tooltip includes `Worktree: <full-name>`. StatusBar also shows worktree acronym after the model label.
  - Files: src/lib/paths.ts:18, src/App.tsx:293, src/App.tsx:304, src/components/StatusBar/StatusBar.tsx:55
- [TB-30] Worktree prune on close: manually closing a worktree tab (Ctrl+W, X button, context menu Close) shows a confirmation dialog with "Keep worktree" and "Prune worktree" options. Pruning closes the dialog immediately, then kills the PTY (via `killPty` registry), closes the session, and runs `git worktree remove --force` in the background. Errors are logged via `dlog` to the debug panel. Skipped for bulk actions (Close Group, app close). Uses ModalOverlay, `killPty` from ptyRegistry, and `prune_worktree` IPC command [RC-19].
  - Files: src/App.tsx:173, src/App.tsx:614, src/lib/ptyRegistry.ts:28, src-tauri/src/commands.rs:1877
- [TB-31] Subagent cards unified with tab appearance: state dot (same colors as tabs), bottom accent bar for active state, meta line (agentType, model, tool count, duration), summary line (current action/last message). Interrupted subagents show red dot. Cards use tab-dot CSS classes directly.
  - Files: src/App.tsx:556, src/App.css:558

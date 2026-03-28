---
paths:
  - "src/components/DebugPanel/**"
  - "src/lib/debugLog.ts"
---

# Debug Panel

<!-- Codes: DP=Debug Panel -->

- [DP-01] Collapsible right-side panel (350px fixed, 250px min, 50% max)
- [DP-02] Toggle via `Ctrl+Shift+D` keyboard shortcut or "Toggle Debug Log" in command palette
- [DP-03] Reads structured `dlog()` entries from `debugLog.ts` buffer with `[HH:MM:SS.mmm] [LOG|WARN|ERR]` prefix. All app logging flows through `dlog(module, sessionId, message, level?)`.
- [DP-04] Buffer size: 2000 entries (ring buffer, oldest evicted first)
- [DP-05] Polls `getDebugLog()` every 500ms
- [DP-06] Filter input for searching/filtering log entries
- [DP-07] Auto-scrolls to bottom on new entries (pauses if user scrolls up)
- [DP-08] Copy button copies all visible (filtered) logs to clipboard; Clear button empties buffer
- [DP-09] Color-coded by severity: LOG=default, WARN=`--warning`, ERR=`--error`
- [DP-10] Monospace font, 10px
- [DP-11] Escape dismisses panel (checked before config manager in Escape chain)
- [DP-12] Strategic logging at key points: PTY spawn/kill/exit, TerminalPanel kill/respawn/exit, inspector connect/disconnect/state changes

---
paths:
  - "src/components/DebugPanel/DebugPanel.tsx"
---

# src/components/DebugPanel/DebugPanel.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Debug Panel

- [DP-12 L5] Strategic logging at key points: PTY spawn/kill/exit (ptyProcess.ts/ptyRegistry.ts), TerminalPanel kill/respawn/exit, inspector connect/disconnect/state changes, tap pipeline (useTapPipeline.ts), session lifecycle (sessions.ts). All flow through dlog() and end up in DebugPanel via per-session ring buffers.
- [DP-09 L52] Color-coded by severity: LOG=default, WARN=`--warning`, ERR=`--error`
- [DP-01 L60] Collapsible right-side panel (350px fixed, 250px min, 50% max)
- [DP-06 L63] Filter input for searching/filtering log entries
- [DP-05 L79] Polls `getDebugLog()` every 500ms
- [DP-07 L103] Auto-scrolls to bottom on new entries (pauses if user scrolls up)
- [DP-08 L181] Copy button copies all visible (filtered) logs to clipboard; Clear button empties buffer

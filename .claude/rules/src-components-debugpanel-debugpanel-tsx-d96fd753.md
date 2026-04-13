---
paths:
  - "src/components/DebugPanel/DebugPanel.tsx"
---

# src/components/DebugPanel/DebugPanel.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Debug Panel

- [DP-09 L48] Color-coded by severity: LOG=default, WARN=`--warning`, ERR=`--error`
- [DP-01 L56] Collapsible right-side panel (350px fixed, 250px min, 50% max)
- [DP-05 L74] Polls `getDebugLog()` every 500ms
- [DP-07 L98] Auto-scrolls to bottom on new entries (pauses if user scrolls up)

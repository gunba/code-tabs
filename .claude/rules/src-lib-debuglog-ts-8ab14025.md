---
paths:
  - "src/lib/debugLog.ts"
---

# src/lib/debugLog.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Debug Panel

- [DP-04 L35] Per-session buffer capacity: 15000 entries each (ring buffer, oldest evicted first). Each terminal and global log gets its own independent buffer.
- [DP-13 L38] Per-session ring buffers: each sessionId (and null/global) has its own 15000-entry buffer in a Map. getDebugLog() merges all buffers sorted by timestamp; getDebugLogForSession(id) reads one buffer directly. DebugPanel uses per-session fetch when a session chip is selected to avoid merge cost.
- [DP-03 L186] Reads structured `dlog()` entries from `debugLog.ts` buffer with `[HH:MM:SS.mmm] [LOG|WARN|ERR]` prefix. All app logging flows through `dlog(module, sessionId, message, level?)`.

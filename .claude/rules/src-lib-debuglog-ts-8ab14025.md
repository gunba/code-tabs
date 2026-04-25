---
paths:
  - "src/lib/debugLog.ts"
---

# src/lib/debugLog.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Debug Panel

- [DP-04 L35,36] Per-session buffer capacity: 3000 entries each (ring buffer, oldest evicted first). A cross-buffer total cap of 12000 entries (MAX_TOTAL_ENTRIES) is enforced by trimTotalBuffers(), which evicts from the buffer with the oldest front entry. Each terminal and global log gets its own independent buffer.
- [DP-13 L43] Per-session ring buffers: each sessionId (and null/global) has its own 3000-entry buffer in a Map. A 12000-entry cross-buffer cap (MAX_TOTAL_ENTRIES) prevents unbounded total memory; trimTotalBuffers() evicts oldest-first across all buffers. getDebugLog() merges all buffers sorted by timestamp; getDebugLogForSession(id) reads one buffer directly. DebugPanel uses per-session fetch when a session chip is selected to avoid merge cost. removeDebugLogSession() decrements totalEntryCount and deletes the buffer, keeping the total cap accurate.
- [DP-03 L232] Reads structured `dlog()` entries from `debugLog.ts` buffer with `[HH:MM:SS.mmm] [LOG|WARN|ERR]` prefix. All app logging flows through `dlog(module, sessionId, message, level?)`.

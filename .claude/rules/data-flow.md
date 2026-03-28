---
paths:
  - "src/lib/ptyProcess.ts"
  - "src/lib/ptyRegistry.ts"
  - "src/hooks/useTerminal.ts"
  - "src/lib/paths.ts"
  - "src/lib/diffParser.ts"
  - "src/components/Icons/**"
---

# Data Flow

<!-- Codes: DF=Data Flow -->

- [DF-01] User types in xterm.js -> `onData` -> `writeToPty()` (ptyRegistry.ts: LineAccumulator detects slash commands) -> PTY `write` -> PTY (ConPTY on Windows, openpty on Linux) -> Claude stdin
- [DF-02] Claude stdout -> PTY -> background reader thread (8 KiB) -> sync_channel(64) -> OutputFilter (security) -> SyncBlockDetector (DEC 2026 coalescing) -> IPC response -> Uint8Array
  - Files: src-tauri/pty-patch/src/lib.rs:179, src/lib/ptyProcess.ts:88
- [DF-03] PTY data handler: `writeBytes(data)` to xterm.js (debounce-batched, 4ms/50ms). Background tabs buffer PTY data in bgBufferRef, flushed as single merged write on tab focus.
- [DF-04] React re-renders from Zustand store: tab state dots, status bar, subagent cards
- [DF-05] xterm.js 6.0 with DEC 2026 synchronized output — prevents ink rendering flash on rapid writes
- [DF-06] WebGL renderer for performance, with context loss recovery (retry once after 1s, fallback to canvas)
- [DF-07] Visibility change handler: clears texture atlas and redraws on OS wake / tab restore (fixes GPU corruption after sleep)
- [DF-08] Icons module: src/components/Icons/Icons.tsx exports 26 inline SVG icon components (stroke-based, 16x16 viewBox, currentColor inheritance, pointerEvents none). No dependencies. All UI icons are monochrome SVGs — no emoji or unicode icon chars.
  - Files: src/components/Icons/Icons.tsx:1
- [DF-09] groupSessionsByDir() and swapWithinGroup() in paths.ts: pure functions for tab grouping by normalized workingDir (Map-based, O(n) single pass, insertion-order groups) and position swapping within group boundaries. TabGroup type exported. parseWorktreePath() detects `.claude/worktrees/<slug>` paths, worktreeAcronym() abbreviates slugs by hyphen initials.
  - Files: src/lib/paths.ts:73, src/lib/paths.ts:88, src/lib/paths.ts:22, src/lib/paths.ts:33
- [DF-10] toSideBySide(hunks) in diffParser.ts: transforms unified DiffHunk[] into aligned SideBySideRow[] for dual-pane rendering. Context lines go to both sides. Consecutive del+add runs are paired 1:1 (excess gets null on the other side). Hunk headers become separator rows. Pure function, memoized in DiffModal via useMemo.
  - Files: src/lib/diffParser.ts:268

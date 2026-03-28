---
paths:
  - "src-tauri/pty-patch/**"
  - "src/lib/ptyProcess.ts"
  - "src/hooks/useTerminal.ts"
  - "src/components/Terminal/TerminalPanel.tsx"
---

# PTY Internals

<!-- Codes: PT=PTY Internals -->

- [PT-01] Direct PTY wrapper (`ptyProcess.ts`) calls `invoke('plugin:pty|...')` for PTY data — not the `tauri-pty` npm package or raw Tauri event listeners
  - Files: src/lib/ptyProcess.ts:1
- [PT-02] Never pass `env: {}` to PTY spawn — omit `env` to inherit (empty object wipes environment)
- [PT-03] `CLAUDECODE` env var must not leak into spawned PTYs
- [PT-04] Kill button (`pty.kill()`) always fires exitCallback exactly once via `exitFired` guard — whether kill or natural exit completes first
- [PT-05] Tab action buttons (edit/kill/close) suppress focus outline on mouse click via `:focus:not(:focus-visible)`, preserving keyboard accessibility
- [PT-06] Fixed 1M scrollback buffer in `useTerminal` — no dynamic resizing
- [PT-07] OS PID registered in global cleanup registry (`ptyProcess.ts`) immediately on PTY spawn; unregistered on explicit kill. Dual-layer: frontend fires `kill_process_tree` on `beforeunload`, Rust `ActivePids` state kills on `RunEvent::Exit` as backstop
  - Files: src/lib/ptyProcess.ts:9, src-tauri/src/lib.rs:16
- [PT-08] Scroll desync fix: xterm-viewport uses overflow-y:scroll with hidden scrollbar (scrollbar-width:none + ::-webkit-scrollbar) instead of overflow:hidden. isAtBottom/wasAtBottom use 2-line tolerance for near-bottom snap.
  - Files: src/components/Terminal/TerminalPanel.css:60, src/hooks/useTerminal.ts:300, src/hooks/useTerminal.ts:215, src/hooks/useTerminal.ts:10
- [PT-09] FitAddon dimension guard: fit() calls check proposeDimensions() first — if rows <= 1, container is not laid out yet and fit is skipped. Applied in useTerminal wrapper, initial attach, and ResizeObserver.
  - Files: src/hooks/useTerminal.ts:313, src/hooks/useTerminal.ts:180, src/hooks/useTerminal.ts:187
- [PT-10] Parallel exit waiter: fire-and-forget invoke('plugin:pty|exitstatus') runs alongside read loop. On Windows ConPTY, read pipe may hang after Ctrl+C; exitstatus uses WaitForSingleObject which reliably returns. exitFired guard ensures exactly one callback fires
  - Files: src/lib/ptyProcess.ts:112
- [PT-11] Respawn clears both bgBufferRef and useTerminal's writeBatchRef (via clearPending()) before writing \x1bc. Without this, stale PTY data from previous sessions survives the terminal reset and gets flushed when the tab becomes visible, causing duplicated conversation content.
  - Files: src/components/Terminal/TerminalPanel.tsx:314, src/hooks/useTerminal.ts:386
- [PT-12] Pre-spawn fit() + post-spawn rAF dimension verification prevents 80-col race when font metrics or WebGL renderer aren't ready during initial layout
  - Files: src/components/Terminal/TerminalPanel.tsx:417, src/components/Terminal/TerminalPanel.tsx:431-437
- [PT-13] Same-dimension gate: handleResize tracks last PTY dims in a ref; skips redundant pty.resize() calls when cols/rows unchanged. Prevents ConPTY reflow duplication from layout-triggered ResizeObserver events.
  - Files: src/components/Terminal/TerminalPanel.tsx:375
- [PT-15] Background reader thread per session: OS thread reads ConPTY pipe (8 KiB buffer) into bounded sync_channel(64). Decouples blocking pipe reads from IPC, enabling timeout-based sync block coalescing in the read command.
  - Files: src-tauri/pty-patch/src/lib.rs:127
- [PT-16] DEC 2026 sync coalescing: read command filters output through OutputFilter then SyncBlockDetector. When mid-sync-block (BSU seen, ESU pending), reads continue with 50ms timeout to coalesce the complete synchronized update into a single IPC response. Eliminates scroll jumping from ConPTY-fragmented redraws.
  - Files: src-tauri/pty-patch/src/lib.rs:179, src-tauri/pty-patch/src/sync_detector.rs:1
- [PT-17] Output security filter: byte-level state machine strips OSC 52 (clipboard hijack), OSC 50 (font query), DCS sequences, C1 controls (including cross-chunk PendingC2 state), ESC[3J (scrollback erase). ESC[2J stripped outside sync blocks after startup grace period of 2. Device queries (DA1/DA2/DSR/CPR/DECRQM/Kitty keyboard) pass through for ConPTY handshake. OSC 2 titles sanitized. All hyperlinks pass through.
- [PT-18] Shutdown drain: drain_output command empties the channel (500ms deadline, 10ms intervals) before session destroy, preventing the background reader thread from blocking on a full channel.
  - Files: src-tauri/pty-patch/src/lib.rs:348, src/lib/ptyProcess.ts:170
- [PT-19] Sync block re-wrapping: completed sync blocks are re-wrapped with BSU/ESU before sending to xterm.js. Full-redraw blocks (`is_full_redraw: true`) replace ESC[2J with ESC[H ESC[J (cursor home + erase below). ESC[3J is conditionally emitted only when content newlines >= terminal rows (overflow prevention). `strip_clear_screen_into` uses memchr::memmem to efficiently remove all ESC[2J occurrences. Session tracks terminal rows via AtomicU16 (set in spawn, updated in resize).
  - Files: src-tauri/pty-patch/src/lib.rs:27, src-tauri/pty-patch/src/lib.rs:42
- [PT-20] Conditional scrollback clearing: ESC[3J is emitted only when full-redraw content exceeds terminal height (prevents scrollback duplication from overflow). When content fits the viewport, scrollback is preserved and scroll position is maintained. Frontend `flushWrites` detects scrollback clear (baseY shrinkage) and scrolls to bottom; detects unexpected viewport movement and restores absolute position. handleResize defers PTY resize for hidden tabs (visibility gate) in addition to the bgBuffer gate.
  - Files: src-tauri/pty-patch/src/lib.rs:42, src/hooks/useTerminal.ts:239, src/components/Terminal/TerminalPanel.tsx:380

---
paths:
  - "src/lib/ptyProcess.ts"
---

# src/lib/ptyProcess.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Persistence

- [PS-04 L19] `beforeunload` kills all active PTY process trees before persisting — prevents orphaned CLI processes holding session locks on restart

## PTY Spawn

- [PT-01 L1] Direct PTY wrapper (ptyProcess.ts) calls invoke('pty_spawn'/'pty_read'/etc) for PTY data -- not the tauri-pty npm package or raw Tauri event listeners.
- [PT-07 L5] OS PID registered in global cleanup registry (ptyProcess.ts) immediately on PTY spawn; unregistered on explicit kill. Dual-layer: frontend fires kill_process_tree on beforeunload, Rust ActivePids state kills on RunEvent::Exit as backstop.
- [PT-04 L106] Kill button (pty.kill()) always fires exitCallback exactly once via exitFired guard -- whether kill or natural exit completes first.
- [PT-10 L151] Parallel exit waiter: fire-and-forget invoke('pty_exitstatus') runs alongside read loop. On Windows ConPTY, read pipe may hang after Ctrl+C; exitstatus uses WaitForSingleObject which reliably returns. exitFired guard ensures exactly one callback fires.
- [PT-18 L238] Shutdown drain: pty_drain_output command empties the channel (500ms deadline, 10ms intervals) before session destroy, preventing the background reader thread from blocking on a full channel.

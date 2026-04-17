---
paths:
  - "src-tauri/src/pty/mod.rs"
---

# src-tauri/src/pty/mod.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## PTY Output

- [PT-16 L184] PTY output stays raw through pty_read -> Uint8Array -> useTerminal.writeBytes -> term.write(). The frontend logs exact chunk content plus before/after xterm buffer state, and perf spans measure the write callback latency.
- [PT-25 L236] Lock-free on Unix: pty_exitstatus holds session.pty's std::sync::Mutex for the whole session lifetime via child.wait(), so resize cannot take that lock. The master fd is safe to ioctl concurrently.

## PTY Spawn

- [PT-18 L341] Shutdown drain: pty_drain_output command empties the channel (500ms deadline, 10ms intervals) before session destroy, preventing the background reader thread from blocking on a full channel.

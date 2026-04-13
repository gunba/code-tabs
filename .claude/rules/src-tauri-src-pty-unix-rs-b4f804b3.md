---
paths:
  - "src-tauri/src/pty/unix.rs"
---

# src-tauri/src/pty/unix.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## PTY Output

- [PT-15 L206] Background reader thread per session: OS thread reads ConPTY pipe (8 KiB buffer) into bounded sync_channel(64). Decouples blocking pipe reads from IPC, enabling timeout-based reads in the pty_read command.

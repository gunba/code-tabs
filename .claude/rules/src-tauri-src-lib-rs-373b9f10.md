---
paths:
  - "src-tauri/src/lib.rs"
---

# src-tauri/src/lib.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Rust System Command Modules

- [RC-11 L283] register_active_pid / unregister_active_pid -- Frontend registers OS PIDs of PTY children; RunEvent::Exit handler in lib.rs iterates ActivePids and calls kill_process_tree_sync for each.

## Window

- [WN-01 L122] Native Windows decorations with dark theme — no custom HTML titlebar or window control buttons

## PTY Spawn

- [PT-07 L22] OS PID registered in global cleanup registry (ptyProcess.ts) immediately on PTY spawn; unregistered on explicit kill. Dual-layer: frontend fires kill_process_tree on beforeunload, Rust ActivePids state kills on RunEvent::Exit as backstop.
- [PT-03 L95] CLAUDECODE env var is stripped at Rust app startup (lib.rs) so spawned PTYs do not think they are nested inside another Claude Code session.

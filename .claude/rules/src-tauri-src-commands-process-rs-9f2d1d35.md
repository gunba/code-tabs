---
paths:
  - "src-tauri/src/commands/process.rs"
---

# src-tauri/src/commands/process.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Inspector Connection

- [IN-07 L557] Inspector port allocator verifies each candidate port is free via `check_port_available` IPC (Rust TcpListener::bind on 127.0.0.1). Skips ports already in the registry. Throws if all 100 ports (6400-6499) are exhausted.

## Rust System Command Modules

- [RC-11 L7] register_active_pid / unregister_active_pid -- Frontend registers OS PIDs of PTY children; RunEvent::Exit handler in lib.rs iterates ActivePids and calls kill_process_tree_sync for each.
- [RC-13 L278] kill_orphan_sessions: takes Vec<String> session IDs, finds processes by command line match (WMIC on Windows, pgrep on Unix). Checks for other running claude-tabs instances first -- processes that are descendants of another instance are skipped. Only kills true orphans from crashed/force-closed instances. Returns count of killed processes.
- [RC-14 L506] send_notification: Custom WinRT toast command bypassing Tauri notification plugin. Uses tauri-winrt-notification Toast with on_activated callback that emits notification-clicked event to frontend. Dev mode uses PowerShell app ID, production uses bundle identifier. spawn_blocking + CREATE_NO_WINDOW compliant.

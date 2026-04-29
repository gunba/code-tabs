---
paths:
  - "src-tauri/src/commands/file_ops.rs"
---

# src-tauri/src/commands/file_ops.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Rust Session Commands

- [RC-23 L20] paths_exist Tauri command in src-tauri/src/commands/file_ops.rs:L17 stats a batch of paths in parallel via spawn_blocking and returns Vec<PathStatus> {path, exists, is_dir} in input order. Used by two callers: (1) terminalPathLinks.ts for batch-validating path candidates before emitting clickable links; (2) runGitScanAndValidate in useTapEventProcessor on settled-idle to confirm activity entries against the filesystem.

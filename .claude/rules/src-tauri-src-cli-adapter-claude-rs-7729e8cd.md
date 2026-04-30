---
paths:
  - "src-tauri/src/cli_adapter/claude.rs"
---

# src-tauri/src/cli_adapter/claude.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Rust System Command Modules

- [RC-20 L47] Claude subprocess helpers avoid inherited debugger env contamination and Bun stdout pipe truncation: run_claude_cli removes Bun/Node inspector env vars and captures stdout/stderr through temp files, while ClaudeAdapter leaves env overrides empty.
  - Source refs: src-tauri/src/commands/cli.rs run_claude_cli strips BUN_INSPECT*/NODE_* env and redirects stdout/stderr to TempCliOutputFile to avoid pipe flush truncation; src-tauri/src/cli_adapter/claude.rs delegates args/program discovery and does not re-encode env cleanup in the adapter.

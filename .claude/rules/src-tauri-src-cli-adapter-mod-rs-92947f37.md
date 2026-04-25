---
paths:
  - "src-tauri/src/cli_adapter/mod.rs"
---

# src-tauri/src/cli_adapter/mod.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Rust Command Modules

- [RC-16 L39] read_claude_binary(cli_path) resolves Claude Code binary through 5-step chain: direct CLI path -> .cmd shim parse -> sibling node_modules -> legacy versions dir -> npm root -g. Implementation lives in crate::discovery (src-tauri/src/discovery/mod.rs); cli.rs re-exports and delegates to it. Enables slash command/settings discovery on standalone installs.

## Codex CLI Adapter

- [CC-01 L100] CliAdapter trait (src-tauri/src/cli_adapter/mod.rs) defines the per-CLI seam: detect(), version(), build_spawn(), and launch_options() methods. Enum-dispatched via adapter_for(CliKind) returning Box<dyn CliAdapter>. CliKind::Claude maps to ClaudeAdapter; CliKind::Codex maps to CodexAdapter. No dyn-trait churn at call sites — all dispatch goes through adapter_for().
- [CC-02 L135] build_cli_spawn Tauri command (cli_adapter/mod.rs) accepts a SessionConfig, reads config.cli to select the adapter, and delegates to adapter.build_spawn(). Returns a SpawnSpec {program, args, env_overrides, cwd} for the PTY layer. cli_launch_options Tauri command returns LaunchOptions {models, effort_levels, permission_modes, flag_pills} by calling adapter.launch_options() for the requested CliKind.

## PTY Spawn

- [PT-03 L32] CLAUDECODE env var is stripped at Rust app startup (lib.rs) so spawned PTYs do not think they are nested inside another Claude Code session.

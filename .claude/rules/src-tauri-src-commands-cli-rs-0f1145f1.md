---
paths:
  - "src-tauri/src/commands/cli.rs"
---

# src-tauri/src/commands/cli.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Rust Command Modules

- [RC-05 L72] detect_claude_cli / check_cli_version / get_cli_help -- CLI discovery. spawn_blocking + CREATE_NO_WINDOW compliant.
- [RC-16 L335] read_claude_binary(cli_path) resolves Claude Code binary through 5-step chain: direct CLI path -> .cmd shim parse -> sibling node_modules -> legacy versions dir -> npm root -g. Implementation lives in crate::discovery (src-tauri/src/discovery/mod.rs); cli.rs re-exports and delegates to it. Enables slash command/settings discovery on standalone installs.
- [RC-09 L338] discover_builtin_commands / discover_plugin_commands -- Slash command discovery Tauri wrappers in cli.rs; sync implementations (discover_builtin_commands_sync, discover_plugin_commands_sync) live in crate::discovery (src-tauri/src/discovery/mod.rs). Two-step binary scan (name:"..." positions + forward/reverse brace-bounded window for descriptions). Filters: skips /-- prefixed names, skips descriptions containing 'tab ID' or 'DOM', requires cmd length 4-30 chars. Deduplicates by command name. Plugin discovery also returns rejection reasons logged as WARN events.
- [RC-02 L535] build_claude_args maps SessionConfig to Claude CLI args, including --resume/--continue, boolean --fork-session modifiers, --session-id only for non-resume launches, --project-dir, tools, prompts, and raw extra flags.
  - Fork launch args are emitted as --resume <id> --fork-session or --continue --fork-session. Code Tabs deliberately omits --session-id for resume/continue/fork launches so Claude generates the fork id and TAP records it after launch.

## Respawn & Resume

- [RS-05 L657] build_claude_args skips --session-id whenever --resume or --continue is used, including fork launches.
  - Claude may accept --session-id together with --fork-session, but Code Tabs avoids pinning the new fork id: it sends --resume <id> --fork-session or --continue --fork-session and records the generated sessionId from TAP.

## Rust System Command Modules

- [RC-20 L203] Claude subprocess helpers avoid inherited debugger env contamination and Bun stdout pipe truncation: run_claude_cli removes Bun/Node inspector env vars and captures stdout/stderr through temp files, while ClaudeAdapter leaves env overrides empty.
  - Source refs: src-tauri/src/commands/cli.rs run_claude_cli strips BUN_INSPECT*/NODE_* env and redirects stdout/stderr to TempCliOutputFile to avoid pipe flush truncation; src-tauri/src/cli_adapter/claude.rs delegates args/program discovery and does not re-encode env cleanup in the adapter.
- [RC-18 L856] Plugin management IPC: plugin_list (claude plugin list --available --json), plugin_install (--scope), plugin_uninstall, plugin_enable, plugin_disable. All async with spawn_blocking + CREATE_NO_WINDOW (via run_claude_cli helper). Raw JSON passthrough for plugin_list; string result for mutations.

## Config Schema and Providers

- [CM-03 L460] Project directory selector: when multiple working dirs exist across sessions, the config modal header shows a dropdown to switch between project-level scopes. settingsSchema.ts builds the schema; fetch_settings_schema provides the Rust backend.

## Development Rules

- [DR-07 L127] All Rust commands that spawn subprocesses MUST add `CREATE_NO_WINDOW` flag on Windows (`cmd.creation_flags(0x08000000)`)
- [DR-06 L278] All Rust commands that spawn subprocesses MUST use `tokio::task::spawn_blocking()` to avoid blocking the WebView event loop

---
paths:
  - "src-tauri/src/commands/cli.rs"
---

# src-tauri/src/commands/cli.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Rust Command Modules

- [RC-05 L32] detect_claude_cli / check_cli_version / get_cli_help -- CLI discovery. spawn_blocking + CREATE_NO_WINDOW compliant.
- [RC-16 L300] read_claude_binary(cli_path) resolves Claude Code binary through 5-step chain: direct CLI path -> .cmd shim parse -> sibling node_modules -> legacy versions dir -> npm root -g. Implementation lives in crate::discovery (src-tauri/src/discovery/mod.rs); cli.rs re-exports and delegates to it. Enables slash command/settings discovery on standalone installs.
- [RC-09 L303] discover_builtin_commands / discover_plugin_commands -- Slash command discovery Tauri wrappers in cli.rs; sync implementations (discover_builtin_commands_sync, discover_plugin_commands_sync) live in crate::discovery (src-tauri/src/discovery/mod.rs). Two-step binary scan (name:"..." positions + forward/reverse brace-bounded window for descriptions). Filters: skips /-- prefixed names, skips descriptions containing 'tab ID' or 'DOM', requires cmd length 4-30 chars. Deduplicates by command name. Plugin discovery also returns rejection reasons logged as WARN events.
- [RC-02 L500] build_claude_args -- SessionConfig -> CLI args (--resume, --session-id, --project-dir, etc.)

## Respawn & Resume

- [RS-05 L621] Skip `--session-id` CLI arg when using `--resume` or `--continue`

## Rust System Command Modules

- [RC-20 L163] resolve_api_host: hardcoded DNS resolution of api.anthropic.com via spawn_blocking + ToSocketAddrs. 5s tokio::time::timeout. Returns Cloudflare edge IP string. No parameters (least privilege). Registered in generate_handler. source: src-tauri/src/commands/config.rs:L605,L609
- [RC-18 L831] Plugin management IPC: plugin_list (claude plugin list --available --json), plugin_install (--scope), plugin_uninstall, plugin_enable, plugin_disable. All async with spawn_blocking + CREATE_NO_WINDOW (via run_claude_cli helper). Raw JSON passthrough for plugin_list; string result for mutations.

## Config Schema and Providers

- [CM-03 L425] Project directory selector: when multiple working dirs exist across sessions, the config modal header shows a dropdown to switch between project-level scopes. settingsSchema.ts builds the schema; fetch_settings_schema provides the Rust backend.

## Development Rules

- [DR-07 L87] All Rust commands that spawn subprocesses MUST add `CREATE_NO_WINDOW` flag on Windows (`cmd.creation_flags(0x08000000)`)
- [DR-06 L243] All Rust commands that spawn subprocesses MUST use `tokio::task::spawn_blocking()` to avoid blocking the WebView event loop

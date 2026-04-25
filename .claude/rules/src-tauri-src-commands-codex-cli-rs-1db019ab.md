---
paths:
  - "src-tauri/src/commands/codex_cli.rs"
---

# src-tauri/src/commands/codex_cli.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Codex CLI Introspection

- [CO-01 L163] discover_codex_models uses 'codex debug models' JSON output. Response envelope: {models: [{slug, display_name?, description?, default_reasoning_level?, supported_reasoning_levels: [{effort, description?}], visibility?, priority?, supported_in_api}]}. Filters out models where visibility != 'list' (hidden models excluded). Result drives the model picker in LaunchOptions.
- [CO-02 L255] discover_codex_cli_options uses 'codex --help' regex parsing (parse_help_options). Regex matches lines with 2+ leading spaces followed by optional short flag (-X), long flag (--word), and optional value placeholder (<VAL> or [VAL]). Indented continuation lines are appended to the preceding option's description (up to 200 chars). Non-indented non-empty lines (section headers) end continuation. Result: Vec<CodexCliOption {flag, short, description, takes_value}>.
- [CO-03 L493] CODEX_SLASH_COMMANDS is a vendored catalog of Codex TUI slash commands (35+ entries, expanded from 25 to include /fast, /experimental, /memories, /collab, /agent, /side, /ps, /stop, /personality, /realtime, /settings, /subagents, /feedback, /setup-default-sandbox, /sandbox-add-read-dir, /fork, /new, /rename). Vendored because Codex doesn't expose slash commands via CLI (binary is stripped Rust; no subcommand to list them). Exposed via discover_codex_slash_commands Tauri command. Last verified against codex-rs/tui/src/slash_command.rs.

## Codex CLI Discovery

- [CL-01 L651] get_codex_cli_help runs 'codex --help' via spawn_blocking on the Tauri async runtime. discover_codex_slash_commands is an async Tauri command that defers the binary read to spawn_blocking so the ~196MB native binary scan never blocks the runtime thread. discover_codex_slash_commands_sync filters CODEX_SLASH_COMMANDS by memchr::memmem::find probes against the resolved native binary path; resolve_codex_native_binary_path resolves the Codex CLI launcher to the @openai/codex-<triple> vendor path when the launcher is a .js shim. Falls back to the full vendored list only when the filter returned nothing (binary unreadable / shape unexpected) — a non-empty filtered list is trusted in full.
- [CL-02 L688] /sandbox-add-read-dir is gated to Windows only via codex_slash_command_visible_on_platform(), mirroring codex-rs/tui/src/slash_command.rs:214. Both the binary-probe filter path and the fallback vendored-list path run through this gate. Codex has expanded the vendored catalog to 35+ commands including /fast, /experimental, /memories, /collab, /agent, /side, /new, /fork, /rename, /ps, /stop, /personality, /realtime, /settings, /subagents, /feedback, /setup-default-sandbox.

---
paths:
  - "src-tauri/src/commands/codex_cli.rs"
---

# src-tauri/src/commands/codex_cli.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Codex CLI Introspection

- [CO-01 L156] discover_codex_models uses 'codex debug models' JSON output. Response envelope: {models: [{slug, display_name?, description?, default_reasoning_level?, supported_reasoning_levels: [{effort, description?}], visibility?, priority?, supported_in_api}]}. Filters out models where visibility != 'list' (hidden models excluded). Result drives the model picker in LaunchOptions.
- [CO-02 L248] discover_codex_cli_options uses 'codex --help' regex parsing (parse_help_options). Regex matches lines with 2+ leading spaces followed by optional short flag (-X), long flag (--word), and optional value placeholder (<VAL> or [VAL]). Indented continuation lines are appended to the preceding option's description (up to 200 chars). Non-indented non-empty lines (section headers) end continuation. Result: Vec<CodexCliOption {flag, short, description, takes_value}>.
- [CO-03 L486] CODEX_SLASH_COMMANDS is a vendored catalog of Codex TUI slash commands (25 entries: /init, /compact, /review, /diff, /status, /model, /approvals, /permissions, /skills, /mcp, /plan, /goal, /resume, /fork, /new, /rename, /clear, /copy, /mention, /theme, /statusline, /personality, /feedback, /logout, /quit, /exit). Vendored because Codex doesn't expose slash commands via CLI (binary is stripped Rust; no subcommand to list them). Exposed via discover_codex_slash_commands Tauri command. Last verified against codex-rs/tui/src/slash_command.rs.

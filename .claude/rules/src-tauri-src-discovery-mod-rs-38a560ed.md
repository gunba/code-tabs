---
paths:
  - "src-tauri/src/discovery/mod.rs"
---

# src-tauri/src/discovery/mod.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Discovery Module

- [DM-01 L8] Discovery functions (read_claude_binary, discover_builtin_commands_sync, discover_settings_schema_sync, discover_env_vars_sync, discover_plugin_commands_sync, env_var_catalog) are pure sync primitives isolated in crate::discovery (src-tauri/src/discovery/mod.rs). The Tauri command wrappers in cli.rs import and delegate to these, enabling the same code to run in both the runtime app and the standalone discover_audit binary — one pipeline, one truth.
- [DM-02 L1391] scan_skill_md implements Claude Code's skill resolution order: name = frontmatter 'name:' if present, else parent directory name (must be a valid slug: ASCII letter start, alphanumeric/-/_). description = frontmatter 'description:' if present, else first non-empty body line (truncated to 120 chars). A SKILL.md is rejected only when both name sources fail; rejection reason is returned to the Tauri caller for WARN-level observability logging.

## Rust Command Modules

- [RC-16 L28] read_claude_binary(cli_path) resolves Claude Code binary through 5-step chain: direct CLI path -> .cmd shim parse -> sibling node_modules -> legacy versions dir -> npm root -g. Implementation lives in crate::discovery (src-tauri/src/discovery/mod.rs); cli.rs re-exports and delegates to it. Enables slash command/settings discovery on standalone installs.

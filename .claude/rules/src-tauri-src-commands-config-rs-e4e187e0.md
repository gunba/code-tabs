---
paths:
  - "src-tauri/src/commands/config.rs"
---

# src-tauri/src/commands/config.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Rust System Command Modules

- [RC-10 L57] discover_hooks / save_hooks -- Hook configuration. save_hooks merges hooks into existing settings file (preserves other keys).
- [RC-12 L232] Config files read/write: read_config_file and write_config_file handle settings JSON, CLAUDE.md (3 scopes), and agent/skill files. list_agents and list_skills take scope param. Parent dirs auto-created on write.
- [RC-20 L486] resolve_api_host: hardcoded DNS resolution of api.anthropic.com via spawn_blocking + ToSocketAddrs. 5s tokio::time::timeout. Returns Cloudflare edge IP string. No parameters (least privilege). Registered in generate_handler.

## Hooks Manager

- [HM-02 L90] Scope separation: Rust backend returns distinct keys per scope — project and project-local hooks never conflated

## Config Schema and Providers

- [CM-08 L233] Save via Rust read_config_file/write_config_file commands (JSON validated before write, parent dirs auto-created).

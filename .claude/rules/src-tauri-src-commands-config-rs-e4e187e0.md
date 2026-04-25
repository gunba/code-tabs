---
paths:
  - "src-tauri/src/commands/config.rs"
---

# src-tauri/src/commands/config.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Codex Config Editing

- [CD-01 L173] codex_config_path maps scope (user|project) to ~/.codex/config.toml or <project>/.codex/config.toml. codex_hooks_json_path derives the sibling hooks.json path. read_codex_config_value returns an empty TOML table when the file is absent or empty; write_codex_config_value serializes TOML and uses atomic_write (same-directory temp+rename) to prevent partial reads. write_config_file validates TOML before write when file_type=='codex-config'. json_to_toml_value returns Option<toml::Value> and drops null keys (TOML has no null; coercing to empty string would silently corrupt explicit-null env vars). file_type variants: codex-config, agentsmd-user (~/.codex/AGENTS.md), agentsmd-root (<project>/AGENTS.md), agentsmd-local (<project>/AGENTS.local.md), codex-skill:<name> and codex-skill-delete:<name> (paths to ~/.agents/skills/<name>/SKILL.md or <project>/.agents/skills/<name>/SKILL.md).

## Codex Hooks Discovery and Save

- [CH-01 L301] discover_codex_hooks reads config.toml [hooks] for each scope, then reads the sibling hooks.json (if present) and merge_hook_values appends each hook only if it isn't already present (content-equal dedup), so cross-source duplicates collapse on read. save_codex_hooks writes the UI's hooks payload to config.toml [hooks], rewrites hooks.json to '{}' when it exists so the read merge can't double-source on the next load, and idempotently sets features.codex_hooks=true (only when not already true). HooksPane remaps scope 'project-local' to 'project' when cli==='codex' (Codex has no local-scope hooks file). CODEX_HOOK_EVENTS: PreToolUse, PermissionRequest, PostToolUse, SessionStart, UserPromptSubmit, Stop.

## Codex MCP Servers

- [CE-01 L1472] read_codex_mcp_servers reads config.toml [mcp_servers] for the given scope; write_codex_mcp_servers writes it back using atomic TOML write. McpPane uses invoke('read_codex_mcp_servers'/'write_codex_mcp_servers') for cli==='codex'. HTTP MCPs serialize as bare {url, http_headers} (no 'type' or 'transport' wrapper, per Codex docs); McpPane buildEntry omits entry.type for Codex and uses http_headers key instead of headers. Transport dropdown for Codex shows stdio|sse|http. On edit, stale type/transport fields are deleted per-cli before writing.

## Codex Skills Discovery

- [CS-01 L1055] list_codex_skill_files lists subdirectories containing SKILL.md under ~/.agents/skills (user scope) or <project>/.agents/skills (project scope). Each entry has {name, path, kind: 'skill', cli: 'codex'}. resolve_config_path for codex-skill:<name> resolves to ~/.agents/skills/<name>/SKILL.md (user) or <project>/.agents/skills/<name>/SKILL.md (project). codex-skill-delete:<name> removes the enclosing skill directory (not just SKILL.md).

## Rust System Command Modules

- [RC-10 L58] discover_hooks / save_hooks -- Hook configuration. save_hooks merges hooks into existing settings file (preserves other keys).
- [RC-12 L474] Config files read/write: read_config_file and write_config_file handle settings JSON, CLAUDE.md (3 scopes), agent/skill files, and codex-config (~/.codex/config.toml for scope=user; <project>/.codex/config.toml for scope=project). write_config_file validates JSON before write for settings, validates TOML before write for codex-config. list_agents and list_skills take scope param. Parent dirs auto-created on write.
- [RT-02 L1457,1583] read_mcp_servers / write_mcp_servers: Tauri commands that read and write MCP server configs from/to ~/.claude.json (not settings.json). User scope reads/writes top-level mcpServers key; project scope reads/writes projects[working_dir].mcpServers. write_mcp_servers preserves all other keys in the file. source: src-tauri/src/commands/config.rs:L527,L539
- [RC-20 L1615] resolve_api_host: hardcoded DNS resolution of api.anthropic.com via spawn_blocking + ToSocketAddrs. 5s tokio::time::timeout. Returns Cloudflare edge IP string. No parameters (least privilege). Registered in generate_handler. source: src-tauri/src/commands/config.rs:L605,L609

## Config Schema and Providers

- [CM-08 L475] Save via Rust read_config_file/write_config_file commands (JSON validated before write, parent dirs auto-created).

## Hooks Manager

- [HM-02 L91] Scope separation: Rust backend returns distinct keys per scope — project and project-local hooks never conflated

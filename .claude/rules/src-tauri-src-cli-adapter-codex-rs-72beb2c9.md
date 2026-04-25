---
paths:
  - "src-tauri/src/cli_adapter/codex.rs"
---

# src-tauri/src/cli_adapter/codex.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Codex CLI Adapter

- [CC-03 L110] PermissionMode-to-Codex-flag mapping in codex.rs is locked/documented: Default -> --sandbox workspace-write; AcceptEdits -> --sandbox workspace-write --ask-for-approval never; BypassPermissions -> --dangerously-bypass-approvals-and-sandbox; DontAsk -> --sandbox workspace-write --ask-for-approval never (pinned explicitly so future Codex default changes can't weaken semantics); PlanMode -> --sandbox read-only --ask-for-approval untrusted; Auto -> --full-auto.
- [CC-05 L276] system_prompt / append_system_prompt are now mapped to Codex's developer_instructions config key via '-c developer_instructions=<TOML-quoted>'. codex_developer_instructions() returns system_prompt falling back to append_system_prompt (trimmed, non-empty). quote_toml_value uses serde_json::to_string so Unicode escapes, newlines, and special chars are handled correctly (was a manual replace('"', '\\"') before).

---
paths:
  - "src-tauri/src/cli_adapter/codex.rs"
---

# src-tauri/src/cli_adapter/codex.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Codex CLI Adapter

- [CC-08 L25] CODEX_EFFORT_VALUES enum gate: codex.rs:CODEX_EFFORT_VALUES = ["none","minimal","low","medium","high","xhigh"] mirrors the model_reasoning_effort enum in the bundled ConfigToml schema (src-tauri/src/discovery/codex_schema.json model_reasoning_effort#enum). build_spawn skips the -c model_reasoning_effort=... override when the SessionConfig.effort is not in the enum, so a stale Claude-side value such as 'max' (Anthropic effort levels) never reaches Codex's config.toml parser at launch (which would error out). The frontend mirrors the same Set in SessionLauncher.tsx so the displayed CLI command preview matches what build_spawn will actually emit. SessionLauncher additionally clears adapterModels/adapterEfforts synchronously on cli switch (commit cb811e1) so the validator effect drops a stale config.effort/config.model before the new options arrive.
- [CC-03 L127] PermissionMode-to-Codex-flag mapping in codex.rs is locked/documented: Default -> --sandbox workspace-write; AcceptEdits -> --sandbox workspace-write --ask-for-approval never; BypassPermissions -> --dangerously-bypass-approvals-and-sandbox; DontAsk -> --sandbox workspace-write --ask-for-approval never (pinned explicitly so future Codex default changes can't weaken semantics); PlanMode -> --sandbox read-only --ask-for-approval untrusted; Auto -> --full-auto.
- [CC-05 L290] system_prompt -> instructions config override (replaces OpenAI Responses base instructions); append_system_prompt -> developer_instructions config override (additive developer-role message). codex_system_instructions(cfg) returns trimmed cfg.system_prompt if non-empty; codex_developer_instructions(cfg) returns trimmed cfg.append_system_prompt if non-empty. Both pushed via -c <key>=<value> args, value quoted via quote_toml_value (serde_json::to_string for correct Unicode + newline + quote escaping).

---
paths:
  - "src-tauri/src/cli_adapter/codex.rs"
---

# src-tauri/src/cli_adapter/codex.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Codex CLI Adapter

- [CC-03 L100] PermissionMode-to-Codex-flag mapping in codex.rs is locked/documented: Default -> --sandbox workspace-write; AcceptEdits -> --sandbox workspace-write --ask-for-approval never; BypassPermissions -> --dangerously-bypass-approvals-and-sandbox; DontAsk -> --sandbox workspace-write --ask-for-approval never (pinned explicitly so future Codex default changes can't weaken semantics); PlanMode -> --sandbox read-only --ask-for-approval untrusted; Auto -> --full-auto.

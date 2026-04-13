---
paths:
  - "src-tauri/src/proxy/codex/translate_req.rs"
---

# src-tauri/src/proxy/codex/translate_req.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Provider Routing
Session-bound provider routing, OpenAI Codex provider config, and auth-backed request translation.

- [PR-11 L34] Codex request translation maps Claude fast-mode requests onto Codex priority service tier so fast-mode transport semantics are preserved instead of being dropped at the proxy.

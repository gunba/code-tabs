---
paths:
  - "src-tauri/src/proxy/mod.rs"
---

# src-tauri/src/proxy/mod.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Provider Routing
Session-bound provider routing, OpenAI Codex provider config, and auth-backed request translation.

- [PR-10 L794] OpenAI Codex sessions bind both the original provider model and the client-visible launch carrier; the proxy preserves the Claude carrier in request and response bodies while routing upstream with the stored provider model until the session explicitly switches models.
- [PR-01 L1204] TerminalPanel points Claude at a session-scoped proxy URL (/s/{sessionId}) and binds each session to providerId; the Rust proxy resolves that session-bound provider, applies provider-local modelMappings, and falls back to the default provider when no binding is present.

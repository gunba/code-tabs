---
paths:
  - "src-tauri/src/proxy/codex/auth.rs"
---

# src-tauri/src/proxy/codex/auth.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Provider Routing
Session-bound provider routing, OpenAI Codex provider config, and auth-backed request translation.

- [PR-02 L30] OpenAI Codex is exposed as a predefined openai_codex provider with canonical primary/small models, 272k context mappings, and persisted-config migration backfills; ProvidersPane shows OAuth login/logout state, SessionLauncher blocks non-utility Codex launches until auth is available, and the Rust adapter translates Anthropic-style requests and streaming responses through the OpenAI Responses API.

---
paths:
  - "src-tauri/src/proxy/codex/mod.rs"
---

# src-tauri/src/proxy/codex/mod.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Provider Routing
Session-bound provider routing, OpenAI Codex provider config, and auth-backed request translation.

- [PR-06 L21] Codex upstream requests identify as CLI-style traffic by sending the codex_cli_rs originator, a Codex-formatted user-agent, and per-session request IDs so OpenAI usage reporting can classify interactive sessions consistently.
- [PR-04 L44] Codex proxy shaping normalizes short Claude aliases like best, opusplan, sonnet, and haiku to the correct OpenAI primary or small model, and clamps oversized Read.limit tool calls before execution while recording adjusted tool-call IDs and counts in translation summaries.
- [PR-02 L90] OpenAI Codex is exposed as a predefined openai_codex provider with canonical primary/small models, 272k context mappings, and persisted-config migration backfills; ProvidersPane shows OAuth login/logout state, SessionLauncher blocks non-utility Codex launches until auth is available, and the Rust adapter translates Anthropic-style requests and streaming responses through the OpenAI Responses API.
- [PR-12 L132] Synthetic Codex model metadata is derived from provider catalog state so future OpenAI model additions inherit the configured IDs and context windows instead of relying on hardcoded GPT-family defaults.
- [PR-05 L192,364] Codex traffic logging preserves the translated upstream OpenAI request payload so raw Anthropic requests can be compared against the rewritten upstream body in observability logs.

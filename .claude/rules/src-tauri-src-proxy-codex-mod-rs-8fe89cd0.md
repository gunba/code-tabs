---
paths:
  - "src-tauri/src/proxy/codex/mod.rs"
---

# src-tauri/src/proxy/codex/mod.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Provider Routing
Session-bound provider routing, OpenAI Codex provider config, and auth-backed request translation.

- [PR-06 L23] Codex upstream requests identify as CLI-style traffic by sending the codex_cli_rs originator, a Codex-formatted user-agent, and per-session request IDs so OpenAI usage reporting can classify interactive sessions consistently.
- [PR-04 L66] Codex proxy shaping normalizes short Claude aliases best, opusplan, sonnet, opus, and haiku (and any model starting with 'claude') to the configured primary or small OpenAI Codex model (default: gpt-5.5 / gpt-5.5-mini). Strips [1m] context suffix and ANSI bracket codes before matching. Non-Claude model strings pass through unchanged. source: src-tauri/src/proxy/codex/mod.rs:L44
- [PR-02 L112] OpenAI Codex is exposed as a predefined openai_codex provider with canonical primary/small models, 272k context mappings, and persisted-config migration backfills; ProvidersPane shows OAuth login/logout state, SessionLauncher blocks non-utility Codex launches until auth is available, and the Rust adapter translates Anthropic-style requests and streaming responses through the OpenAI Responses API.
- [PR-12 L154] Synthetic Codex model metadata is derived from provider catalog state so future OpenAI model additions inherit the configured IDs and context windows instead of relying on hardcoded GPT-family defaults.
- [PR-05 L214,420] Codex traffic logging preserves the translated upstream OpenAI request payload so raw Anthropic requests can be compared against the rewritten upstream body in observability logs.
- [PR-14 L344,945] Codex quota-probe short-circuit: is_quota_probe() detects Claude Code's periodic {max_tokens:1, messages:[{role:'user', content:'quota'}]} auth check and returns a canned 200 SSE or JSON response without hitting the upstream Codex API (which would 400 on missing 'instructions' field). Avoids token waste and spurious errors. source: src-tauri/src/proxy/codex/mod.rs:L323,L915
- [PR-15 L919] Codex SSE 4xx error framing: when the Codex upstream returns a non-2xx status and the client requested SSE (stream:true), send_codex_upstream_error() returns HTTP 200 OK with Content-Type text/event-stream and an Anthropic-shaped 'event: error' SSE frame rather than a plain JSON error body, so the client's SSE parser can consume it. Non-streaming errors return a plain JSON error response. source: src-tauri/src/proxy/codex/mod.rs:L562,L890

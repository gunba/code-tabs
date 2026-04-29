---
paths:
  - "src-tauri/src/proxy/mod.rs"
---

# src-tauri/src/proxy/mod.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Slimmed Proxy

- [SP-01 L3] Slimmed proxy (src-tauri/src/proxy/mod.rs, ~700 lines from 1909): system-prompt rewrite + traffic logging only. Forwards POST /v1/messages to https://api.anthropic.com literally. Applies user-defined regex rules to request system field (PromptsTab) before forwarding. Optionally tees request/response to per-session traffic.jsonl. No provider routing, model translation, OAuth, or compression. proxy/codex/ and proxy/compress/ submodules deleted. Codex sessions bypass proxy entirely.
- [SP-02 L594] Per-request upstream resolver routes to https://api.anthropic.com or https://api.openai.com based on path. is_anthropic_endpoint matches /v1/messages and /v1/complete (path_matches_endpoint accepts exact, ?-suffix querystring, or /-suffix subpath). is_openai_responses_endpoint matches /v1/responses (same matcher). resolve_upstream returns Anthropic for anthropic endpoints, OpenAI for any other /v1/* path, Anthropic for non-/v1/ paths (default fallback). rewrite_openai_instructions_in_body applies enabled prompt-rewrite rules to top-level json["instructions"] string (Codex/OpenAI Responses analog of Claude's system field). Traffic logs include 'upstream' label (anthropic|openai) on every request/response/error event.
  - src-tauri/src/proxy/mod.rs:L429 (UpstreamKind enum), src-tauri/src/proxy/mod.rs:L454 (path_matches_endpoint), src-tauri/src/proxy/mod.rs:L461 (is_anthropic_endpoint), src-tauri/src/proxy/mod.rs:L465 (is_openai_responses_endpoint), src-tauri/src/proxy/mod.rs:L469 (resolve_upstream), src-tauri/src/proxy/mod.rs:L849 (rewrite_openai_instructions_in_body)

## Config Schema and Providers

- [CM-32 L441] Per-session rule match counters: ProxyState.rule_match_counts (HashMap<String, u64>) tracks how many times each prompt-rewrite rule (by rule ID) has matched a proxied request this session. Incremented in the proxy request handler for each matched rule ID. Exposed via get_rule_match_counts Tauri command (sync, returns clone of the map). PromptsTab polls this on a 2-second interval while the Rules sub-tab is active and displays match counts inline on each rule card: '0 matches' shows as 'never fired' (muted). Counter map is pruned to active rule IDs on each settings update.
  - src-tauri/src/proxy/mod.rs:L524; src/components/ConfigManager/PromptsTab.tsx:L232

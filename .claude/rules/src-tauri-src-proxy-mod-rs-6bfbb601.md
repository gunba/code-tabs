---
paths:
  - "src-tauri/src/proxy/mod.rs"
---

# src-tauri/src/proxy/mod.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Slimmed Proxy

- [SP-01 L3] Slim prompt-rewrite proxy at src-tauri/src/proxy/mod.rs forwards POST /v1/messages to https://api.anthropic.com and OpenAI Responses traffic (POST /v1/responses or /backend-api/codex/responses) to api.openai.com/chatgpt.com. It applies user-defined regex rules scoped by CLI: Claude rules rewrite Anthropic system text, Codex rules rewrite Responses prompt fields (top-level instructions, developer/system input_text blocks, and marked contextual user prompt blocks such as AGENTS.md and skill payloads) before forwarding; ordinary user input_text is not rewritten. It optionally tees request/response to per-session traffic.jsonl, classifies fresh user turns vs tool-result follow-ups, and emits user-turn-started-{sessionId} on UserTurn so the frontend response panel clears at real send time. No model translation, OAuth, or compression.
- [SP-02 L585] Per-request upstream resolver routes Anthropic endpoints (/v1/messages and /v1/complete), OpenAI /v1/* endpoints, and ChatGPT Codex /backend-api/codex/* endpoints through UpstreamKind. path_matches_endpoint accepts exact matches, ? query suffixes, or / subpaths; is_chatgpt_responses_endpoint is intentionally limited to /backend-api/codex/responses for rewrites. rewrite_openai_prompt_in_body applies enabled Codex-scoped prompt-rewrite rules to Responses json["instructions"], developer/system input_text content, and marked contextual user input_text blocks matching Codex AGENTS.md (# AGENTS.md instructions for ... </INSTRUCTIONS>) or skill (<skill>...</skill>) markers; ordinary user-role input_text is skipped. Traffic logs include an upstream label (anthropic|openai|chatgpt) on request/response/error events.
  - src-tauri/src/proxy/mod.rs:L585 (UpstreamKind/routing rule tag), src-tauri/src/proxy/mod.rs:L611 (path_matches_endpoint), src-tauri/src/proxy/mod.rs:L618 (is_anthropic_endpoint), src-tauri/src/proxy/mod.rs:L622 (is_openai_responses_endpoint), src-tauri/src/proxy/mod.rs:L629 (is_chatgpt_responses_endpoint), src-tauri/src/proxy/mod.rs:L641 (resolve_upstream), src-tauri/src/proxy/mod.rs:L1158 (rewrite_openai_prompt_in_body), src-tauri/src/proxy/mod.rs:L1209 (apply_rules_to_openai_input), src-tauri/src/proxy/mod.rs:L1248 (is_codex_contextual_prompt_user_text), src-tauri/src/proxy/mod.rs:L1270 (apply_rules_to_text CLI filter)

## Config Schema and Providers

- [CM-32 L428] Per-session rule match counters: ProxyState.rule_match_counts (HashMap<String, u64>) tracks how many times each prompt-rewrite rule (by rule ID) has matched a proxied request this session. Incremented in the proxy request handler for each matched rule ID. Exposed via get_rule_match_counts Tauri command (sync, returns clone of the map). PromptsTab polls this on a 2-second interval while the Rules sub-tab is active and displays match counts inline on each rule card: '0 matches' shows as 'never fired' (muted). Counter map is pruned to active rule IDs on each settings update.
  - src-tauri/src/proxy/mod.rs:L524; src/components/ConfigManager/PromptsTab.tsx:L232

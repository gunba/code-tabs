---
paths:
  - "src-tauri/src/proxy/mod.rs"
---

# src-tauri/src/proxy/mod.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Config Schema and Providers

- [CM-32 L522] Per-session rule match counters: ProxyState.rule_match_counts (HashMap<String, u64>) tracks how many times each prompt-rewrite rule (by rule ID) has matched a proxied request this session. Incremented in the proxy request handler for each matched rule ID. Exposed via get_rule_match_counts Tauri command (sync, returns clone of the map). PromptsTab polls this on a 2-second interval while the Rules sub-tab is active and displays match counts inline on each rule card: '0 matches' shows as 'never fired' (muted). Counter map is pruned to active rule IDs on each settings update.
  - src-tauri/src/proxy/mod.rs:L524; src/components/ConfigManager/PromptsTab.tsx:L232

## Provider Routing
Session-bound provider routing, OpenAI Codex provider config, and auth-backed request translation.

- [PR-10 L810] OpenAI Codex sessions bind both the original provider model and the client-visible launch carrier; the proxy preserves the Claude carrier in request and response bodies while routing upstream with the stored provider model until the session explicitly switches models.
- [PR-01 L1228] TerminalPanel points Claude at a session-scoped proxy URL (/s/{sessionId}) and binds each session to providerId; the Rust proxy resolves that session-bound provider, applies provider-local modelMappings, and falls back to the default provider when no binding is present.

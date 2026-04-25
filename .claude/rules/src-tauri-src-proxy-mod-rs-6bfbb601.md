---
paths:
  - "src-tauri/src/proxy/mod.rs"
---

# src-tauri/src/proxy/mod.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Slimmed Proxy

- [SP-01 L3] Slimmed proxy (src-tauri/src/proxy/mod.rs, ~700 lines from 1909): system-prompt rewrite + traffic logging only. Forwards POST /v1/messages to https://api.anthropic.com literally. Applies user-defined regex rules to request system field (PromptsTab) before forwarding. Optionally tees request/response to per-session traffic.jsonl. No provider routing, model translation, OAuth, or compression. proxy/codex/ and proxy/compress/ submodules deleted. Codex sessions bypass proxy entirely.

## Config Schema and Providers

- [CM-32 L283] Per-session rule match counters: ProxyState.rule_match_counts (HashMap<String, u64>) tracks how many times each prompt-rewrite rule (by rule ID) has matched a proxied request this session. Incremented in the proxy request handler for each matched rule ID. Exposed via get_rule_match_counts Tauri command (sync, returns clone of the map). PromptsTab polls this on a 2-second interval while the Rules sub-tab is active and displays match counts inline on each rule card: '0 matches' shows as 'never fired' (muted). Counter map is pruned to active rule IDs on each settings update.
  - src-tauri/src/proxy/mod.rs:L524; src/components/ConfigManager/PromptsTab.tsx:L232

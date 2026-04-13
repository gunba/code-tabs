---
paths:
  - "src-tauri/src/proxy/codex/translate_resp.rs"
---

# src-tauri/src/proxy/codex/translate_resp.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Provider Routing
Session-bound provider routing, OpenAI Codex provider config, and auth-backed request translation.

- [PR-04 L38] Codex proxy shaping normalizes short Claude aliases like best, opusplan, sonnet, and haiku to the correct OpenAI primary or small model, and clamps oversized Read.limit tool calls before execution while recording adjusted tool-call IDs and counts in translation summaries.

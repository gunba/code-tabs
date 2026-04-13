---
paths:
  - "src/lib/providerLaunch.ts"
---

# src/lib/providerLaunch.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Provider Routing
Session-bound provider routing, OpenAI Codex provider config, and auth-backed request translation.

- [PR-07 L3] OpenAI Codex launches set a provider-sized Claude Code compact window so 272k-cap providers compact with the same flat reserve instead of the unknown-model 200k fallback.
- [PR-08 L59] OpenAI Codex launch models use a real long-context Claude carrier selected from the live Anthropic model catalog instead of appending synthetic [1m] suffixes to arbitrary aliases.

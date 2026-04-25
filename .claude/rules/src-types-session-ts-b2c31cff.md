---
paths:
  - "src/types/session.ts"
---

# src/types/session.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## State Metadata

- [SI-25 L147] Status line data capture: INSTALL_TAPS stringify hook matches the serialized status payload shape (session_id + cost.total_cost_usd + context_window.total_input_tokens) and pushes flattened fields to dedicated 'status-line' category. tapClassifier classifies as StatusLineUpdate event. tapMetadataAccumulator stores a grouped nullable statusLine snapshot on SessionMetadata (22 fields, including cumulative input/output tokens and total cost). tapStateReducer treats this as informational (no state change). App tab metadata uses current-turn statusLine context when present and falls back to contextDebug; StatusBar token displays prefer statusLine totals and otherwise fall back to session metadata totals.

## Provider Routing
Session-bound provider routing, OpenAI Codex provider config, and auth-backed request translation.

- [PR-13 L279] xhigh effort option: ANTHROPIC_EFFORTS in session.ts includes 'xhigh' (between 'high' and 'max') as a fifth effort level. SessionLauncher renders all five options; effortColor() in claude.ts maps xhigh to var(--rarity-legendary) (same as 'max'). Passed to CLI via --effort xhigh.
  - src/types/session.ts:L312; src/lib/claude.ts:L117

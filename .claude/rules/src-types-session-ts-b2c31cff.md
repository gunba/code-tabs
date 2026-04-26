---
paths:
  - "src/types/session.ts"
---

# src/types/session.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## State Metadata

- [SI-25 L148] Status line data capture: INSTALL_TAPS stringify hook matches the serialized status payload shape (session_id + cost.total_cost_usd + context_window.total_input_tokens) and pushes flattened fields to dedicated 'status-line' category. tapClassifier classifies as StatusLineUpdate event. tapMetadataAccumulator stores a grouped nullable statusLine snapshot on SessionMetadata (22 fields, including cumulative input/output tokens and total cost). tapStateReducer treats this as informational (no state change). App tab metadata uses current-turn statusLine context when present and falls back to contextDebug; StatusBar token displays prefer statusLine totals and otherwise fall back to session metadata totals.

## Development Rules

- [DR-02 L1] TypeScript types in `src/types/` mirror Rust types with camelCase

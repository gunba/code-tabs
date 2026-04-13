---
paths:
  - "src/components/StatusBar/StatusBar.tsx"
---

# src/components/StatusBar/StatusBar.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Hooks Manager

- [HM-10 L7] All status bar icons (clock, budget, warning, hooks, sessions, permissions, tap indicator) are inline SVG components -- no emoji.
- [HM-07 L276] Status bar hook count reflects actual hook entries (sums `hooks[]` within each `MatcherGroup`), not matcher group count

## State Metadata

- [SI-25 L180,343] Status line data capture: INSTALL_TAPS stringify hook matches the serialized status payload shape (session_id + cost.total_cost_usd + context_window.total_input_tokens) and pushes flattened fields to dedicated 'status-line' category. tapClassifier classifies as StatusLineUpdate event. tapMetadataAccumulator stores a grouped nullable statusLine snapshot on SessionMetadata (22 fields, including cumulative input/output tokens and total cost). tapStateReducer treats this as informational (no state change). App tab metadata uses current-turn statusLine context when present and falls back to contextDebug; StatusBar token displays prefer statusLine totals and otherwise fall back to session metadata totals.

## Config Schema and Providers

- [CM-17 L416] StatusBar hooks button opens config manager directly to Hooks tab. Store: showConfigManager is string|false (tab name or closed).

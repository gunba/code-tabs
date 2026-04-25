---
paths:
  - "src/components/StatusBar/StatusBar.tsx"
---

# src/components/StatusBar/StatusBar.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Config Schema and Providers

- [CM-17 L459] StatusBar hooks button opens config manager directly to Hooks tab. Store: showConfigManager is string|false (tab name or closed).

## Hooks Manager

- [HM-10 L7] All status bar icons (clock, budget, warning, hooks, sessions, permissions, tap indicator) are inline SVG components -- no emoji.
- [HM-07 L307] Status bar hook count reflects actual hook entries (sums `hooks[]` within each `MatcherGroup`), not matcher group count

## Process Metrics Collector

- [PM-07 L225] StatusBar renders per-session CPU/mem chips (status-cpu + status-mem) when processHealth.tree is present on the session. Each chip shows total (parent+children) value with a tooltip breaking down parent vs children. cpuColor and memColor from formatMetrics.ts apply threshold coloring. A rightmost overall chip (sum of all real-root sessions) is shown via the process-metrics-overall event.

## State Metadata

- [SI-25 L188,377] Status line data capture: INSTALL_TAPS stringify hook matches the serialized status payload shape (session_id + cost.total_cost_usd + context_window.total_input_tokens) and pushes flattened fields to dedicated 'status-line' category. tapClassifier classifies as StatusLineUpdate event. tapMetadataAccumulator stores a grouped nullable statusLine snapshot on SessionMetadata (22 fields, including cumulative input/output tokens and total cost). tapStateReducer treats this as informational (no state change). App tab metadata uses current-turn statusLine context when present and falls back to contextDebug; StatusBar token displays prefer statusLine totals and otherwise fall back to session metadata totals.

## CLI Visual Identity

- [CV-02 L102] Status bar CLI chip: StatusBar renders a .status-cli.status-cli-${session.config.cli} chip at L102 in StatusBar.tsx. CSS: .status-cli-claude is orange (#ff8000), .status-cli-codex is teal (#10a37f). Font-weight 600, letter-spacing 0.02em.

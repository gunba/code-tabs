---
paths:
  - "src/App.css"
---

# src/App.css

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## CLI Visual Identity

- [CV-03 L83] Active tab bottom indicator: .tab-active uses box-shadow inset 0 -2px 0 var(--tab-active-accent). --tab-active-accent is a per-tab CSS custom property set to var(--accent-claude) for .tab-cli-claude and var(--accent-codex) for .tab-cli-codex. Also used in the ctrl-held double-bar style. Tab-strip badge colors (.tab-cli-badge-claude/.tab-cli-badge-codex) also use var(--cli-claude)/var(--cli-codex) instead of hardcoded hex.

## Session Resume

- [SR-04 L549] Subagent cards (in App.tsx subagent bar) use --bg-surface base; idle/dead cards fade (opacity 0.45), interrupted cards color the name red (var(--error)), completed cards show full opacity with a checkmark. Selected cards get accent-secondary tint and bottom bar when their inspector is open.

## Terminal UI

- [TR-11 L624] Subagent card shows selected highlight (accent-secondary box-shadow + tinted background) when its inspector is open.

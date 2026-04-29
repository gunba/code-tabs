---
paths:
  - "src/App.css"
---

# src/App.css

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Session Resume

- [SR-04 L576] Subagent cards (in App.tsx subagent bar) use --bg-surface base; idle/dead cards fade (opacity 0.45), interrupted cards color the name red (var(--error)), completed cards show full opacity with a checkmark. Selected cards get accent-secondary tint and bottom bar when their inspector is open.

## Terminal UI

- [TR-11 L651] Subagent card shows selected highlight (accent-secondary box-shadow + tinted background) when its inspector is open.

## CLI Visual Identity

- [CV-03 L85] Active tab bottom indicator: .tab-active uses box-shadow inset 0 -2px 0 var(--tab-active-accent). .tab defaults --tab-active-accent to var(--cli-claude), and .tab.tab-cli-codex overrides it to var(--cli-codex). The ctrl-held double-bar style also includes var(--tab-active-accent). Tab-strip provider row colors use .tab-cli-row-claude/.tab-cli-row-codex with var(--cli-claude)/var(--cli-codex).
- [CV-06 L432] Folder headers are rendered by TabBar.tsx inside .tab-bar-scroll before each group's tabs. Each .tab-group-header spans --tab-count CSS grid columns, shows a 10px IconFolder plus a .tab-group-header-label span, and uses a width-invariant left-to-right gradient with fixed background-size: 200px so the tint progresses at the same pixel rate regardless of how many tabs the group spans. The solid background-color extends past the gradient, border-right separates adjacent group columns, and the label ellipsizes. There is no alternating .tab-group-header-alt class in the current implementation.

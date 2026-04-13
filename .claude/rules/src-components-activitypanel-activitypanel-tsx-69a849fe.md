---
paths:
  - "src/components/ActivityPanel/ActivityPanel.tsx"
---

# src/components/ActivityPanel/ActivityPanel.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Activity Panel

- [AP-04 L18] ActivityPanel shows a floating/sticky mascot (ClaudeMascot) that travels to the file currently being accessed by the main agent. The mascot animates: reading (rocking), writing (rocking), moving (hop on path change), idle (subtle bob). Mascot position persists across tab switches and idle periods via lastMainAgentFile derived from activity data. When no active tool call, the mascot stays at the last-touched file in idle state; if the target row is not visible, the mascot is cleared. Subagent files show inline mascots at their last-touched files while active, and completed subagents remain dimmed at their last-touched files. Tree indentation uses INDENT_STEP=16px; no guide lines.
- [AP-05 L19] ActivityPanel has two view modes toggled by a button group: 'Response' (files touched since lastUserMessageAt, filtered per-file by timestamp) and 'Session' (all visited paths via allFiles/visitedPaths). File state communicated through filename color only: created=green (--success), modified=yellow (--warning), deleted=red+strikethrough (--error), read=muted (--text-secondary) via file-tree-kind-* CSS classes. No letter badges.

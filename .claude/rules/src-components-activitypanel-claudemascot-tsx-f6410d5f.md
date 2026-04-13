---
paths:
  - "src/components/ActivityPanel/ClaudeMascot.tsx"
---

# src/components/ActivityPanel/ClaudeMascot.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Activity Panel

- [AP-04 L22] ActivityPanel shows a floating/sticky mascot (ClaudeMascot) that travels to the file currently being accessed by the main agent. The mascot animates: reading (rocking), writing (rocking), moving (hop on path change), idle (subtle bob). Mascot position persists across tab switches and idle periods via lastMainAgentFile derived from activity data. When no active tool call, the mascot stays at the last-touched file in idle state; if the target row is not visible, the mascot is cleared. Subagent files show inline mascots at their last-touched files while active, and completed subagents remain dimmed at their last-touched files. Tree indentation uses INDENT_STEP=16px; no guide lines.

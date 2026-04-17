---
paths:
  - "src/components/ActivityPanel/ClaudeMascot.tsx"
---

# src/components/ActivityPanel/ClaudeMascot.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Activity Panel

- [AP-04 L22] ActivityPanel shows a floating/sticky mascot (ClaudeMascot) that travels to the file currently being accessed by the main agent. The mascot animates: reading (rocking), writing (rocking), moving (hop on path change), idle (subtle bob). Mascot animation is suppressed on tab switch: StickyMascot carries a tabId, and the floating mascot div is only rendered when mascot.tabId === activeTabId. On tab switch the stale mascot unmounts, preventing the CSS transition from animating the jump between tabs; the effect re-runs on activeTabId change and mounts a fresh mascot at the new tab's position. Mascot persists within a session across idle periods. Subagent files show inline mascots at their last-touched files while active, and completed subagents remain dimmed at their last-touched files. Tree indentation uses INDENT_STEP=16px.

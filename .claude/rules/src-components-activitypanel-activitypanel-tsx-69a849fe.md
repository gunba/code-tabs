---
paths:
  - "src/components/ActivityPanel/ActivityPanel.tsx"
---

# src/components/ActivityPanel/ActivityPanel.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Activity Panel

- [AP-04 L18] ActivityPanel shows a floating/sticky mascot (ClaudeMascot) that travels to the file currently being accessed by the main agent. The mascot animates: reading (rocking), writing (rocking), moving (hop on path change), idle (subtle bob). Mascot animation is suppressed on tab switch: StickyMascot carries a tabId, and the floating mascot div is only rendered when mascot.tabId === activeTabId. On tab switch the stale mascot unmounts, preventing the CSS transition from animating the jump between tabs; the effect re-runs on activeTabId change and mounts a fresh mascot at the new tab's position. Mascot persists within a session across idle periods. Subagent files show inline mascots at their last-touched files while active, and completed subagents remain dimmed at their last-touched files. Tree indentation uses INDENT_STEP=16px.
- [AP-05 L19] ActivityPanel has two view modes toggled by a button group: 'Response' (files touched since lastUserMessageAt, filtered per-file by timestamp) and 'Session' (all visited paths via allFiles/visitedPaths). File state communicated through filename color only: created=green (--success), modified=yellow (--warning), deleted=red+strikethrough (--error), read=muted (--text-secondary) via file-tree-kind-* CSS classes. No letter badges.
- [AP-06 L135] Folder searched-color agent precedence: the file-tree-searched CSS class is applied to a folder only when node.activity.kind === 'searched' AND (agentId is null/undefined — main agent always wins — OR the agentId is still present in the session's active subagent set). When a subagent is removed via removeSubagent(), it calls clearAgentSearchActivity(sessionId, subagentId) which drops all {kind:'searched', isFolder:true, agentId:X} entries from turns and allFiles, cleaning up the visual state.

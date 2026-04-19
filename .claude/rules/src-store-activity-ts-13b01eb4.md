---
paths:
  - "src/store/activity.ts"
---

# src/store/activity.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Activity Store Semantics

- [AS-02 L367] mergeExpandedPaths() in useActivityStore auto-expands only folders not yet in seenFolderPaths, then adds them to seenFolderPaths. This ensures that user collapses on already-seen folders are never overridden on subsequent tree refreshes — only genuinely new folders trigger auto-expand. seenFolderPaths is part of SessionActivity and initialized as an empty Set via emptySessionActivity().

## Activity Panel

- [AP-03 L178] activity store kind precedence: when addFileActivity() is called for a path already recorded in the current turn or allFiles, 'created' is never downgraded to 'modified'. If existing kind is 'created' and new kind is 'modified', the entry keeps 'created'. This prevents a subsequent Edit/Write call from masking the original creation event.
- [AP-06 L183,214] Searched-color agent precedence: (1) Write-side in addFileActivity() — turn-dedup branch (src/store/activity.ts:L183) and allFiles branch (activity.ts:L213) both skip a subagent searched entry when a main-agent (agentId=null) entry already exists for the same path. (2) Render-side in ActivityPanel.tsx:L134 — file-tree-searched CSS applied to a folder only when node.activity.kind==='searched' AND (agentId is null/undefined — main agent always wins — OR agentId is still in the active subagent set). When a subagent is removed via removeSubagent(), clearAgentSearchActivity() drops all {kind:'searched',isFolder:true,agentId:X} entries from turns and allFiles. Both layers ensure subagent searches never override or outlive main-agent search coloring.

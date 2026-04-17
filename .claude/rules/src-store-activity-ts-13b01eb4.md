---
paths:
  - "src/store/activity.ts"
---

# src/store/activity.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Activity Store Semantics

- [AS-02 L427] mergeExpandedPaths() in useActivityStore auto-expands only folders not yet in seenFolderPaths, then adds them to seenFolderPaths. This ensures that user collapses on already-seen folders are never overridden on subsequent tree refreshes — only genuinely new folders trigger auto-expand. seenFolderPaths is part of SessionActivity and initialized as an empty Set via emptySessionActivity().

## Activity Panel

- [AP-03 L182] activity store kind precedence: when addFileActivity() is called for a path already recorded in the current turn or allFiles, 'created' is never downgraded to 'modified'. If existing kind is 'created' and new kind is 'modified', the entry keeps 'created'. This prevents a subsequent Edit/Write call from masking the original creation event.

## Process-Tree Filesystem Tracer

- [PO-03 L229] TAP/tracer dedup: addFileActivityFromTracer() in activity store checks whether a TAP-sourced activity for the same path and kind exists within TRACER_DEDUP_MS. If so, TAP wins (it carries richer toolInputData diffs); tracer only attaches its processChain to the existing TAP entry. If no TAP entry exists within the window, tracer creates a new FileActivity with processChain populated but agentId/toolName null.
  - src/store/activity.ts:L226

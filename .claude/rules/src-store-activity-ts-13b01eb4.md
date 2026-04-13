---
paths:
  - "src/store/activity.ts"
---

# src/store/activity.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Activity Store Semantics

- [AS-02 L319] mergeExpandedPaths() in useActivityStore auto-expands only folders not yet in seenFolderPaths, then adds them to seenFolderPaths. This ensures that user collapses on already-seen folders are never overridden on subsequent tree refreshes — only genuinely new folders trigger auto-expand. seenFolderPaths is part of SessionActivity and initialized as an empty Set via emptySessionActivity().

## Activity Panel

- [AP-03 L163] activity store kind precedence: when addFileActivity() is called for a path already recorded in the current turn or allFiles, 'created' is never downgraded to 'modified'. If existing kind is 'created' and new kind is 'modified', the entry keeps 'created'. This prevents a subsequent Edit/Write call from masking the original creation event.

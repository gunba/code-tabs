---
paths:
  - "src/hooks/tapSettledIdleHandler.ts"
---

# src/hooks/tapSettledIdleHandler.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Activity Store Semantics

- [AS-03 L9] Settled-idle endTurn: useTapEventProcessor subscribes to settledStateManager; on settled-idle it calls endTurn(sessionId) to close the current activity turn and trigger stats recomputation. Immediately after, it calls runGitScanAndValidate(sessionId) which: (1) runs git_list_changes for the session workingDir (gated by isGitRepo cache) and adds any changed paths not already in visitedPaths as external file-activity entries; (2) calls paths_exist on all activity paths and calls confirmEntries to drop false-positive entries (e.g. rm'd files still showing as created). settledStateManager subscription at useTapEventProcessor.ts:L627.
  - src/hooks/useTapEventProcessor.ts:L538

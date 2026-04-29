---
paths:
  - "src/hooks/tapWorktreeSync.ts"
---

# src/hooks/tapWorktreeSync.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## State Tap Reducer

- [SI-20 L15,49] Worktree cwd detection: when tap events (ConversationMessage, SessionRegistration, WorktreeState) carry a cwd or worktreePath, useTapEventProcessor updates the session's workingDir via updateConfig. WorktreeCleared restores originalCwd. Fires only on change (normalizePath comparison). SessionRegistration cwd updates are gated behind !subTracker.isSubagentInFlight() to prevent subagent session-init events from overwriting the parent session's cwd during the SubagentSpawn-to-first-sidechain-message window.

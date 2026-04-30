---
paths:
  - "src/lib/sessionFork.ts"
---

# src/lib/sessionFork.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Respawn & Resume

- [RS-09 L59] Fork launch config builds a new tab from an existing conversation by preserving the fork source id, clearing run/session identity for the new process, and normalizing worktree flags.
  - buildForkSessionConfig() and buildForkConfigFromPastSession() in src/lib/sessionFork.ts set resumeSession to the source conversation id, forkSession true, continueSession false, sessionId null, and runMode false. They anchor worktree launches at the project root and normalize -w/--worktree forms so unnamed worktree intent is preserved while explicit worktree names are dropped for a fresh generated worktree.

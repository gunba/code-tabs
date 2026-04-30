---
paths:
  - "src/lib/sessionRelaunch.ts"
---

# src/lib/sessionRelaunch.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Respawn & Resume

- [RS-08 L21] Dead Claude tab relaunch auto-resolves a valid resume id from same-directory JSONL past sessions; forked tabs prefer their current sessionId before the parent resumeSession.
  - resolveResumeId() canonicalizes cwd, filters same-directory non-Codex past sessions, prefers exact stored id, returns the single candidate, otherwise picks closest lastModified to lastActive/createdAt. For forkSession tabs, getResumeId()/resolveResumeId() prefer config.sessionId over config.resumeSession so relaunching an existing fork continues the fork, while relaunchDeadSession clears forkSession and continueSession, strips worktree flags, preserves launchWorkingDir, inserts the replacement at the old index, and closes the dead tab only after createSession succeeds.

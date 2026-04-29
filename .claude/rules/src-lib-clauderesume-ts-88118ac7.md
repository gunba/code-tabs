---
paths:
  - "src/lib/claudeResume.ts"
---

# src/lib/claudeResume.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Respawn & Resume

- [RS-02 L12] Resume target chain: `resumeSession || sessionId || id` (chains through multiple respawns)
- [RS-08 L18] Dead Claude tab relaunch auto-resolves a valid resume id from listed JSONL past sessions before falling back to the stored resume chain. resolveResumeId canonicalizes the dead tab working directory, filters same-directory non-Codex past sessions, prefers an exact stored resumeSession/sessionId match when that JSONL exists, returns the single candidate directly, and otherwise picks the candidate whose lastModified is closest to the tab lastActive/createdAt with the Rust-provided newest-first order as fallback. relaunchDeadSession uses that resolved id, preserves the launch working directory, clears continueSession, strips worktree flags, creates the replacement tab at the old index when possible, and closes the dead tab only after createSession succeeds.
- [RS-03 L65] Check conversation existence via resumeSession || nodeSummary || assistantMessageCount > 0 (in-memory, no JSONL). canResumeSession() in claude.ts returns true when any of these three conditions holds: config.resumeSession is set, metadata.nodeSummary is present, or metadata.assistantMessageCount > 0.

## Dead Session Handling

- [DS-03 L64] Auto-resume guarded by `canResumeSession()` (derived from `sessionId`, `resumeSession`, or `nodeSummary` — no JSONL check)

## Session Resume

- [SR-08 L85] Worktree flag stripping on resume: `-w` and `--worktree` flags are stripped from extraFlags via `stripWorktreeFlags()` when resuming or respawning a session. Prevents creating a duplicate worktree — the session resumes in the existing worktree directory (workingDir was updated by inspector cwd detection [SI-20]).

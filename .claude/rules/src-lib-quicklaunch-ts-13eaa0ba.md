---
paths:
  - "src/lib/quickLaunch.ts"
---

# src/lib/quickLaunch.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Respawn & Resume

- [RS-04 L22] resumeSession, forkSession, continueSession, sessionId, and runMode are one-shot launch fields and are stripped from quick-launch/default persistence paths.
  - quickLaunchSession() clears the transient fields before createSession and setLastConfig. SessionLauncher save-defaults/launch/dismiss paths also clear fork/resume/continue fields so fork intent does not leak into later normal launches.

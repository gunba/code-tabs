---
paths:
  - "src/lib/sessionLauncherConfig.ts"
---

# src/lib/sessionLauncherConfig.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Session Launcher

- [SL-09 L50] SessionLauncher restores config from savedDefaults or lastConfig with workspace-default layering for fresh launches; resume configs bypass workspace defaults, keep forkSession when set, and clear stale continueSession/sessionId/runMode.
  - buildInitialLauncherConfig() uses lastConfig directly when resumeSession is set, preserving fork intent for fork-with-options flows while clearing continueSession, sessionId, and runMode. Fresh launches use savedDefaults/lastConfig plus workspace defaults and force forkSession false.

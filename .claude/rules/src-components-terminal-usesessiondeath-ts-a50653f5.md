---
paths:
  - "src/components/Terminal/useSessionDeath.ts"
---

# src/components/Terminal/useSessionDeath.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Respawn & Resume

- [RS-06 L106] Session-in-use auto-recovery: checks process ancestry to distinguish own orphans from external processes; own descendants (stale orphans from crashed tabs) killed automatically and resume retries

## Dead Session Handling

- [DS-07 L106] Session-in-use auto-recovery: own orphans killed automatically and resume retries; external processes show "Session in use externally" overlay with "Kill and resume" / "Cancel" — never killed without user confirmation
- [DS-01 L153] When a session dies, handlePtyExit switches to the nearest live tab via `findNearestLiveTab`. No overlay is shown (external holder overlay excepted). Dead tabs stay in the tab bar at reduced opacity.

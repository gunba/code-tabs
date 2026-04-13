---
paths:
  - "src/lib/settledState.ts"
---

# src/lib/settledState.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Settled State System

- [SE-01 L1] SettledStateManager: centralized per-session hysteresis for idle/actionNeeded/waitingPermission transitions. Replaces per-consumer debounce timers. actionNeeded and waitingPermission settle immediately; idle uses IDLE_HYSTERESIS_MS (2000ms) to filter transient idle→active→idle flickers. Subscribers get settle/clear callbacks. Fed by effective state (accounting for subagents) from a Zustand effect in App.tsx.

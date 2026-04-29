---
paths:
  - "src/components/Terminal/useDurationTimer.ts"
---

# src/components/Terminal/useDurationTimer.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## State Metadata

- [SI-22 L7] Duration timer: sole source is client-side useDurationTimer (1s setInterval in TerminalPanel, accumulates active-state time). TAP accumulator does NOT emit durationSecs -- TurnDuration events fall through to default:null. Timer resets accumulatedRef and lastTickRef on respawnCounter change to prevent stale values after respawn.

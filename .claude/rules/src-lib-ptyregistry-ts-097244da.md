---
paths:
  - "src/lib/ptyRegistry.ts"
---

# src/lib/ptyRegistry.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Data Flow

- [DF-01 L42] User types in xterm.js -> `onData` -> `writeToPty()` (ptyRegistry.ts: LineAccumulator detects slash commands) -> PTY `write` -> PTY (ConPTY on Windows, openpty on Linux) -> Claude stdin

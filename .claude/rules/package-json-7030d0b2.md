---
paths:
  - "package.json"
---

# package.json

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Project Conventions

- [BV-02 L6] Never do a full NSIS build just to test. Use build:quick or build:debug.
- [BV-03 L6] Before every commit: `npx tsc --noEmit` (zero TS errors), `npm test` (all Vitest pass), `cargo check` in src-tauri (zero Rust errors)

---
paths:
  - "src/types/tapEvents.ts"
---

# src/types/tapEvents.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Inspector Tap Pipeline

- [IN-18 L219] HttpPing event (cat=ping from Rust backend) sets apiLatencyMs; ApiFetch events also update apiLatencyMs from their round-trip duration, but HttpPing overrides with a cleaner dedicated measurement when available.

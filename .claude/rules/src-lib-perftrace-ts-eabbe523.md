---
paths:
  - "src/lib/perfTrace.ts"
---

# src/lib/perfTrace.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Debug Panel

- [DP-15 L6] Structured performance spans flow into the same observability stream as app logs. Frontend perfTrace emits perf.span entries for trace/traceAsync/traceSync/manual spans, and backend observability helpers mirror the same schema so timings from hot frontend and Rust control paths can be filtered together in the debug log.

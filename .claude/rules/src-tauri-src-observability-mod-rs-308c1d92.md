---
paths:
  - "src-tauri/src/observability/mod.rs"
---

# src-tauri/src/observability/mod.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Debug Panel

- [DP-16 L279] Observability and DevTools are runtime-gated, never compile-time. observability_enabled() returns runtime_observability_enabled() with no cfg!(debug_assertions) fallback; devtools_enabled() works the same way. Each flag's runtime atomic (OBSERVABILITY_RUNTIME_ENABLED, DEVTOOLS_RUNTIME_ENABLED) is seeded once via Once::call_once from env var (CODE_TABS_OBSERVABILITY / CODE_TABS_DEVTOOLS) OR persisted ui-config.json key (observability.enabled / devtools.enabled), and flipped at runtime by the set_observability_enabled / set_devtools_enabled IPC commands which atomically store and persist. Both flags default OFF on fresh install (release and debug behave identically). open_main_devtools gates on devtools_enabled() and returns a user-facing error 'DevTools are disabled. Enable them in Config -> Observability.' when off. Release builds rely on the Cargo 'devtools' feature on the tauri crate so WebviewWindow::open_devtools is linked.
- [DP-15 L530] Structured performance spans flow into the same observability stream as app logs. Frontend perfTrace emits perf.span entries for trace/traceAsync/traceSync/manual spans, and backend observability helpers mirror the same schema so timings from hot frontend and Rust control paths can be filtered together in the debug log.

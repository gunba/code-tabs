---
paths:
  - "src/hooks/useProcessMetrics.ts"
---

# src/hooks/useProcessMetrics.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Process Metrics Collector

- [PM-06 L21] Frontend pipeline: useProcessMetrics (src/hooks/useProcessMetrics.ts) subscribes to 'process-metrics' and 'process-metrics-overall' Tauri events. Per-PID events are routed to the correct session via pidToSessionId Map in the Zustand session store (registered by registerActivePid in ptyProcess.ts on PTY spawn, unregistered on cleanup). formatMetrics.ts provides formatBytes, formatCpu, cpuColor (green/<30% / amber/>=30% / red/>=70%), memColor (green/<500MB / amber/<1GB / red/>=1GB).

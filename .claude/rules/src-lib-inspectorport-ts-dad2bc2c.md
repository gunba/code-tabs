---
paths:
  - "src/lib/inspectorPort.ts"
---

# src/lib/inspectorPort.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Inspector Connection

- [IN-01 L1] Inspector port allocation and registry in `inspectorPort.ts`. Async `allocateInspectorPort()` probes OS via `check_port_available` IPC (Rust TcpListener::bind) and skips registry-held ports.
- [IN-07 L2] Inspector port allocator verifies each candidate port is free via `check_port_available` IPC (Rust TcpListener::bind on 127.0.0.1). Skips ports already in the registry. Throws if all 100 ports (6400-6499) are exhausted.

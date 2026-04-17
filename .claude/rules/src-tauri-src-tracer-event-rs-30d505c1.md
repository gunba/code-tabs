---
paths:
  - "src-tauri/src/tracer/event.rs"
---

# src-tauri/src/tracer/event.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Process-Tree Filesystem Tracer

- [PO-02 L1] Event emission and frontend bridge: per-tab tracer thread emits app.emit('tracer://fs-event', FsEvent) where FsEvent carries tab_id, op (FsOp enum: Read/Write/Create/Delete/Mkdir/Rmdir/Rename{from}/Truncate/Chmod/Symlink), path, pid, ppid, process_chain (Vec<ProcessInfo> with pid/exe/argv ancestry), and timestamp_ms. Frontend useTapEventProcessor subscribes via listen('tracer://fs-event') and routes to addFileActivityFromTracer(tabId, path, kind, processChain, isExternal). Noise filter (is_noise()) drops /proc/, /sys/, /dev/, /.git/objects/, node_modules/.cache etc before emission.
  - src-tauri/src/tracer/mod.rs:L28; src-tauri/src/tracer/event.rs:L1; src/hooks/useTapEventProcessor.ts:L598
- [PO-04 L2] ProcessNode map: tracer maintains a live map of (pid -> ProcessNode{ppid, exe, argv}) for every attached descendant. PTRACE_EVENT_EXEC refreshes exe/argv. PTRACE_EVENT_EXIT prunes the node. process_chain in each FsEvent is built by walking the map from touching PID up to (but excluding) the tab root, oldest-first. Enables 'bash -> python -> ripgrep touched foo.rs' ancestry display in ActivityPanel.
  - src-tauri/src/tracer/linux.rs:L22

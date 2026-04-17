---
paths:
  - "src-tauri/src/tracer/mod.rs"
---

# src-tauri/src/tracer/mod.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Process-Tree Filesystem Tracer

- [PO-02 L1] Event emission and frontend bridge: per-tab tracer thread emits app.emit('tracer://fs-event', FsEvent) where FsEvent carries tab_id, op (FsOp enum: Read/Write/Create/Delete/Mkdir/Rmdir/Rename{from}/Truncate/Chmod/Symlink), path, pid, ppid, process_chain (Vec<ProcessInfo> with pid/exe/argv ancestry), and timestamp_ms. Frontend useTapEventProcessor subscribes via listen('tracer://fs-event') and routes to addFileActivityFromTracer(tabId, path, kind, processChain, isExternal). Noise filter (is_noise()) drops /proc/, /sys/, /dev/, /.git/objects/, node_modules/.cache etc before emission.
  - src-tauri/src/tracer/mod.rs:L28; src-tauri/src/tracer/event.rs:L1; src/hooks/useTapEventProcessor.ts:L598
- [PO-05 L2] TracerHandle lifecycle: spawn_with_tracer() returns (pid, LinuxTracer) and is stored as UnixPty._tracer: Option<TracerHandle>. Dropping TracerHandle calls detach() which sets the stop_flag AtomicBool and the tracer thread exits. The tracee is not killed — PTY owns its lifecycle. Dropping UnixPty therefore automatically detaches the tracer.
  - src-tauri/src/tracer/mod.rs:L52; src-tauri/src/pty/unix.rs:L268

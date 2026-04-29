---
paths:
  - "src/hooks/useTerminalWriteSink.ts"
---

# src/hooks/useTerminalWriteSink.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## PTY Output

- [PT-16 L124] PTY output flows pty_read (Tauri) -> Uint8Array chunks -> useTerminal.writeBytes -> TerminalWriteQueue (enqueueTerminalWrite) -> flushWriteQueue -> term.write(batch.data). Hidden tabs (visibleRef.current=false) keep chunks queued; useEffect on visible flips drains the queue. Adjacent Uint8Array chunks merge up to 256KB before a single term.write call. Decoding to text is deferred until a debug log/perf span needs it (terminalOutputDecoder shared at module scope).

## Data Flow

- [DF-03 L124] useTerminal.write/writeBytes enqueue text or Uint8Array chunks into a per-terminal TerminalWriteQueue (createTerminalWriteQueue) and call flushWriteQueue. flushWriteQueue is gated on visibleRef.current — hidden tabs keep raw output queued and xterm parsing/rendering catches up on activation. When visible and not in-flight, it pulls a batched chunk via takeTerminalWriteBatch (merges adjacent same-type chunks up to 256KB / 256K chars), passes batch.data to term.write with a callback that re-fires flushWriteQueue. writeInFlightRef serializes consecutive batches; visibility flips trigger flush via useEffect. Decoded text is computed lazily (terminalOutputDecoder, module-scoped) only when DEBUG capture is enabled. perf spans + dlog calls share the same shouldRecordDebugLog gate.

---
paths:
  - "src/hooks/useInspectorConnection.ts"
---

# src/hooks/useInspectorConnection.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Inspector Connection

- [SI-02 L11] Inspector connects immediately; retries up to 30x at 100ms intervals (~3s total) for initial connection (Bun init time). After established connection drops, reconnects with backoff delays [2s, 4s, 8s]. everConnectedRef distinguishes initial connect vs reconnect.
- [IN-12 L12] useInspectorConnection.ts: WebSocket lifecycle only (connect, Runtime.evaluate for hook injection, retry, disconnect). No state derivation. useTapPipeline.ts: receives `tap-entry-{sessionId}` Tauri events from Rust TCP tap server, classifies, dispatches to bus, buffers for disk. useTapEventProcessor.ts: subscribes to bus, runs reducers, calls store actions.

---
paths:
  - "src/lib/inspectorHooks.ts"
---

# src/lib/inspectorHooks.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Inspector Hooks

- [SI-01 L1] Sole source: BUN_INSPECT WebSocket inspector via JSON.stringify interception (~2-6ms latency). INSTALL_TAPS wraps JSON.parse and JSON.stringify to intercept Claude Code's internal event serializations.
- [SI-14 L2] Push-based architecture: INSTALL_TAPS injects hooks via BUN_INSPECT WebSocket; events are pushed via TCP to the Rust tap server, then forwarded as Tauri events to useTapPipeline. There is no polling-based inspector path in the running app.
- [SI-21 L10] INSTALL_TAPS exposes 22 flag-gated tap categories: parse, stringify, console, fs, spawn, fetch, exit, timer, stdout, stderr, require, bun, websocket, net, stream, fspromises, bunfile, abort, fswatch, textdecoder, events, envproxy.
  - Multi-op families such as console, fs, timer, bun, websocket, and stream emit a shared category plus an op field instead of encoding the operation in the category string.
  - Delivery uses Bun.connect TCP on TAP_PORT; status-line, system-prompt, spawn.exit, spawnSync, and execSync remain auxiliary emitted categories outside the flag list.
- [IN-02 L11] INSTALL_TAPS JS expression in inspectorHooks.ts; wraps 15 function categories. TCP push-based delivery via Bun.connect to TAP_PORT. Status-line detection: stringify wrapper matches the serialized StatusLineCommandInput payload shape (session_id + cost.total_cost_usd + context_window.total_input_tokens) and pushes flattened fields to dedicated 'status-line' category (bypasses 2000-char snap truncation). Also contains WebFetch domain bypass, HTTPS/fetch timeout patches, and wrapAfter() helper for post-call hooks.

## State Metadata

- [IN-19 L134] System prompt capture: INSTALL_TAPS intercepts API request body and pushes 'system-prompt' category with text, model, msgCount, and blocks array. tapClassifier emits SystemPromptCapture event (maps wire cc to cacheControl). tapMetadataAccumulator stores capturedSystemPrompt (string) and capturedSystemBlocks (SystemPromptBlock[]) on SessionMetadata; blocks excluded from fingerprint to avoid serialization cost, tracked via blocksChanged flag. Both reset on respawn. StatusBar shows 'Context' button when capturedSystemPrompt is truthy; opens ContextViewer modal.

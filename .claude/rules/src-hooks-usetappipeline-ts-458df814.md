---
paths:
  - "src/hooks/useTapPipeline.ts"
---

# src/hooks/useTapPipeline.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Inspector Hooks

- [SI-14 L26] Push-based architecture: INSTALL_TAPS injects hooks via BUN_INSPECT WebSocket; events are pushed via TCP to the Rust tap server, then forwarded as Tauri events to useTapPipeline. There is no polling-based inspector path in the running app.

## Inspector Tap Pipeline

- [IN-10 L25] Tap event pipeline: raw entries arrive via TCP socket (TAP_PORT), tapClassifier.ts classifies raw TapEntry values into typed TapEvent objects, tapEventBus.ts dispatches per-session, and reducers/accumulators push store updates. tapClassifier maps normalized cat+op families to ConsoleOutput, SyncFileOp, TimerOp, BunOp, WebSocketOp, and StreamOp, then copies the original entry.cat onto the returned event. classifyStringify() detects PermissionPromptShown via 4 paths: (1) setMode array (Write/Edit permission prompt), (2) addRules array (Bash permission prompt, extracts toolName from rules[0].toolName), (3) tengu_tool_use_show_permission_request telemetry shape, (4) notification_type=permission_prompt. Downstream consumers split responsibilities: tapStateReducer derives session state, tapMetadataAccumulator enriches metadata, and tapSubagentTracker maintains subagent lifecycle data.
  - tapClassifier maps normalized cat+op families to ConsoleOutput, SyncFileOp, TimerOp, BunOp, WebSocketOp, and StreamOp, then copies the original entry.cat onto the returned event.
  - Downstream consumers split responsibilities: tapStateReducer derives session state, tapMetadataAccumulator enriches metadata, and tapSubagentTracker maintains subagent lifecycle data.

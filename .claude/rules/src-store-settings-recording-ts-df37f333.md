---
paths:
  - "src/store/settings/recording.ts"
---

# src/store/settings/recording.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Config Implementation

- [CI-05 L24] Recording defaults: TAP/traffic disabled, debugCapture disabled, all high-volume tap categories off (console, fs, spawn, fetch, exit, timer, stdout, stderr, require, bun, websocket, net, stream, fspromises, bunfile, abort, fswatch, textdecoder, events, envproxy). parse, stringify, codex-* (codex-session/turn-context/token-count/tool-call-start/tool-input/tool-call-complete/message/thread-name-updated/compacted), and system-prompt categories on. v6 backfilled added categories with stdout/stderr forced off; v21 quietRecordingConfig force-quiets persisted configs into recordingConfigsByCli (claude+codex).
  - Defaults keep TAP/traffic enabled, force stdout/stderr off, and seed fspromises, bunfile, abort, fswatch, textdecoder, events, and envproxy category toggles.
  - The version < 6 migration forces stdout/stderr=false and only fills the new category keys when they are absent in persisted state.
- [CI-06 L25] RecordingConfig.debugCapture field controls DEBUG-level capture (default false). Toggled via RecordingPane checkbox. Settings store syncs to debugLog.setDebugCaptureEnabled() via subscribe; setDebugCaptureResolver wires resolveDebugCaptureForSession (per-CLI lookup via session.config.cli or sessionConfigs cache). v8 backfilled true for older states; v21 force-quiets to false alongside the other recording defaults.

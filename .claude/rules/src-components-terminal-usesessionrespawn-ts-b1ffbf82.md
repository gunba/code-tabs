---
paths:
  - "src/components/Terminal/useSessionRespawn.ts"
---

# src/components/Terminal/useSessionRespawn.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Respawn & Resume

- [RS-01 L27] triggerRespawn cleans up old PTY/inspector (no file watcher — removed), allocates new inspector port, increments respawn counter. Calls pty.cleanup(), inspector.disconnect(), stop_tap_server, unregisterPtyWriter/Kill/HandleId/InspectorPort, resets spawnedRef and earlyOutputRef.

## PTY Output

- [PT-11 L27] triggerRespawn in TerminalPanel resets the live terminal/session state before launching the replacement: kills active PTY tree, clears inspector/tap registrations (stop_tap_server, unregisterPtyWriter/Kill/HandleId/InspectorPort), allocates a new inspector port, optionally merges new config/name, and increments respawnCounter so hooks re-fire for the new session. No file watcher to unregister (notify-based watcher removed; replaced by passive git_list_changes on settled-idle).

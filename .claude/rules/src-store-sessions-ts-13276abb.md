---
paths:
  - "src/store/sessions.ts"
---

# src/store/sessions.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Persistence

- [PS-05 L122] init() awaits both kill_orphan_sessions and detect_claude_cli in parallel via Promise.all before setting claudePath — gates PTY spawning on cleanup completion (previous code set claudePath via fire-and-forget .then() which raced with spawning)
- [PS-06 L137] Proxy lifecycle in init(): starts API proxy via invoke('start_api_proxy') with providerConfig from settings store, stores returned port in settings.proxyPort. Registers listener for proxy-route events (emitted by Rust proxy on each request) and dlogs routing decisions to debug panel. Proxy port is transient (not persisted).
- [PS-01 L320] Frontend-owned via `persist_sessions_json` — Rust session manager does NOT own persistence (metadata would be stale)

## Dead Session Handling

- [DS-08 L122] Proactive orphan cleanup on startup: init() collects all persisted session IDs, calls kill_orphan_sessions to kill leftover CLI processes before any PTY spawning. Prevents 'session ID already in use' and port conflicts on app restart after crash/force-close

## Terminal UI

- [TA-02 L33] Global tool name tracking: seenToolNames Set in sessions store collects unique tool names across all sessions via addSeenToolName() action. Fed by ToolCallStart events in useTapEventProcessor. Immutable Set pattern for reactivity (early return when name already present).

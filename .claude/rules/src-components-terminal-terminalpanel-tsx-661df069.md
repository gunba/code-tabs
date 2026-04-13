---
paths:
  - "src/components/Terminal/TerminalPanel.tsx"
---

# src/components/Terminal/TerminalPanel.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Respawn & Resume

- [RS-06 L238] Session-in-use auto-recovery: checks process ancestry to distinguish own orphans from external processes; own descendants (stale orphans from crashed tabs) killed automatically and resume retries
- [RS-01 L301] `triggerRespawn` cleans up old PTY/watchers/inspector, allocates new inspector port, increments respawn counter
- [RS-07 L382] Spawn effect guards against dead sessions (session.state === 'dead') -- prevents restored dead sessions from auto-spawning with --session-id on startup. Respawns still work because triggerRespawn sets state to 'starting' before incrementing respawnCounter

## Session Resume

- [SR-01 L153] Resumed sessions show loading spinner until inspector connects (~1s) and confirms session is responsive

## State Metadata

- [SI-22 L41] Duration timer: sole source is client-side useDurationTimer (1s setInterval in TerminalPanel, accumulates active-state time). TAP accumulator does NOT emit durationSecs -- TurnDuration events fall through to default:null. Timer resets accumulatedRef and lastTickRef on respawnCounter change to prevent stale values after respawn.

## Dead Session Handling

- [DS-07 L238] Session-in-use auto-recovery: own orphans killed automatically and resume retries; external processes show "Session in use externally" overlay with "Kill and resume" / "Cancel" — never killed without user confirmation
- [DS-01 L285] When a session dies, handlePtyExit switches to the nearest live tab via `findNearestLiveTab`. No overlay is shown (external holder overlay excepted). Dead tabs stay in the tab bar at reduced opacity.

## PTY Output

- [PT-11 L301] triggerRespawn in TerminalPanel resets the live terminal/session state before launching the replacement: kills active PTY tree, clears inspector/tap registrations, unregisters file watcher, allocates a new inspector port, optionally merges new config/name, and increments respawnCounter so hooks re-fire for the new session.

## PTY Spawn

- [TR-15 L449] Proxy env injection at PTY spawn: when proxyPort is set in settings store, TerminalPanel sets ANTHROPIC_BASE_URL=http://127.0.0.1:{port}/s/{sessionId} and binds the session to its selected providerId so the local proxy can route each Claude Code request through the right provider.

## Terminal UI

- [TR-05 L603] Hidden tabs use CSS display: none -- never unmount/remount xterm.js (destroys state).

## Provider Routing
Session-bound provider routing, OpenAI Codex provider config, and auth-backed request translation.

- [PR-07 L423] OpenAI Codex launches set a provider-sized Claude Code compact window so 272k-cap providers compact with the same flat reserve instead of the unknown-model 200k fallback.
- [PR-01 L449] TerminalPanel points Claude at a session-scoped proxy URL (/s/{sessionId}) and binds each session to providerId; the Rust proxy resolves that session-bound provider, applies provider-local modelMappings, and falls back to the default provider when no binding is present.

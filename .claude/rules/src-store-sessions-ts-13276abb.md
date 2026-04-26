---
paths:
  - "src/store/sessions.ts"
---

# src/store/sessions.ts

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Activity Store Semantics

- [AS-04 L93] useSessionStore mutations skip set() calls when the patch produces no change. patchHasChanges<T>(current, patch) iterates Object.keys(patch) and Object.is-compares each key. updateMetadata, updateConfig, and updateSubagent return s (the same state reference) when patchHasChanges is false. updateState bails when prev is missing or prev.state===state. setName bails when name unchanged. requestKill/clearKillRequest no-op when killRequest is already the target. setInspectorOff no-ops when the Set membership matches. updateProcessHealth bails when patchHasChanges fails on the existing health object. updateProcessTreeMetrics bails when processTreeMetricsEqual reports a deep match (compares parentCpu/parentMem/childrenCpu/childrenMem/childCount + topChildren by index on pid/name/command/memBytes). updateOverallMetrics compares cpu/memBytes/processes against the current value. registerSessionPid bails when the pid->session map already maps pid -> sessionId. trafficRecording start/stop bail when already at the target state. Returning the same state object lets Zustand subscribers skip re-renders.
  - src/store/sessions.ts:L91 (patchHasChanges helper); L95 (processTreeMetricsEqual helper); various early-return guards in updateState/updateMetadata/updateConfig/setName/requestKill/clearKillRequest/setInspectorOff/updateProcessHealth/updateProcessTreeMetrics/updateOverallMetrics/registerSessionPid/setTrafficRecording. Tests in src/store/__tests__/sessions.test.ts cover the no-op invariants.

## Debug Panel

- [DP-14 L302] Buffer cleanup on session close: closeSession() calls removeDebugLogSession(id) which deletes the session's buffer from the Map and increments the generation counter.

## Persistence

- [PS-05 L178] init() awaits both kill_orphan_sessions and detect_claude_cli in parallel via Promise.all before setting claudePath — gates PTY spawning on cleanup completion (previous code set claudePath via fire-and-forget .then() which raced with spawning)
- [PS-06 L196] Proxy lifecycle in init(): starts API proxy via invoke('start_api_proxy') with providerConfig from settings store, stores returned port in settings.proxyPort. Registers listener for proxy-route events (emitted by Rust proxy on each request) and dlogs routing decisions to debug panel. Proxy port is transient (not persisted).
- [PS-01 L368] Frontend-owned via `persist_sessions_json` — Rust session manager does NOT own persistence (metadata would be stale)

## Dead Session Handling

- [DS-08 L178] Proactive orphan cleanup on startup: init() collects all persisted session IDs, calls kill_orphan_sessions to kill leftover CLI processes before any PTY spawning. Prevents 'session ID already in use' and port conflicts on app restart after crash/force-close

## Terminal UI

- [TA-02 L35] Global tool name tracking: seenToolNames Set in sessions store collects unique tool names across all sessions via addSeenToolName() action. Fed by ToolCallStart events in useTapEventProcessor. Immutable Set pattern for reactivity (early return when name already present).

## Development Rules

- [DR-03 L1] Zustand stores in `src/store/`, hooks in `src/hooks/`

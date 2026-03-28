---
paths:
  - "src/store/sessions.ts"
  - "src/App.tsx"
---

# Persistence

<!-- Codes: PS=Persistence -->

- [PS-01] Frontend-owned via `persist_sessions_json` — Rust session manager does NOT own persistence (metadata would be stale)
- [PS-02] `beforeunload` event flushes sessions so they survive app restart
- [PS-03] Debounced auto-persist every 2s on session array changes
- [PS-04] `beforeunload` kills all active PTY process trees before persisting — prevents orphaned CLI processes holding session locks on restart
  - Files: src/App.tsx:151, src/lib/ptyProcess.ts:22
- [PS-05] init() awaits both kill_orphan_sessions and detect_claude_cli in parallel via Promise.all before setting claudePath — gates PTY spawning on cleanup completion (previous code set claudePath via fire-and-forget .then() which raced with spawning)
  - Files: src/store/sessions.ts:86

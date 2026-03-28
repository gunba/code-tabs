---
paths:
  - "src/components/Terminal/TerminalPanel.tsx"
  - "src/store/sessions.ts"
---

# Dead Session Overlay

- [DS-01] Dead sessions show an overlay with Resume, Resume other, and New session buttons
- [DS-02] All actions respawn the PTY in the same tab — no new tab created, no old tab destroyed
- [DS-03] Resume button only shown if session has conversation (derived from `sessionId`, `resumeSession`, or `nodeSummary` via `canResumeSession()` — no JSONL check)
  - Files: src/components/Terminal/TerminalPanel.tsx, src/lib/claude.ts
- [DS-04] Enter key on dead tab resumes same session; all other input swallowed
- [DS-05] Ctrl+Shift+R on dead tab opens resume picker targeting that tab (reuses tab via requestRespawn); dead overlay hint shows Ctrl+Shift+R for the 'Resume other...' button
- [DS-06] ResumePicker detects active dead tab and respawns in place instead of creating new session
- [DS-07] Session-in-use auto-recovery: own orphans killed automatically and resume retries; external processes show "Session in use externally" overlay with "Kill and resume" / "Cancel" — never killed without user confirmation
- [DS-08] Proactive orphan cleanup on startup: init() collects all persisted session IDs, calls kill_orphan_sessions to kill leftover CLI processes before any PTY spawning. Prevents 'session ID already in use' and port conflicts on app restart after crash/force-close
  - Files: src/store/sessions.ts
- [DS-09] Auto-resume: switching to a dead tab with a resumable conversation (sessionId/resumeSession/nodeSummary) automatically triggers respawn; only fires on hidden-to-visible transitions, not when session dies while visible
  - Files: src/components/Terminal/TerminalPanel.tsx

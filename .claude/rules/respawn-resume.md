---
paths:
  - "src/components/Terminal/TerminalPanel.tsx"
  - "src/lib/claude.ts"
---

# Respawn & Resume

<!-- Codes: RS=Respawn & Resume -->

- [RS-01] `triggerRespawn` cleans up old PTY/watchers/inspector, allocates new inspector port, increments respawn counter
- [RS-02] Resume target chain: `resumeSession || sessionId || id` (chains through multiple respawns)
- [RS-03] Check conversation existence via `nodeSummary || resumeSession` (in-memory, no JSONL)
- [RS-04] `resumeSession` and `continueSession` are one-shot flags — never persist in `lastConfig`
- [RS-05] Skip `--session-id` CLI arg when using `--resume` or `--continue`
- [RS-06] Session-in-use auto-recovery: checks process ancestry to distinguish own orphans from external processes; own descendants (stale orphans from crashed tabs) killed automatically and resume retries
- [RS-07] Spawn effect guards against dead sessions (session.state === 'dead') -- prevents restored dead sessions from auto-spawning with --session-id on startup. Respawns still work because triggerRespawn sets state to 'starting' before incrementing respawnCounter
  - Files: src/components/Terminal/TerminalPanel.tsx
- [RS-08] Auto-resume effect uses prevVisibleRef to detect hidden-to-visible transitions; only fires when tab becomes visible AND session is dead AND conversation is resumable; 150ms delay for render settling
  - Files: src/components/Terminal/TerminalPanel.tsx
- [RS-09] Terminal reset on respawn: writes ANSI RIS (\x1bc) to clear content and scrollback, then fit() to sync xterm.js dimensions before spawning new PTY
  - Files: src/components/Terminal/TerminalPanel.tsx, src/hooks/useTerminal.ts

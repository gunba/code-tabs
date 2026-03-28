---
paths:
  - "src/components/ResumePicker/**"
  - "src/components/Terminal/TerminalPanel.tsx"
---

# Session Resume

<!-- Codes: SR=Session Resume -->

- [SR-01] Resumed sessions show loading spinner until inspector connects (~1s) and confirms session is responsive
- [SR-02] Token/cost counters show only NEW conversation usage (inspector starts accumulating from connection time)
- [SR-03] First user message captured by inspector's `firstMsg` field for tab naming
- [SR-04] Subagent card colors: plain --bg-surface base; active cards get muted border-left (--text-muted) with pulsing text color (subagent-text-pulse on name/msg); idle at 0.4 opacity; icon uses --accent (warm clay); selected cards get accent-secondary border + tinted bg with animation suppressed
- [SR-05] Nested subagents supported via agentId-based routing (each event tagged with agentId, parentSessionId tracked per subagent)
- [SR-06] Loading spinner @keyframes spin rule defined in TerminalPanel.css — animates border-top rotation at 0.8s linear infinite
  - Files: src/components/Terminal/TerminalPanel.css
- [SR-07] Content search: typing 3+ chars in the filter bar triggers a debounced (400ms) Rust backend scan of all conversation JSONL files, matching user and assistant messages. Results appear below metadata matches with a blue left border and snippet. Stale results discarded via counter-based ref.
  - Files: src/components/ResumePicker/ResumePicker.tsx, src-tauri/src/commands.rs
- [SR-08] Worktree flag stripping on resume: `-w` and `--worktree` flags are stripped from extraFlags via `stripWorktreeFlags()` when resuming or respawning a session. Prevents creating a duplicate worktree — the session resumes in the existing worktree directory (workingDir was updated by inspector cwd detection [SI-20]).
  - Files: src/lib/claude.ts, src/components/Terminal/TerminalPanel.tsx, src/components/ResumePicker/ResumePicker.tsx

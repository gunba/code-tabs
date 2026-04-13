---
paths:
  - "src-tauri/src/commands/data.rs"
---

# src-tauri/src/commands/data.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Rust Command Modules

- [RC-06 L221] list_past_sessions -- Scan ~/.claude/projects/ for resumable sessions. Async with spawn_blocking. Head pass reads first 30 lines for firstMessage + sourceToolAssistantUUID; tail pass seeks last 256KB for lastMessage + model. Chain detection resolves sourceToolAssistantUUID to parent session via UUID map.

## Session Launcher

- [SL-19 L878] Directory validation: before launching, SessionLauncher invokes dir_exists (Rust command) to confirm the working directory exists; shows 'Directory does not exist' error inline and blocks launch if not found
- [SL-20 L878] Recent dir pruning: pruneRecentDirs() called on app init; invokes dir_exists for each recentDir in parallel, removes any that no longer exist on disk

## Rust System Command Modules

- [RC-17 L495] search_session_content: async Rust command scanning JSONL files for substring matches. Walks ~/.claude/projects/, skips files >20MB, stops at 50 results, returns sessionId + 200-char snippet. Uses extract_message_text helper for full text extraction.

---
paths:
  - "src-tauri/src/commands/data.rs"
---

# src-tauri/src/commands/data.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Rust Command Modules

- [RC-06 L221] list_past_sessions -- Scan ~/.claude/projects/ for resumable sessions. Async with spawn_blocking. Head pass reads first 30 lines for firstMessage + sourceToolAssistantUUID; tail pass seeks last 256KB for lastMessage + model. Chain detection resolves sourceToolAssistantUUID to parent session via UUID map.

## Rust Session Commands

- [RC-04 L232] list_past_sessions_sync detects plan-mode forks by capturing `sourceToolAssistantUUID` during the head pass and resolving it during chain detection.
- [RC-22 L879] reveal_in_file_manager Tauri command in src-tauri/src/commands/data.rs:L880 wraps the internal reveal_path() helper (data.rs:L31) to open the given path in the system file manager. Cross-platform: Windows uses 'explorer /select,<path>', macOS uses 'open -R <path>', Linux uses 'xdg-open <dir>'. Exposed to frontend as invoke('reveal_in_file_manager', { path }) — called by the WebLinksAddon custom handler and terminalPathLinks activate handler on Ctrl/Cmd+click.

## Rust System Command Modules

- [RC-17 L496] search_session_content: async Rust command scanning JSONL files for substring matches. Walks ~/.claude/projects/, skips files >20MB, stops at 50 results, returns sessionId + 200-char snippet. Uses extract_message_text helper for full text extraction.

## Session Launcher

- [SL-19 L885] Directory validation: before launching, SessionLauncher invokes dir_exists (Rust command) to confirm the working directory exists; shows 'Directory does not exist' error inline and blocks launch if not found
- [SL-20 L885] Recent dir pruning: pruneRecentDirs() called on app init; invokes dir_exists for each recentDir in parallel, removes any that no longer exist on disk

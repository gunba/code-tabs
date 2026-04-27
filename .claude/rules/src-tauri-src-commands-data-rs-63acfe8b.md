---
paths:
  - "src-tauri/src/commands/data.rs"
---

# src-tauri/src/commands/data.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Rust Command Modules

- [RC-06 L381] list_past_sessions -- Scan ~/.claude/projects/ for resumable sessions. Async with spawn_blocking. Head pass reads first 30 lines for firstMessage + sourceToolAssistantUUID; tail pass seeks last 256KB for lastMessage + model. Chain detection resolves sourceToolAssistantUUID to parent session via UUID map.

## Rust Session Commands

- [RC-04 L392] list_past_sessions_sync detects plan-mode forks by capturing `sourceToolAssistantUUID` during the head pass and resolving it during chain detection.
- [RC-22 L1663] reveal_in_file_manager Tauri command in src-tauri/src/commands/data.rs:L880 wraps the internal reveal_path() helper (data.rs:L31) to open the given path in the system file manager. Cross-platform: Windows uses 'explorer /select,<path>', macOS uses 'open -R <path>', Linux uses 'xdg-open <dir>'. Exposed to frontend as invoke('reveal_in_file_manager', { path }) — called by the WebLinksAddon custom handler and terminalPathLinks activate handler on Ctrl/Cmd+click.
- [RC-25 L1810] read_codex_session_messages Tauri command + Codex rollout parser: read_codex_session_messages(session_id) resolves the per-session rollout path via codex_rollout_path_for_session (codex-rollout-path.txt sidecar with observability.jsonl fallback), then dispatches into read_conversation_sync. The Codex branch of read_conversation_sync handles rollout JSONL directly and emits CapturedMessage-shaped JSON: response_item/message -> {role, content:[{text}]} via codex_text_from_content; response_item/function_call|custom_tool_call -> assistant message with single tool_use block (id from call_id, name, input from codex_tool_input which JSON-parses the arguments string and falls back to Value::String for raw payloads like apply_patch); response_item/function_call_output|custom_tool_call_output -> user message with single tool_result block (toolUseId from call_id, text truncated via truncate_block_text); response_item/reasoning -> assistant message with reasoning block (no plaintext, optional summary array); compacted -> system message with single compaction_summary block. session_meta/turn_context/event_msg are explicitly skipped. Unknown response_item types are dropped via codex_response_item_to_message returning None. MAX_BLOCK_TEXT=2000 enforced via floor_char_boundary. MAX_CONVERSATION_MESSAGES bumped 500->2000 to accommodate Codex rollouts where each function_call is one message. Frontend Context modal calls read_codex_session_messages on mount and on every CodexTaskComplete/UserInterruption tap event.
  - src-tauri/src/commands/data.rs:L1815 (read_codex_session_messages Tauri command), data.rs:L1829 (read_conversation_sync entry), data.rs:L1684 (truncate_block_text helper), data.rs:L1696 (codex_tool_input — JSON parse + fallback to raw string + 2000-char truncate), data.rs:L1722 (codex_response_item_to_message — payload-type dispatch), data.rs:L1786 (codex_compaction_marker)

## Rust System Command Modules

- [RC-17 L896] search_session_content: async Rust command scanning JSONL files for substring matches. Walks ~/.claude/projects/, skips files >20MB, stops at 50 results, returns sessionId + 200-char snippet. Uses extract_message_text helper for full text extraction.

## Session Launcher

- [SL-19 L1669] Directory validation: before launching, SessionLauncher invokes dir_exists (Rust command) to confirm the working directory exists; shows 'Directory does not exist' error inline and blocks launch if not found
- [SL-20 L1669] Recent dir pruning: pruneRecentDirs() called on app init; invokes dir_exists for each recentDir in parallel, removes any that no longer exist on disk

## Session Resume

- [SR-09 L12] Codex resume picker support: collect_codex_rollout_files walks $CODEX_HOME/sessions (or ~/.codex/sessions) recursively for rollout-*.jsonl files. summarize_codex_rollout reads each file linearly, extracting session_meta (id, cwd), turn_context (cwd, model), event_msg user_message (first/last user prompt, truncate_preview to 150 chars), and response_item (last user/assistant content via codex_text_from_content over input_text/output_text/text blocks). codex_id_from_rollout_filename extracts the trailing 36-char UUID. List_past_sessions_sync pushes each codex rollout as a RawEntry alongside Claude entries; cli="codex" tags the entry. search_session_content_sync also indexes codex rollouts (same file walk + extract_codex_message_text/codex_user_event_text).
  - src-tauri/src/commands/data.rs:L12 (collect_codex_rollout_files), src-tauri/src/commands/data.rs:L41 (codex_id_from_rollout_filename), src-tauri/src/commands/data.rs:L87 (summarize_codex_rollout), src-tauri/src/commands/data.rs:L578 (codex branch in list_past_sessions_sync), src-tauri/src/commands/data.rs:L973 (codex branch in search_session_content_sync)

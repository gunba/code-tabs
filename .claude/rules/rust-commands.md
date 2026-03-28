---
paths:
  - "src-tauri/src/commands.rs"
  - "src-tauri/src/lib.rs"
---

# Rust Commands

<!-- Codes: RC=Rust Commands -->

- [RC-01] `create_session` / `close_session` — Session CRUD
- [RC-02] `build_claude_args` — SessionConfig -> CLI args (`--resume`, `--session-id`, `--project-dir`, etc.)
- [RC-03] `start_jsonl_watcher` / `stop_jsonl_watcher` — Tail JSONL files, emit events (fast scan for resumed sessions)
- [RC-04] `find_continuation_session` — Detect plan-mode forks via sessionId in first events of other JSONL files
- [RC-05] `detect_claude_cli` / `check_cli_version` / `get_cli_help` — CLI discovery
- [RC-06] `list_past_sessions` — Scan `~/.claude/projects/` for resumable sessions (async, `spawn_blocking`)
- [RC-07] `get_first_user_message` — Read first user message from session JSONL
- [RC-08] `persist_sessions_json` / `load_persisted_sessions` — Save/restore sessions
- [RC-09] `discover_builtin_commands` / `discover_plugin_commands` — Slash command discovery
- [RC-10] `discover_hooks` / `save_hooks` — Hook configuration
- [RC-11] register_active_pid / unregister_active_pid -- frontend registers OS PIDs of PTY children; RunEvent::Exit handler iterates ActivePids and calls kill_process_tree_sync for each
  - Files: src-tauri/src/commands.rs:1370, src-tauri/src/lib.rs:176
- [RC-12] Config files read/write: read_config_file and write_config_file handle settings JSON, CLAUDE.md (3 scopes), and agent files (3 scopes: user=~/.claude/agents/, project={wd}/.claude/agents/, local={wd}/.claude/local/agents/). list_agents takes scope param. Parent dirs auto-created on write.
  - Files: src-tauri/src/commands.rs:1758, src-tauri/src/commands.rs:1769
- [RC-13] kill_orphan_sessions: takes Vec<String> session IDs, finds processes by command line match (WMIC on Windows, pgrep on Unix), kills all without ancestry check (safe at startup since no live sessions exist yet). Returns count of killed processes
  - Files: src-tauri/src/commands.rs:1637, src/store/sessions.ts:90
- [RC-14] send_notification: Custom WinRT toast command bypassing Tauri notification plugin. Uses tauri-winrt-notification Toast with on_activated callback that emits notification-clicked event to frontend. Dev mode uses PowerShell app ID, production uses bundle identifier. spawn_blocking + CREATE_NO_WINDOW compliant.
  - Files: src-tauri/src/commands.rs:1836, src/hooks/useNotifications.ts:44
- [RC-15] drain_output -- drain channel before session destroy (spawn_blocking, 500ms deadline)
  - Files: src-tauri/pty-patch/src/lib.rs:348
- [RC-16] read_claude_binary(cli_path) resolves Claude Code binary through 5-step chain: .cmd shim parse -> direct CLI path -> sibling node_modules -> legacy versions dir -> npm root -g. Enables slash command/settings discovery on standalone installs.
  - Files: src-tauri/src/commands.rs:624
- [RC-17] search_session_content: async Rust command scanning JSONL files for substring matches. Walks ~/.claude/projects/, skips files >20MB, stops at 50 results, returns sessionId + 200-char snippet. Uses extract_message_text helper for full text extraction from user/assistant events.
  - Files: src-tauri/src/commands.rs:407, src-tauri/src/lib.rs:137
- [RC-18] Plugin management IPC: plugin_list (claude plugin list --available --json), plugin_install (--scope), plugin_uninstall, plugin_enable, plugin_disable. All async with spawn_blocking + CREATE_NO_WINDOW (via run_claude_cli helper). Raw JSON passthrough for plugin_list; string result for mutations.
  - Files: src-tauri/src/commands.rs:1879, src-tauri/src/lib.rs:167
- [RC-19] prune_worktree: runs `git worktree remove --force <path>` (always forced — dialog is the confirmation). Async with spawn_blocking + CREATE_NO_WINDOW. Takes worktree_path and project_root (cwd for git). Returns error string on failure.
  - Files: src-tauri/src/commands.rs:1877, src-tauri/src/lib.rs:168

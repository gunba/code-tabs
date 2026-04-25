---
paths:
  - "src-tauri/src/observability/codex_rollout.rs"
---

# src-tauri/src/observability/codex_rollout.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Codex Rollout Observability

- [CR-01 L63] Codex rollout JSONL location: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl (CODEX_HOME defaults to ~/.codex; respects CODEX_HOME env override). File appended per-turn with lines: {timestamp, type: session_meta|response_item|event_msg|compacted|turn_context, payload}. This is the structured event source for Codex TUI session observability — no JSON-RPC or app-server attach.
- [CR-02 L112] notify-based watcher pattern in codex_rollout.rs: start_codex_rollout Tauri command creates a CodexRolloutHandle (oneshot stop channel), inserts it into CodexRolloutState registry before spawn (prevents start/stop race), then spawns run_watcher. run_watcher calls find_unclaimed_rollout first (handles race where Codex creates file before watcher arms), then wait_for_new_rollout (notify::recommended_watcher on today's dir, loops on Create/Modify events), then tail_rollout (notify watch on specific file + BufReader::read_line loop). stop_codex_rollout removes handle from registry and sends stop signal.
- [CR-03 L168] start_codex_rollout / stop_codex_rollout Tauri commands manage CodexRolloutState (Mutex<HashMap<session_id, Arc<CodexRolloutHandle>>>). start_codex_rollout inserts the handle before tokio::spawn to guarantee stop_codex_rollout can always find and stop the watcher. stop_codex_rollout removes and drops the handle, sending stop signal. Called by TerminalPanel on session spawn/exit (stop_codex_rollout invoked in handlePtyExit).

---
paths:
  - "src-tauri/src/observability/codex_rollout.rs"
---

# src-tauri/src/observability/codex_rollout.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Codex Rollout Observability

- [CR-01 L64] Codex rollout JSONL location: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl (CODEX_HOME defaults to ~/.codex; respects CODEX_HOME env override). File appended per-turn with lines: {timestamp, type: session_meta|response_item|event_msg|compacted|turn_context, payload}. This is the structured event source for Codex TUI session observability — no JSON-RPC or app-server attach.
- [CR-02 L124] notify-based watcher pattern in codex_rollout.rs: start_codex_rollout Tauri command creates a CodexRolloutHandle (oneshot stop channel), inserts it into CodexRolloutState registry before spawn (prevents start/stop race), then spawns run_watcher. run_watcher calls claim_unclaimed_rollout first (atomic: lock shared claimed_rollouts Arc<Mutex<HashSet>>, find fresh file, insert to claimed set in one lock), then wait_for_new_rollout (notify::recommended_watcher on today's dir, loops on Create/Modify events, also uses claim_unclaimed_rollout for race-safe attribution), then tail_rollout. Prevents multiple sessions from claiming the same rollout file. Attributed path written to codex-rollout-path.txt in session data dir.
- [CR-03 L188] start_codex_rollout / stop_codex_rollout Tauri commands manage CodexRolloutState (Mutex<HashMap<session_id, Arc<CodexRolloutHandle>>>). start_codex_rollout inserts the handle before tokio::spawn to guarantee stop_codex_rollout can always find and stop the watcher. stop_codex_rollout removes and drops the handle, sending stop signal. Called by TerminalPanel on session spawn/exit (stop_codex_rollout invoked in handlePtyExit).

## Codex Rollout Tap Bridge

- [CX-01 L409] emit_tap_entry in codex_rollout.rs publishes per-session 'tap-entry-{sid}' Tauri events with cat fields so the unified tap pipeline drives Codex. Rollout line types map to cats: session_meta->codex-session (also fires SessionRegistration-like), session_configured(thread_name present)->codex-thread-name-updated (emits codexSessionId+threadName), turn_context->codex-turn-context, token_count event_msg->codex-token-count (with info and rateLimits), exec_command_end event_msg->codex-tool-call-complete, function_call/custom_tool_call response_item->codex-tool-call-start + codex-tool-input (dual emit), function_call_output/custom_tool_call_output->codex-tool-call-complete, message->codex-message, compacted->codex-compacted. function_call and custom_tool_call are handled identically; arguments falls back to input field.

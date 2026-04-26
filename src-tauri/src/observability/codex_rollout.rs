//! Codex session observability via rollout-file tailing.
//!
//! The user runs `codex` interactively in xterm — same shape as a
//! Claude session. We can't attach to Codex over JSON-RPC the way
//! `codex app-server` clients do (the app-server drives its own
//! sessions; it doesn't observe a TUI session). What Codex *does* do
//! during a TUI session is append every turn, tool call, token-count
//! update, and approval to a per-session rollout JSONL at:
//!
//!   `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
//!
//! That file is the structured event source. This module:
//!   1. Watches the today's-date directory for new rollout files
//!      created after the session spawn time.
//!   2. Attributes the first matching file to the session.
//!   3. Tails the file, parsing each line as a `RolloutItem` and
//!      writing a normalized envelope into `observability.jsonl` via
//!      `record_backend_event` — the same sink the Claude tap pipeline
//!      uses.
//!
//! Wire shape per line in the rollout file (confirmed against
//! `~/.codex/sessions/2025/11/18/...`):
//!
//!   { "timestamp": "ISO8601", "type": "session_meta" | "response_item"
//!     | "event_msg" | "compacted" | "turn_context", "payload": {...} }

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use notify::{EventKind, RecursiveMode, Watcher};
use serde::Deserialize;
use serde_json::Value;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;

use crate::observability::record_backend_event;

#[derive(Debug, Deserialize)]
struct RolloutLine {
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    payload: Value,
}

/// Resolve `$CODEX_HOME` honoring the env override; default to
/// `~/.codex`. Mirrors what the Codex binary itself does.
fn codex_home() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CODEX_HOME") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    dirs::home_dir().map(|h| h.join(".codex"))
}

/// `$CODEX_HOME/sessions/YYYY/MM/DD` for today (local time). We watch
/// this directory because that's where the new rollout file will land.
// [CR-01] Rollout JSONL path: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl; CODEX_HOME defaults to ~/.codex
fn todays_sessions_dir() -> Option<PathBuf> {
    let home = codex_home()?;
    let now = chrono::Local::now();
    Some(home.join(now.format("sessions/%Y/%m/%d").to_string()))
}

/// Pick a rollout file in `dir` whose mtime is ≥ `spawn_time` and
/// hasn't been claimed yet. Used as the initial-attribution heuristic
/// when the watcher starts: there may already be a fresh file from a
/// race between PTY spawn and the watcher's first notify event.
fn find_unclaimed_rollout(
    dir: &Path,
    spawn_time: SystemTime,
    claimed: &HashSet<PathBuf>,
) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut best: Option<(PathBuf, SystemTime)> = None;
    for ent in entries.flatten() {
        let path = ent.path();
        if claimed.contains(&path) {
            continue;
        }
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if !name.starts_with("rollout-") || !name.ends_with(".jsonl") {
            continue;
        }
        // A transient stat failure (file rolling over on a slow FS,
        // ENOENT mid-iteration) must not abort attribution for the
        // whole directory — only skip this entry.
        let mtime = match ent.metadata().and_then(|m| m.modified()) {
            Ok(t) => t,
            Err(_) => continue,
        };
        if mtime < spawn_time {
            continue;
        }
        match &best {
            None => best = Some((path, mtime)),
            Some((_, prev)) if mtime > *prev => best = Some((path, mtime)),
            _ => {}
        }
    }
    best.map(|(p, _)| p)
}

fn claim_unclaimed_rollout(
    dir: &Path,
    spawn_time: SystemTime,
    claimed_rollouts: &Arc<std::sync::Mutex<HashSet<PathBuf>>>,
) -> Option<PathBuf> {
    let mut claimed = claimed_rollouts.lock().ok()?;
    let path = find_unclaimed_rollout(dir, spawn_time, &claimed)?;
    claimed.insert(path.clone());
    Some(path)
}

/// Start a watcher that tails the rollout file for `session_id` and
/// emits normalized events into `observability.jsonl`. Returns a
/// handle that, when dropped, stops the watcher.
// [CR-02] notify-based watcher: find_unclaimed_rollout -> wait_for_new_rollout -> tail_rollout; handle inserted before spawn to prevent start/stop race
pub fn start_codex_rollout_watcher(
    app: tauri::AppHandle,
    session_id: String,
    spawn_time: SystemTime,
    claimed_rollouts: Arc<std::sync::Mutex<HashSet<PathBuf>>>,
) -> CodexRolloutHandle {
    // Build the channel and the handle *before* spawning so the
    // caller can put the handle into its registry before the watcher
    // task gets a chance to run. Without this ordering, a respawn
    // that calls stop immediately after start can race past an empty
    // map and leave the new watcher running unsupervised.
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    let session_id_for_task = session_id.clone();
    let app_for_task = app.clone();
    tokio::spawn(async move {
        if let Err(e) =
            run_watcher(
                app_for_task.clone(),
                session_id_for_task.clone(),
                spawn_time,
                claimed_rollouts,
                stop_rx,
            )
                .await
        {
            record_backend_event(
                &app_for_task,
                "WARN",
                "codex.rollout",
                Some(&session_id_for_task),
                "codex.rollout.watcher_failed",
                "Codex rollout watcher exited with error",
                serde_json::json!({ "error": e }),
            );
        }
    });
    let _ = session_id; // kept for symmetry with future logging hooks
    CodexRolloutHandle {
        stop_tx: Mutex::new(Some(stop_tx)),
    }
}

pub struct CodexRolloutHandle {
    stop_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl CodexRolloutHandle {
    pub async fn stop(&self) {
        if let Some(tx) = self.stop_tx.lock().await.take() {
            let _ = tx.send(());
        }
    }
}

/// App-state registry of active Codex rollout watchers, keyed by
/// claude-tabs session id (NOT the Codex conversation id, which we
/// don't know until the rollout file is attributed).
#[derive(Default)]
pub struct CodexRolloutState {
    watchers: std::sync::Mutex<HashMap<String, Arc<CodexRolloutHandle>>>,
    claimed_rollouts: Arc<std::sync::Mutex<HashSet<PathBuf>>>,
}

// [CR-03] start_codex_rollout/stop_codex_rollout: CodexRolloutState registry keyed by session_id; handle inserted before spawn for stop-race safety
#[tauri::command]
pub async fn start_codex_rollout(
    session_id: String,
    state: tauri::State<'_, CodexRolloutState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let spawn_time = SystemTime::now();
    // Insert the handle into the registry *before* the watcher task
    // gets to run. tokio::spawn doesn't promise that the spawned
    // future is suspended before the calling fn returns; serializing
    // through the lock here means a follow-up stop_codex_rollout call
    // sees the new handle instead of an empty slot.
    let handle = Arc::new(start_codex_rollout_watcher(
        app.clone(),
        session_id.clone(),
        spawn_time,
        state.claimed_rollouts.clone(),
    ));
    let prior = {
        let mut map = state
            .watchers
            .lock()
            .map_err(|e| format!("watcher state poisoned: {e}"))?;
        map.insert(session_id.clone(), handle)
    };
    if let Some(prev) = prior {
        // Best-effort stop of any prior watcher for the same session
        // (respawn case). Drop our reference; the spawned task ends.
        let p = prev.clone();
        tauri::async_runtime::spawn(async move { p.stop().await });
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_codex_rollout(
    session_id: String,
    state: tauri::State<'_, CodexRolloutState>,
) -> Result<(), String> {
    let handle = {
        let mut map = state
            .watchers
            .lock()
            .map_err(|e| format!("watcher state poisoned: {e}"))?;
        map.remove(&session_id)
    };
    if let Some(h) = handle {
        h.stop().await;
    }
    Ok(())
}

async fn run_watcher(
    app: tauri::AppHandle,
    session_id: String,
    spawn_time: SystemTime,
    claimed_rollouts: Arc<std::sync::Mutex<HashSet<PathBuf>>>,
    mut stop_rx: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), String> {
    let dir = todays_sessions_dir().ok_or("could not resolve $CODEX_HOME/sessions/today")?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create rollout dir: {e}"))?;

    // Try to attribute an existing fresh rollout first (handles the
    // race where Codex creates the file before our watcher arms).
    let file_path = match claim_unclaimed_rollout(&dir, spawn_time, &claimed_rollouts) {
        Some(p) => Some(p),
        None => wait_for_new_rollout(&dir, spawn_time, &claimed_rollouts, &mut stop_rx).await?,
    };
    let file_path = match file_path {
        Some(p) => p,
        None => return Ok(()), // stop signaled
    };

    if let Ok(dir) = crate::commands::data::get_session_data_dir(&session_id) {
        let _ = std::fs::write(
            dir.join("codex-rollout-path.txt"),
            file_path.to_string_lossy().as_bytes(),
        );
    }

    record_backend_event(
        &app,
        "DEBUG",
        "codex.rollout",
        Some(&session_id),
        "codex.rollout.attributed",
        "Attributed Codex rollout file to session",
        serde_json::json!({ "path": file_path.to_string_lossy() }),
    );

    tail_rollout(&app, &session_id, &file_path, &mut stop_rx).await
}

/// Block until either (a) a new rollout-*.jsonl appears in `dir` with
/// mtime ≥ spawn_time, or (b) `stop_rx` resolves. Returns Some(path) or
/// None on stop.
async fn wait_for_new_rollout(
    dir: &Path,
    spawn_time: SystemTime,
    claimed_rollouts: &Arc<std::sync::Mutex<HashSet<PathBuf>>>,
    stop_rx: &mut tokio::sync::oneshot::Receiver<()>,
) -> Result<Option<PathBuf>, String> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if matches!(ev.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| format!("notify watcher: {e}"))?;
    watcher
        .watch(dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("notify watch {dir:?}: {e}"))?;

    loop {
        // Re-check on every signal — a single Create event may not
        // guarantee the file is fully created when we read.
        if let Some(p) = claim_unclaimed_rollout(dir, spawn_time, claimed_rollouts) {
            return Ok(Some(p));
        }
        tokio::select! {
            recv = rx.recv() => {
                // None means the watcher's sender was dropped; without
                // it we cannot make progress, so bail rather than spin.
                if recv.is_none() {
                    return Err("notify watcher closed before rollout file appeared".into());
                }
                continue;
            }
            _ = &mut *stop_rx => return Ok(None),
        }
    }
}

async fn tail_rollout(
    app: &tauri::AppHandle,
    session_id: &str,
    path: &Path,
    stop_rx: &mut tokio::sync::oneshot::Receiver<()>,
) -> Result<(), String> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("open rollout {path:?}: {e}"))?;
    let mut reader = BufReader::new(file);

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let watch_path = path.to_path_buf();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if matches!(ev.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| format!("notify watcher: {e}"))?;
    watcher
        .watch(&watch_path, RecursiveMode::NonRecursive)
        .map_err(|e| format!("notify watch {watch_path:?}: {e}"))?;

    let app_arc = Arc::new(app.clone());
    let mut prompt_state = CodexPromptCaptureState::default();
    loop {
        // Drain whatever is currently readable.
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line).await {
                Ok(0) => break, // EOF; wait for more
                Ok(_) => {
                    handle_rollout_line(&app_arc, session_id, line.trim_end(), &mut prompt_state);
                }
                Err(e) => {
                    return Err(format!("read rollout: {e}"));
                }
            }
        }
        tokio::select! {
            recv = rx.recv() => {
                if recv.is_none() {
                    return Err("notify watcher closed while tailing rollout".into());
                }
                continue;
            }
            _ = &mut *stop_rx => return Ok(()),
        }
    }
}

#[derive(Default)]
struct CodexPromptCaptureState {
    base_instructions: Option<String>,
    last_capture_key: Option<String>,
}

fn handle_rollout_line(
    app: &tauri::AppHandle,
    session_id: &str,
    line: &str,
    prompt_state: &mut CodexPromptCaptureState,
) {
    if line.is_empty() {
        return;
    }
    let parsed: RolloutLine = match serde_json::from_str(line) {
        Ok(p) => p,
        Err(e) => {
            record_backend_event(
                app,
                "WARN",
                "codex.rollout",
                Some(session_id),
                "codex.rollout.parse_failed",
                "Failed to parse rollout line",
                serde_json::json!({ "error": e.to_string(), "len": line.len() }),
            );
            return;
        }
    };
    emit_normalized(app, session_id, &parsed, prompt_state);
}

fn rollout_ts_millis(ts: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(ts)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or_else(|_| chrono::Utc::now().timestamp_millis())
}

fn parsed_str<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty())
}

// [CX-01] emit_tap_entry publishes 'tap-entry-{sid}' events with codex-* cats; function_call/custom_tool_call dual-handled; dual emit (tool-call-start + tool-input) for tool calls
fn emit_tap_entry(app: &tauri::AppHandle, session_id: &str, ts: &str, mut entry: Value) {
    let Some(obj) = entry.as_object_mut() else {
        return;
    };
    obj.insert("ts".into(), Value::Number(rollout_ts_millis(ts).into()));
    obj.insert("tsIso".into(), Value::String(ts.to_string()));
    let event_name = format!("tap-entry-{session_id}");
    if let Ok(line) = serde_json::to_string(&entry) {
        let _ = app.emit(&event_name, line);
    }
}

/// Translate a `RolloutItem` into one (or more) `record_backend_event`
/// calls. The taxonomy mirrors what tap classifier emits for Claude.
fn emit_normalized(
    app: &tauri::AppHandle,
    session_id: &str,
    parsed: &RolloutLine,
    prompt_state: &mut CodexPromptCaptureState,
) {
    let ts = parsed.timestamp.clone().unwrap_or_default();
    match parsed.kind.as_str() {
        "session_meta" => {
            let id = parsed.payload.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let cwd = parsed
                .payload
                .get("cwd")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let cli_version = parsed
                .payload
                .get("cli_version")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if let Some(text) = parsed
                .payload
                .get("base_instructions")
                .and_then(|v| v.get("text"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                prompt_state.base_instructions = Some(text.to_string());
                record_backend_event(
                    app,
                    "LOG",
                    "codex.rollout",
                    Some(session_id),
                    "codex.system_prompt",
                    "Codex system instructions captured",
                    serde_json::json!({
                        "ts": ts,
                        "codexSessionId": id,
                        "text": text,
                        "length": text.len(),
                    }),
                );
            }
            record_backend_event(
                app,
                "LOG",
                "codex.rollout",
                Some(session_id),
                "codex.session_started",
                "Codex session started",
                serde_json::json!({
                    "ts": ts,
                    "codexSessionId": id,
                    "cwd": cwd,
                    "cliVersion": cli_version,
                }),
            );
            emit_tap_entry(
                app,
                session_id,
                &ts,
                serde_json::json!({
                    "cat": "codex-session",
                    "codexSessionId": id,
                    "cwd": cwd,
                    "cliVersion": cli_version,
                }),
            );
        }
        "turn_context" => {
            emit_codex_prompt_capture(app, session_id, &ts, &parsed.payload, prompt_state);
            record_backend_event(
                app,
                "DEBUG",
                "codex.rollout",
                Some(session_id),
                "codex.turn_context",
                "Turn context",
                serde_json::json!({
                    "ts": ts,
                    "payload": &parsed.payload,
                }),
            );
            emit_tap_entry(
                app,
                session_id,
                &ts,
                serde_json::json!({
                    "cat": "codex-turn-context",
                    "cwd": parsed.payload.get("cwd"),
                    "approvalPolicy": parsed.payload.get("approval_policy"),
                    "sandboxPolicy": parsed.payload.get("sandbox_policy"),
                    "model": parsed.payload.get("model"),
                    "effort": parsed.payload.get("effort"),
                }),
            );
        }
        "event_msg" => emit_event_msg(app, session_id, &ts, &parsed.payload),
        "response_item" => emit_response_item(app, session_id, &ts, &parsed.payload),
        "compacted" => {
            record_backend_event(
                app,
                "LOG",
                "codex.rollout",
                Some(session_id),
                "codex.compacted",
                "Conversation compacted",
                serde_json::json!({ "ts": ts, "payload": &parsed.payload }),
            );
            emit_tap_entry(
                app,
                session_id,
                &ts,
                serde_json::json!({ "cat": "codex-compacted", "payload": &parsed.payload }),
            );
        }
        other => {
            record_backend_event(
                app,
                "DEBUG",
                "codex.rollout",
                Some(session_id),
                "codex.rollout.unknown_kind",
                "Unknown rollout item type",
                serde_json::json!({ "ts": ts, "kind": other }),
            );
        }
    }
}

fn turn_context_developer_instructions(payload: &Value) -> Option<&str> {
    payload
        .get("collaboration_mode")
        .and_then(|v| v.get("settings"))
        .and_then(|v| v.get("developer_instructions"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
}

fn turn_context_user_instructions(payload: &Value) -> Option<&str> {
    payload
        .get("user_instructions")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
}

fn text_message(role: &str, text: &str) -> Value {
    serde_json::json!({
        "role": role,
        "content": [{ "type": "text", "text": text }],
    })
}

fn emit_codex_prompt_capture(
    app: &tauri::AppHandle,
    session_id: &str,
    ts: &str,
    payload: &Value,
    prompt_state: &mut CodexPromptCaptureState,
) {
    let Some(base) = prompt_state.base_instructions.as_deref() else {
        return;
    };
    if base.is_empty() {
        return;
    }

    let model = payload.get("model").and_then(|v| v.as_str()).unwrap_or("");
    let developer = turn_context_developer_instructions(payload);
    let user = turn_context_user_instructions(payload);
    let capture_key = format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}",
        model,
        base,
        developer.unwrap_or(""),
        user.unwrap_or(""),
    );
    if prompt_state.last_capture_key.as_deref() == Some(capture_key.as_str()) {
        return;
    }
    prompt_state.last_capture_key = Some(capture_key);

    let mut messages = Vec::new();
    if let Some(text) = developer {
        messages.push(text_message("developer", text));
    }
    if let Some(text) = user {
        messages.push(text_message("user", text));
    }
    let message_count = messages.len();

    record_backend_event(
        app,
        "LOG",
        "codex.rollout",
        Some(session_id),
        "codex.prompt_capture",
        "Codex prompt context captured",
        serde_json::json!({
            "ts": ts,
            "model": model,
            "systemInstructionsLength": base.len(),
            "developerInstructionsLength": developer.map(str::len).unwrap_or(0),
            "userInstructionsLength": user.map(str::len).unwrap_or(0),
            "messages": &messages,
        }),
    );
    emit_tap_entry(
        app,
        session_id,
        ts,
        serde_json::json!({
            "cat": "system-prompt",
            "source": "codex-rollout",
            "text": base,
            "model": model,
            "msgCount": message_count,
            "blocks": [{ "text": base }],
            "messages": messages,
        }),
    );
}

fn emit_event_msg(app: &tauri::AppHandle, session_id: &str, ts: &str, payload: &Value) {
    let kind = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "task_started" | "turn_started" => {
            emit_tap_entry(
                app,
                session_id,
                ts,
                serde_json::json!({
                    "cat": "codex-task-started",
                    "turnId": payload.get("turn_id"),
                    "startedAt": payload.get("started_at"),
                }),
            );
            record_backend_event(
                app,
                "LOG",
                "codex.rollout",
                Some(session_id),
                "codex.task_started",
                "Task started",
                serde_json::json!({ "ts": ts, "payload": payload }),
            );
        }
        "task_complete" | "turn_complete" => {
            emit_tap_entry(
                app,
                session_id,
                ts,
                serde_json::json!({
                    "cat": "codex-task-complete",
                    "turnId": payload.get("turn_id"),
                    "lastAgentMessage": payload.get("last_agent_message"),
                    "durationMs": payload.get("duration_ms"),
                    "completedAt": payload.get("completed_at"),
                }),
            );
            record_backend_event(
                app,
                "LOG",
                "codex.rollout",
                Some(session_id),
                "codex.task_complete",
                "Task complete",
                serde_json::json!({ "ts": ts, "payload": payload }),
            );
        }
        "turn_aborted" => {
            emit_tap_entry(
                app,
                session_id,
                ts,
                serde_json::json!({
                    "cat": "codex-turn-aborted",
                    "turnId": payload.get("turn_id"),
                    "reason": payload.get("reason"),
                    "durationMs": payload.get("duration_ms"),
                    "completedAt": payload.get("completed_at"),
                }),
            );
            record_backend_event(
                app,
                "LOG",
                "codex.rollout",
                Some(session_id),
                "codex.turn_aborted",
                payload.get("reason").and_then(|v| v.as_str()).unwrap_or("aborted"),
                serde_json::json!({ "ts": ts, "payload": payload }),
            );
        }
        "token_count" => {
            // payload.info has total_token_usage and last_token_usage,
            // each with input_tokens, cached_input_tokens, output_tokens,
            // reasoning_output_tokens, total_tokens.
            let info = payload.get("info").cloned().unwrap_or_default();
            record_backend_event(
                app,
                "LOG",
                "codex.rollout",
                Some(session_id),
                "codex.token_count",
                "Token usage update",
                serde_json::json!({ "ts": ts, "info": info }),
            );
            emit_tap_entry(
                app,
                session_id,
                ts,
                serde_json::json!({
                    "cat": "codex-token-count",
                    "info": payload.get("info"),
                    "rateLimits": payload.get("rate_limits"),
                }),
            );
        }
        "session_configured" => {
            if let Some(thread_name) = parsed_str(payload, "thread_name") {
                emit_tap_entry(
                    app,
                    session_id,
                    ts,
                    serde_json::json!({
                        "cat": "codex-thread-name-updated",
                        "codexSessionId": payload.get("thread_id"),
                        "threadName": thread_name,
                    }),
                );
            }
            record_backend_event(
                app,
                "DEBUG",
                "codex.rollout",
                Some(session_id),
                "codex.session_configured",
                "Session configured",
                serde_json::json!({ "ts": ts, "payload": payload }),
            );
        }
        "thread_name_updated" => {
            emit_tap_entry(
                app,
                session_id,
                ts,
                serde_json::json!({
                    "cat": "codex-thread-name-updated",
                    "codexSessionId": payload.get("thread_id"),
                    "threadName": payload.get("thread_name"),
                }),
            );
            record_backend_event(
                app,
                "LOG",
                "codex.rollout",
                Some(session_id),
                "codex.thread_name_updated",
                "Thread name updated",
                serde_json::json!({ "ts": ts, "payload": payload }),
            );
        }
        "user_message" => {
            emit_tap_entry(
                app,
                session_id,
                ts,
                serde_json::json!({
                    "cat": "codex-message",
                    "role": "user",
                    "content": [{
                        "type": "input_text",
                        "text": payload.get("message").and_then(|v| v.as_str()).unwrap_or(""),
                    }],
                }),
            );
            record_backend_event(
                app,
                "LOG",
                "codex.rollout",
                Some(session_id),
                "codex.user_message",
                "User message",
                serde_json::json!({ "ts": ts, "payload": payload }),
            );
        }
        "agent_message" => {
            emit_tap_entry(
                app,
                session_id,
                ts,
                serde_json::json!({
                    "cat": "codex-message",
                    "role": "assistant",
                    "phase": payload.get("phase"),
                    "content": [{
                        "type": "output_text",
                        "text": payload.get("message").and_then(|v| v.as_str()).unwrap_or(""),
                    }],
                }),
            );
            record_backend_event(
                app,
                "DEBUG",
                "codex.rollout",
                Some(session_id),
                "codex.agent_message",
                payload.get("phase").and_then(|v| v.as_str()).unwrap_or("assistant"),
                serde_json::json!({ "ts": ts, "payload": payload }),
            );
        }
        "exec_command_end" => {
            record_backend_event(
                app,
                "LOG",
                "codex.rollout",
                Some(session_id),
                "codex.exec_command_end",
                "Command finished",
                serde_json::json!({ "ts": ts, "payload": payload }),
            );
            emit_tap_entry(
                app,
                session_id,
                ts,
                serde_json::json!({
                    "cat": "codex-tool-call-complete",
                    "callId": payload.get("call_id"),
                    "name": "exec_command",
                    "output": payload.get("aggregated_output"),
                    "exitCode": payload.get("exit_code"),
                    "duration": payload.get("duration"),
                }),
            );
        }
        "mcp_tool_call_begin" => {
            let invocation = payload.get("invocation").unwrap_or(&Value::Null);
            let server = invocation.get("server").and_then(|v| v.as_str()).unwrap_or("");
            let tool = invocation.get("tool").and_then(|v| v.as_str()).unwrap_or("");
            let name = format!("mcp__{server}__{tool}");
            let call_id = payload.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
            emit_tap_entry(
                app,
                session_id,
                ts,
                serde_json::json!({
                    "cat": "codex-tool-call-start",
                    "callId": call_id,
                    "name": name,
                }),
            );
            emit_tap_entry(
                app,
                session_id,
                ts,
                serde_json::json!({
                    "cat": "codex-tool-input",
                    "callId": call_id,
                    "name": name,
                    "arguments": invocation.get("arguments"),
                }),
            );
            record_backend_event(
                app,
                "LOG",
                "codex.rollout",
                Some(session_id),
                "codex.mcp_tool_call_begin",
                &name,
                serde_json::json!({ "ts": ts, "payload": payload }),
            );
        }
        "mcp_tool_call_end" => {
            let call_id = payload.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
            emit_tap_entry(
                app,
                session_id,
                ts,
                serde_json::json!({
                    "cat": "codex-tool-call-complete",
                    "callId": call_id,
                    "output": payload.get("result"),
                    "duration": payload.get("duration"),
                }),
            );
            record_backend_event(
                app,
                "LOG",
                "codex.rollout",
                Some(session_id),
                "codex.mcp_tool_call_end",
                "MCP tool finished",
                serde_json::json!({ "ts": ts, "payload": payload }),
            );
        }
        _ => {
            record_backend_event(
                app,
                "DEBUG",
                "codex.rollout",
                Some(session_id),
                "codex.event_msg",
                kind,
                serde_json::json!({ "ts": ts, "payload": payload }),
            );
        }
    }
}

fn emit_response_item(app: &tauri::AppHandle, session_id: &str, ts: &str, payload: &Value) {
    let kind = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "function_call" | "custom_tool_call" => {
            let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let call_id = payload.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
            let arguments = payload
                .get("arguments")
                .or_else(|| payload.get("input"))
                .cloned()
                .unwrap_or(Value::Null);
            record_backend_event(
                app,
                "LOG",
                "codex.rollout",
                Some(session_id),
                "codex.tool_call_start",
                name,
                serde_json::json!({
                    "ts": ts,
                    "callId": call_id,
                    "name": name,
                    "arguments": arguments,
                }),
            );
            emit_tap_entry(
                app,
                session_id,
                ts,
                serde_json::json!({
                    "cat": "codex-tool-call-start",
                    "callId": call_id,
                    "name": name,
                }),
            );
            emit_tap_entry(
                app,
                session_id,
                ts,
                serde_json::json!({
                    "cat": "codex-tool-input",
                    "callId": call_id,
                    "name": name,
                    "arguments": arguments,
                    "status": payload.get("status"),
                }),
            );
        }
        "function_call_output" | "custom_tool_call_output" => {
            let call_id = payload.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
            record_backend_event(
                app,
                "LOG",
                "codex.rollout",
                Some(session_id),
                "codex.tool_call_complete",
                "tool result",
                serde_json::json!({
                    "ts": ts,
                    "callId": call_id,
                    "output": payload.get("output"),
                }),
            );
            emit_tap_entry(
                app,
                session_id,
                ts,
                serde_json::json!({
                    "cat": "codex-tool-call-complete",
                    "callId": call_id,
                    "output": payload.get("output"),
                }),
            );
        }
        "message" => {
            let role = payload.get("role").and_then(|v| v.as_str()).unwrap_or("");
            record_backend_event(
                app,
                "DEBUG",
                "codex.rollout",
                Some(session_id),
                "codex.message",
                role,
                serde_json::json!({ "ts": ts, "payload": payload }),
            );
            emit_tap_entry(
                app,
                session_id,
                ts,
                serde_json::json!({
                    "cat": "codex-message",
                    "role": role,
                    "content": payload.get("content"),
                }),
            );
        }
        _ => {
            record_backend_event(
                app,
                "DEBUG",
                "codex.rollout",
                Some(session_id),
                "codex.response_item",
                kind,
                serde_json::json!({ "ts": ts, "payload": payload }),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_session_meta_line() {
        let line = r#"{"timestamp":"2025-11-18T09:40:36.766Z","type":"session_meta","payload":{"id":"019a9656-691d-7ff3-890e-3e6678ed46d8","cwd":"/proj","cli_version":"0.58.0"}}"#;
        let parsed: RolloutLine = serde_json::from_str(line).unwrap();
        assert_eq!(parsed.kind, "session_meta");
        assert_eq!(parsed.payload.get("id").and_then(|v| v.as_str()), Some("019a9656-691d-7ff3-890e-3e6678ed46d8"));
    }

    #[test]
    fn parses_token_count_event() {
        let line = r#"{"timestamp":"2025-11-18T09:50:46.482Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":20,"reasoning_output_tokens":10,"total_tokens":120}}}}"#;
        let parsed: RolloutLine = serde_json::from_str(line).unwrap();
        assert_eq!(parsed.kind, "event_msg");
        let info = parsed.payload.get("info").unwrap();
        assert_eq!(
            info.get("total_token_usage")
                .and_then(|t| t.get("total_tokens"))
                .and_then(|v| v.as_i64()),
            Some(120)
        );
    }

    #[test]
    fn find_unclaimed_rollout_picks_newest_after_spawn() {
        let tmp = std::env::temp_dir().join(format!("ct-rollout-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // Write a file that *predates* spawn time. Setting mtime via
        // std::fs::File::set_modified (Rust 1.75+).
        let old_path = tmp.join("rollout-2025-01-01T00-00-00-old.jsonl");
        std::fs::write(&old_path, b"").unwrap();
        let old_time = SystemTime::now() - std::time::Duration::from_secs(3600);
        let file = std::fs::OpenOptions::new().write(true).open(&old_path).unwrap();
        let _ = file.set_modified(old_time);

        let spawn = SystemTime::now() - std::time::Duration::from_secs(60);
        std::fs::write(tmp.join("rollout-2025-11-18T09-40-36-new.jsonl"), b"").unwrap();
        let claimed = std::collections::HashSet::new();
        let picked = find_unclaimed_rollout(&tmp, spawn, &claimed).expect("should find new file");
        assert_eq!(
            picked.file_name().and_then(|s| s.to_str()),
            Some("rollout-2025-11-18T09-40-36-new.jsonl")
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

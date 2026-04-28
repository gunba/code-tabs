use crate::path_utils;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

struct ContentSearchCancelSlot {
    token: String,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
struct ContentSearchCancelState {
    active: Option<ContentSearchCancelSlot>,
    cancelled_tokens: HashSet<String>,
}

static CONTENT_SEARCH_CANCEL: LazyLock<Mutex<ContentSearchCancelState>> =
    LazyLock::new(|| Mutex::new(ContentSearchCancelState::default()));
static CODEX_ROLLOUT_UUID_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$",
    )
    .unwrap()
});

fn content_search_cancel_guard() -> std::sync::MutexGuard<'static, ContentSearchCancelState> {
    CONTENT_SEARCH_CANCEL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn begin_content_search(cancel_token: &str) -> Arc<AtomicBool> {
    let mut state = content_search_cancel_guard();
    if let Some(existing) = state.active.as_ref() {
        existing.cancelled.store(true, Ordering::Relaxed);
    }

    let already_cancelled = state.cancelled_tokens.remove(cancel_token);
    let cancelled = Arc::new(AtomicBool::new(already_cancelled));
    state.active = if already_cancelled {
        None
    } else {
        Some(ContentSearchCancelSlot {
            token: cancel_token.to_string(),
            cancelled: Arc::clone(&cancelled),
        })
    };
    cancelled
}

fn finish_content_search(cancel_token: &str) {
    let mut state = content_search_cancel_guard();
    let should_clear = state
        .active
        .as_ref()
        .map(|existing| existing.token == cancel_token)
        .unwrap_or(false);
    if should_clear {
        state.active = None;
    }
    state.cancelled_tokens.remove(cancel_token);
}

fn cancel_content_search(cancel_token: &str) {
    let mut state = content_search_cancel_guard();
    let should_cancel = state
        .active
        .as_ref()
        .map(|existing| existing.token == cancel_token)
        .unwrap_or(false);
    if should_cancel {
        if let Some(existing) = state.active.take() {
            existing.cancelled.store(true, Ordering::Relaxed);
        }
    } else {
        state.cancelled_tokens.insert(cancel_token.to_string());
    }
}

fn content_search_cancelled(cancelled: &AtomicBool) -> bool {
    cancelled.load(Ordering::Relaxed)
}

pub(crate) fn codex_home_dir() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("CODEX_HOME") {
        if !p.is_empty() {
            return Some(std::path::PathBuf::from(p));
        }
    }
    dirs::home_dir().map(|h| h.join(".codex"))
}

// [SR-09] Codex resume picker: walk $CODEX_HOME/sessions for rollout-*.jsonl, summarize each via summarize_codex_rollout (linear pass extracting session_meta + turn_context + event_msg user_message + response_item user/assistant text); list_past_sessions and search_session_content thread these into the unified resume picker alongside Claude entries.
fn collect_codex_rollout_files() -> Vec<std::path::PathBuf> {
    let Some(root) = codex_home_dir().map(|h| h.join("sessions")) else {
        return Vec::new();
    };
    if !root.exists() {
        return Vec::new();
    }

    let mut stack = vec![root];
    let mut files = Vec::new();
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                files.push(path);
            }
        }
    }
    files
}

fn codex_id_from_rollout_filename(path: &std::path::Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    CODEX_ROLLOUT_UUID_RE
        .captures(stem)
        .and_then(|captures| captures.get(1))
        .map(|m| m.as_str().to_string())
}

#[derive(Default)]
struct CodexRolloutSummary {
    session_id: String,
    directory: String,
    first_message: String,
    last_user_message: String,
    last_assistant_message: String,
    model: String,
}

fn truncate_preview(text: &str, limit: usize) -> String {
    let mut out = String::new();
    let mut chars = 0usize;
    let mut pending_space = false;

    for ch in text.chars() {
        if ch.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            if chars >= limit {
                break;
            }
            out.push(' ');
            chars += 1;
            pending_space = false;
        }
        if chars >= limit {
            break;
        }
        out.push(ch);
        chars += 1;
    }

    out
}

fn codex_user_event_text(parsed: &serde_json::Value) -> Option<String> {
    if parsed["type"].as_str()? != "event_msg" {
        return None;
    }
    let payload = &parsed["payload"];
    if payload["type"].as_str()? != "user_message" {
        return None;
    }
    let text = payload["message"].as_str()?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn summarize_codex_rollout(path: &std::path::Path) -> Option<CodexRolloutSummary> {
    let file = std::fs::File::open(path).ok()?;
    use std::io::BufRead;
    let reader = std::io::BufReader::new(file);
    let mut summary = CodexRolloutSummary {
        session_id: codex_id_from_rollout_filename(path).unwrap_or_default(),
        ..CodexRolloutSummary::default()
    };

    for line in reader.lines().map_while(Result::ok) {
        let parsed = match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        match parsed["type"].as_str() {
            Some("session_meta") => {
                let payload = &parsed["payload"];
                if let Some(id) = payload["id"].as_str() {
                    if !id.is_empty() {
                        summary.session_id = id.to_string();
                    }
                }
                if summary.directory.is_empty() {
                    if let Some(cwd) = payload["cwd"].as_str() {
                        summary.directory = cwd.to_string();
                    }
                }
            }
            Some("turn_context") => {
                let payload = &parsed["payload"];
                if summary.directory.is_empty() {
                    if let Some(cwd) = payload["cwd"].as_str() {
                        summary.directory = cwd.to_string();
                    }
                }
                if let Some(model) = payload["model"].as_str() {
                    if !model.is_empty() {
                        summary.model = model.to_string();
                    }
                }
            }
            Some("event_msg") => {
                if let Some(text) = codex_user_event_text(&parsed) {
                    let preview = truncate_preview(&text, 150);
                    if summary.first_message.is_empty() {
                        summary.first_message = preview.clone();
                    }
                    summary.last_user_message = preview;
                }
            }
            Some("response_item") => {
                if let Some((role, text)) = extract_codex_message_text(&parsed) {
                    let preview = truncate_preview(&text, 150);
                    if role == "user" {
                        if summary.first_message.is_empty() {
                            summary.first_message = preview.clone();
                        }
                        summary.last_user_message = preview;
                    } else if role == "assistant" {
                        summary.last_assistant_message = preview;
                    }
                }
            }
            _ => {}
        }
    }

    if summary.session_id.is_empty() {
        None
    } else {
        Some(summary)
    }
}

/// Get the code-tabs data directory (%LOCALAPPDATA%/code-tabs/).
/// Creates it if it doesn't exist.
pub(crate) fn get_data_dir() -> Result<std::path::PathBuf, String> {
    let data_dir = dirs::data_local_dir()
        .ok_or("Could not determine local data directory")?
        .join("code-tabs");
    if !data_dir.exists() {
        std::fs::create_dir_all(&data_dir)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;
    }
    Ok(data_dir)
}

/// Get the per-session data directory: data/sessions/{sessionId}/.
/// Creates it if it doesn't exist.
pub(crate) fn get_session_data_dir(session_id: &str) -> Result<std::path::PathBuf, String> {
    let dir = get_data_dir()?.join("sessions").join(session_id);
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create session data dir: {}", e))?;
    }
    Ok(dir)
}

pub(crate) fn open_path(path: &std::path::Path) -> Result<(), String> {
    open::that_detached(path).map_err(|e| format!("Failed to open {}: {}", path.display(), e))
}

pub(crate) fn reveal_path(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .arg("/select,")
            .arg(path)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("Failed to reveal {}: {}", path.display(), e))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to reveal {}: {}", path.display(), e))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target = path.parent().unwrap_or(path);
        return open_path(target);
    }
}

fn session_dir_started_at(path: &std::path::Path) -> Option<std::time::SystemTime> {
    let content = std::fs::read_to_string(path.join("manifest.json")).ok()?;
    let val = serde_json::from_str::<serde_json::Value>(&content).ok()?;
    let started = val["startedAt"].as_str()?;
    chrono::DateTime::parse_from_rfc3339(started)
        .ok()
        .map(Into::into)
}

fn session_dir_age_time(path: &std::path::Path) -> Option<std::time::SystemTime> {
    session_dir_started_at(path).or_else(|| path.metadata().and_then(|m| m.modified()).ok())
}

/// Return the absolute path to a session's data directory.
#[tauri::command]
pub fn get_session_data_path(session_id: String) -> Result<String, String> {
    let dir = get_session_data_dir(&session_id)?;
    Ok(dir.to_string_lossy().to_string())
}

/// Append pre-serialized JSONL lines to the session's tap log file.
/// Returns the current file size in bytes (for frontend rotation decisions).
#[tauri::command]
pub fn append_tap_data(session_id: String, lines: String) -> Result<u64, String> {
    let path = get_session_data_dir(&session_id)?.join("taps.jsonl");
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open tap file: {}", e))?;
    file.write_all(lines.as_bytes())
        .map_err(|e| format!("Failed to write tap data: {}", e))?;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(meta.len())
}

/// Open the tap log file in the system's default editor/viewer.
#[tauri::command]
pub fn open_tap_log(session_id: String) -> Result<(), String> {
    let path = get_session_data_dir(&session_id)?.join("taps.jsonl");
    if !path.exists() {
        return Err("No tap log exists for this session".into());
    }
    reveal_path(&path)
}

/// Open a session's data directory in the system file manager.
#[tauri::command]
pub fn open_session_data_dir(session_id: String) -> Result<(), String> {
    let dir = get_session_data_dir(&session_id)?;
    open_path(&dir)
}

/// Delete session data directories older than max_age_hours.
/// Uses manifest.json startedAt if available, falls back to directory mtime.
/// Returns count of session directories removed.
#[tauri::command]
pub fn cleanup_session_data(max_age_hours: u64) -> Result<u32, String> {
    let sessions_dir = get_data_dir()?.join("sessions");
    if !sessions_dir.exists() {
        return Ok(0);
    }
    let mut removed = 0u32;
    let cutoff =
        std::time::SystemTime::now() - std::time::Duration::from_secs(max_age_hours * 3600);
    if let Ok(entries) = std::fs::read_dir(&sessions_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let is_old = session_dir_age_time(&path)
                .map(|started_or_modified| started_or_modified < cutoff)
                .unwrap_or(false);
            if is_old {
                let _ = std::fs::remove_dir_all(&path);
                removed += 1;
            }
        }
    }
    Ok(removed)
}

/// Migrate legacy flat tap/traffic files into per-session directories.
/// Idempotent — skips sessions where the destination already exists.
/// Returns count of files migrated.
#[tauri::command]
pub fn migrate_legacy_data() -> Result<u32, String> {
    let data_dir = get_data_dir()?;
    let mut migrated = 0u32;

    // Migrate data/taps/{sid}.jsonl -> data/sessions/{sid}/taps.jsonl
    let taps_dir = data_dir.join("taps");
    if taps_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&taps_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                if let Some(sid) = path.file_stem().and_then(|s| s.to_str()) {
                    let dest_dir = data_dir.join("sessions").join(sid);
                    let dest_file = dest_dir.join("taps.jsonl");
                    if !dest_file.exists() {
                        let _ = std::fs::create_dir_all(&dest_dir);
                        if std::fs::rename(&path, &dest_file).is_ok() {
                            migrated += 1;
                        }
                    }
                }
            }
        }
        // Clean up empty taps directory
        let _ = std::fs::remove_dir(&taps_dir);
    }

    // Migrate data/traffic/{sid}.jsonl -> data/sessions/{sid}/traffic.jsonl
    let traffic_dir = data_dir.join("traffic");
    if traffic_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&traffic_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                if let Some(sid) = path.file_stem().and_then(|s| s.to_str()) {
                    let dest_dir = data_dir.join("sessions").join(sid);
                    let dest_file = dest_dir.join("traffic.jsonl");
                    if !dest_file.exists() {
                        let _ = std::fs::create_dir_all(&dest_dir);
                        if std::fs::rename(&path, &dest_file).is_ok() {
                            migrated += 1;
                        }
                    }
                }
            }
        }
        // Clean up empty traffic directory
        let _ = std::fs::remove_dir(&traffic_dir);
    }

    Ok(migrated)
}

// [RC-06] Scan ~/.claude/projects/ for resumable sessions (head+tail pass, chain detection)
/// Scan ~/.claude/projects/ for past Claude conversation files.
/// Returns a list of { id, path, directory, lastModified, sizeBytes } entries.
/// Async to avoid blocking the WebView event loop on large project directories.
#[tauri::command]
pub async fn list_past_sessions() -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(list_past_sessions_sync)
        .await
        .map_err(|e| e.to_string())?
}

struct PastSessionRawEntry {
    modified: std::time::SystemTime,
    session_id: String,
    source_tool_uuid: Option<String>,
    json: serde_json::Value,
}

fn format_modified_utc(modified: std::time::SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(modified)
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
}

fn project_name_from_directory(directory: &str, fallback: &str) -> String {
    directory
        .replace('\\', "/")
        .split('/')
        .filter(|s| !s.is_empty())
        .last()
        .unwrap_or(fallback)
        .to_string()
}

fn scan_claude_session(
    fpath: &std::path::Path,
    metadata: &std::fs::Metadata,
    project_name: &str,
    decoded_dir: &str,
    uuid_to_session: &mut HashMap<String, String>,
) -> Option<PastSessionRawEntry> {
    let modified = metadata.modified().unwrap_or(std::time::UNIX_EPOCH);
    let size_bytes = metadata.len();
    let session_id = fpath.file_stem()?.to_str()?.to_string();
    if session_id.is_empty() {
        return None;
    }

    let mut first_msg = String::new();
    let mut source_tool_uuid: Option<String> = None;
    let file_handle = std::fs::File::open(fpath).ok()?;
    use std::io::{BufRead, Read, Seek, SeekFrom};
    let mut reader = std::io::BufReader::new(file_handle);
    let mut line = String::new();

    for _ in 0..30 {
        line.clear();
        let bytes = match reader.read_line(&mut line) {
            Ok(bytes) => bytes,
            Err(_) => break,
        };
        if bytes == 0 {
            break;
        }
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line.trim_end()) {
            if let Some(uuid) = parsed.get("uuid").and_then(|v| v.as_str()) {
                uuid_to_session.insert(uuid.to_string(), session_id.clone());
            }
            if source_tool_uuid.is_none() {
                if let Some(stid) = parsed
                    .get("sourceToolAssistantUUID")
                    .and_then(|v| v.as_str())
                {
                    if !stid.is_empty() {
                        source_tool_uuid = Some(stid.to_string());
                    }
                }
            }
            if first_msg.is_empty() && parsed["type"].as_str() == Some("user") {
                if let Some(text) = extract_user_text(&parsed) {
                    first_msg = text;
                }
            }
        }
        if !first_msg.is_empty() && source_tool_uuid.is_some() {
            break;
        }
    }

    let tail_offset = size_bytes.saturating_sub(256 * 1024);
    let _ = reader.seek(SeekFrom::Start(tail_offset));
    let mut tail_bytes = Vec::new();
    let _ = reader.read_to_end(&mut tail_bytes);
    let tail_buf = String::from_utf8_lossy(&tail_bytes);

    for line in tail_buf.lines() {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(uuid) = parsed.get("uuid").and_then(|v| v.as_str()) {
                uuid_to_session.insert(uuid.to_string(), session_id.clone());
            }
        }
    }

    let mut last_msg = String::new();
    let mut model = String::new();
    for line in tail_buf.lines().rev() {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) {
            if model.is_empty() && parsed["type"].as_str() == Some("assistant") {
                if let Some(m) = parsed["message"]["model"].as_str() {
                    if !m.is_empty() {
                        model = m.to_string();
                    }
                }
            }
            if last_msg.is_empty() && parsed["type"].as_str() == Some("user") {
                if let Some(text) = extract_user_text(&parsed) {
                    last_msg = text;
                }
            }
        }
        if !last_msg.is_empty() && !model.is_empty() {
            break;
        }
    }

    Some(PastSessionRawEntry {
        modified,
        session_id: session_id.clone(),
        source_tool_uuid,
        json: serde_json::json!({
            "id": session_id,
            "cli": "claude",
            "path": project_name,
            "directory": decoded_dir,
            "lastModified": format_modified_utc(modified),
            "sizeBytes": size_bytes,
            "firstMessage": first_msg,
            "lastMessage": last_msg,
            "parentId": serde_json::Value::Null,
            "model": model,
            "filePath": fpath.to_string_lossy().to_string(),
            "dirExists": std::path::Path::new(decoded_dir).is_dir(),
        }),
    })
}

fn codex_raw_entry(
    fpath: &std::path::Path,
    metadata: &std::fs::Metadata,
    summary: CodexRolloutSummary,
) -> PastSessionRawEntry {
    let modified = metadata.modified().unwrap_or(std::time::UNIX_EPOCH);
    let size_bytes = metadata.len();
    let directory = if summary.directory.is_empty() {
        ".".to_string()
    } else {
        summary.directory
    };
    let project_name = project_name_from_directory(&directory, "codex");
    let last_message = if summary.last_user_message.is_empty() {
        summary.last_assistant_message
    } else {
        summary.last_user_message
    };

    PastSessionRawEntry {
        modified,
        session_id: summary.session_id.clone(),
        source_tool_uuid: None,
        json: serde_json::json!({
            "id": summary.session_id,
            "cli": "codex",
            "path": project_name,
            "directory": directory,
            "lastModified": format_modified_utc(modified),
            "sizeBytes": size_bytes,
            "firstMessage": summary.first_message,
            "lastMessage": last_message,
            "parentId": serde_json::Value::Null,
            "model": summary.model,
            "filePath": fpath.to_string_lossy().to_string(),
            "dirExists": std::path::Path::new(&directory).is_dir(),
        }),
    }
}

fn resolve_session_chains(
    raw_entries: &mut [PastSessionRawEntry],
    uuid_to_session: &HashMap<String, String>,
) {
    let id_set: HashSet<String> = raw_entries.iter().map(|e| e.session_id.clone()).collect();
    for entry in raw_entries {
        if let Some(ref stid) = entry.source_tool_uuid {
            if let Some(parent_sid) = uuid_to_session.get(stid) {
                if parent_sid != &entry.session_id && id_set.contains(parent_sid) {
                    entry.json["parentId"] = serde_json::Value::String(parent_sid.clone());
                }
            }
        }
    }
}

// [RC-04] list_past_sessions_sync detects plan-mode forks by capturing sourceToolAssistantUUID during the head pass and resolving it during chain detection.
fn list_past_sessions_sync() -> Result<Vec<serde_json::Value>, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let projects_dir = home.join(".claude").join("projects");

    let mut raw_entries: Vec<PastSessionRawEntry> = Vec::new();
    let mut uuid_to_session: HashMap<String, String> = HashMap::new();

    if projects_dir.exists() {
        let entries = std::fs::read_dir(&projects_dir)
            .map_err(|e| format!("Failed to read projects dir: {}", e))?;

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let encoded_name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let decoded_dir = path_utils::resolve_project_dir(&encoded_name, &path);
            let project_name = project_name_from_directory(&decoded_dir, &encoded_name);
            let files = match std::fs::read_dir(&path) {
                Ok(f) => f,
                Err(_) => continue,
            };

            for file in files.flatten() {
                let fpath = file.path();
                if fpath.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let metadata = match std::fs::metadata(&fpath) {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if let Some(entry) = scan_claude_session(
                    &fpath,
                    &metadata,
                    &project_name,
                    &decoded_dir,
                    &mut uuid_to_session,
                ) {
                    raw_entries.push(entry);
                }
            }
        }
    }

    for fpath in collect_codex_rollout_files() {
        let metadata = match std::fs::metadata(&fpath) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let Some(summary) = summarize_codex_rollout(&fpath) else {
            continue;
        };
        raw_entries.push(codex_raw_entry(&fpath, &metadata, summary));
    }

    resolve_session_chains(&mut raw_entries, &uuid_to_session);
    raw_entries.sort_by(|a, b| b.modified.cmp(&a.modified));
    let entries: Vec<serde_json::Value> = raw_entries.into_iter().map(|e| e.json).collect();
    Ok(entries)
}

fn collect_content_text(
    content: &serde_json::Value,
    block_kinds: &[&str],
    joiner: &str,
) -> Option<String> {
    if let Some(text) = content.as_str() {
        if !text.is_empty() {
            return Some(text.to_string());
        }
    }

    let arr = content.as_array()?;
    let parts: Vec<&str> = arr
        .iter()
        .filter_map(|block| {
            let block_type = block["type"].as_str().unwrap_or("");
            if block_kinds.contains(&block_type) {
                block["text"].as_str()
            } else {
                None
            }
        })
        .filter(|text| !text.is_empty())
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(joiner))
    }
}

fn is_slash_command_payload(text: &str) -> bool {
    text.contains("<command-name>") || text.contains("<local-command-")
}

/// Extract user message text from a JSONL event, filtering out command metadata.
fn extract_user_text(parsed: &serde_json::Value) -> Option<String> {
    let text = collect_content_text(&parsed["message"]["content"], &["text"], "\n")?;
    if is_slash_command_payload(&text) {
        return None;
    }
    let preview = truncate_preview(&text, 150);
    if preview.is_empty() {
        None
    } else {
        Some(preview)
    }
}

/// Extract full message text from a JSONL event (user or assistant), for content search.
/// Unlike `extract_user_text`, this returns the complete text without truncation or filtering.
fn extract_message_text(parsed: &serde_json::Value) -> Option<String> {
    let msg_type = parsed["type"].as_str()?;
    if msg_type != "user" && msg_type != "assistant" {
        return None;
    }
    collect_content_text(&parsed["message"]["content"], &["text"], "\n")
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn push_search_matches(
    results: &mut Vec<serde_json::Value>,
    re: &regex::Regex,
    session_id: &str,
    message_index: usize,
    role: &str,
    text: &str,
    limit: usize,
) {
    for m in re.find_iter(text) {
        if results.len() >= limit {
            break;
        }

        let pos = m.start();
        let matched_text = m.as_str();

        // Build snippet centered on match
        let snippet_half = 150;
        let start = text.floor_char_boundary(pos.saturating_sub(snippet_half));
        let end = text.ceil_char_boundary((m.end() + snippet_half).min(text.len()));
        let mut snippet = String::new();
        if start > 0 {
            snippet.push_str("...");
        }
        snippet.push_str(&text[start..end]);
        if end < text.len() {
            snippet.push_str("...");
        }

        // Offsets are consumed by JavaScript, so report UTF-16 code units
        // rather than Rust byte offsets.
        let prefix_len = if start > 0 { 3 } else { 0 }; // "..." prefix
        let match_offset_in_snippet = utf16_len(&text[start..pos]) + prefix_len;
        let match_len = utf16_len(matched_text);

        results.push(serde_json::json!({
            "sessionId": session_id,
            "messageIndex": message_index,
            "role": role,
            "matchOffset": match_offset_in_snippet,
            "matchLength": match_len,
            "matchedText": matched_text,
            "snippet": snippet,
        }));
    }
}

fn codex_text_from_content(content: &serde_json::Value) -> Option<String> {
    collect_content_text(content, &["input_text", "output_text", "text"], "\n")
}

fn extract_codex_message_text(parsed: &serde_json::Value) -> Option<(String, String)> {
    if parsed["type"].as_str()? != "response_item" {
        return None;
    }
    let payload = &parsed["payload"];
    if payload["type"].as_str()? != "message" {
        return None;
    }
    let role = match payload["role"].as_str()? {
        "user" => "user",
        "assistant" => "assistant",
        _ => return None,
    };
    let text = codex_text_from_content(&payload["content"])?;
    Some((role.to_string(), text))
}

fn codex_rollout_path_for_session(app_session_id: &str) -> Option<std::path::PathBuf> {
    let dir = get_session_data_dir(app_session_id).ok()?;
    let sidecar = dir.join("codex-rollout-path.txt");
    if let Ok(raw) = std::fs::read_to_string(sidecar) {
        let path = std::path::PathBuf::from(raw.trim());
        if path.exists() {
            return Some(path);
        }
    }

    let file = std::fs::File::open(dir.join("observability.jsonl")).ok()?;
    use std::io::BufRead;
    let reader = std::io::BufReader::new(file);
    let mut last_path: Option<std::path::PathBuf> = None;

    for line in reader.lines().map_while(Result::ok) {
        let parsed = match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if parsed["event"].as_str() != Some("codex.rollout.attributed") {
            continue;
        }
        if let Some(path) = parsed["data"]["path"].as_str() {
            last_path = Some(std::path::PathBuf::from(path));
        }
    }

    let path = last_path?;
    if path.exists() { Some(path) } else { None }
}

fn search_codex_rollout_file(
    path: &std::path::Path,
    app_session_id: &str,
    re: &regex::Regex,
    results: &mut Vec<serde_json::Value>,
    limit: usize,
) {
    let metadata = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return,
    };
    if metadata.len() > MAX_CONTENT_SEARCH_FILE_SIZE {
        return;
    }

    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return,
    };

    use std::io::BufRead;
    let reader = std::io::BufReader::new(file);
    let mut message_index: usize = 0;

    for line in reader.lines() {
        if results.len() >= limit {
            break;
        }

        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let parsed = match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let (role, text) = match conversation_codec(SearchCli::Codex).extract_search_text(&parsed) {
            Some(t) => t,
            None => continue,
        };

        push_search_matches(
            results,
            re,
            app_session_id,
            message_index,
            role.as_str(),
            &text,
            limit,
        );
        message_index += 1;
    }
}

// [RC-17] Search session content: walks ~/.claude/projects/, skips >20MB,
// 50-result cap, and checks cancel_token between scan steps.
/// Search conversation content across all past sessions.
/// Returns up to 50 matches with a snippet centered on the match.
#[tauri::command]
pub async fn search_session_content(
    query: String,
    cancel_token: String,
) -> Result<Vec<serde_json::Value>, String> {
    let cancelled = begin_content_search(&cancel_token);
    let finish_token = cancel_token.clone();
    let result =
        tokio::task::spawn_blocking(move || search_session_content_sync(&query, &cancelled))
            .await
            .map_err(|e| e.to_string())
            .and_then(|inner| inner);
    finish_content_search(&finish_token);
    result
}

#[tauri::command]
pub fn cancel_session_content_search(cancel_token: String) {
    cancel_content_search(&cancel_token);
}

const MAX_CONTENT_SEARCH_FILE_SIZE: u64 = 20 * 1024 * 1024;
const MAX_CONTENT_SEARCH_RESULTS: usize = 50;

#[derive(Clone, Copy, PartialEq, Eq)]
enum SearchCli {
    Claude,
    Codex,
}

struct SearchFileEntry {
    path: std::path::PathBuf,
    session_id: String,
    modified: std::time::SystemTime,
    cli: SearchCli,
}

fn search_session_content_sync(
    query: &str,
    cancelled: &AtomicBool,
) -> Result<Vec<serde_json::Value>, String> {
    if content_search_cancelled(cancelled) {
        return Ok(Vec::new());
    }

    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let projects_dir = home.join(".claude").join("projects");

    let query_lower = query.to_lowercase();

    let mut files: Vec<SearchFileEntry> = Vec::new();

    if projects_dir.exists() {
        let project_dirs = std::fs::read_dir(&projects_dir)
            .map_err(|e| format!("Failed to read projects dir: {}", e))?;

        for entry in project_dirs.flatten() {
            if content_search_cancelled(cancelled) {
                return Ok(Vec::new());
            }

            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let dir_files = match std::fs::read_dir(&path) {
                Ok(f) => f,
                Err(_) => continue,
            };

            for file in dir_files.flatten() {
                if content_search_cancelled(cancelled) {
                    return Ok(Vec::new());
                }

                let fpath = file.path();
                if fpath.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }

                let metadata = match std::fs::metadata(&fpath) {
                    Ok(m) => m,
                    Err(_) => continue,
                };

                let size = metadata.len();
                if size > MAX_CONTENT_SEARCH_FILE_SIZE {
                    continue;
                }

                let session_id = fpath
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();

                if session_id.is_empty() {
                    continue;
                }

                files.push(SearchFileEntry {
                    path: fpath,
                    session_id,
                    modified: metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
                    cli: SearchCli::Claude,
                });
            }
        }
    }

    for fpath in collect_codex_rollout_files() {
        if content_search_cancelled(cancelled) {
            return Ok(Vec::new());
        }

        let metadata = match std::fs::metadata(&fpath) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if metadata.len() > MAX_CONTENT_SEARCH_FILE_SIZE {
            continue;
        }
        let session_id = codex_id_from_rollout_filename(&fpath)
            .or_else(|| summarize_codex_rollout(&fpath).map(|s| s.session_id))
            .unwrap_or_default();
        if session_id.is_empty() {
            continue;
        }
        files.push(SearchFileEntry {
            path: fpath,
            session_id,
            modified: metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
            cli: SearchCli::Codex,
        });
    }

    // Sort newest first — recent sessions are most relevant
    files.sort_by(|a, b| b.modified.cmp(&a.modified));

    let mut results: Vec<serde_json::Value> = Vec::new();

    for file_entry in &files {
        if content_search_cancelled(cancelled) {
            return Ok(Vec::new());
        }

        if results.len() >= MAX_CONTENT_SEARCH_RESULTS {
            break;
        }

        let file_handle = match std::fs::File::open(&file_entry.path) {
            Ok(f) => f,
            Err(_) => continue,
        };

        use std::io::BufRead;
        let reader = std::io::BufReader::new(file_handle);

        for line in reader.lines() {
            if content_search_cancelled(cancelled) {
                return Ok(Vec::new());
            }

            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };

            let parsed = match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let text = match conversation_codec(file_entry.cli).extract_search_text(&parsed) {
                Some((_, text)) => text,
                None => continue,
            };

            let text_lower = text.to_lowercase();
            if let Some(pos) = text_lower.find(&query_lower) {
                // Build 200-char snippet centered on match.
                // Byte offsets from text_lower.find() are valid for text too (lowercasing
                // preserves byte length for ASCII; for non-ASCII, floor/ceil_char_boundary
                // snaps to the nearest valid boundary in both strings).
                let snippet_half = 100;
                let start = pos.saturating_sub(snippet_half);
                let start = text.floor_char_boundary(start);
                let end = text
                    .ceil_char_boundary((pos + query_lower.len() + snippet_half).min(text.len()));
                let mut snippet = String::new();
                if start > 0 {
                    snippet.push_str("...");
                }
                snippet.push_str(&text[start..end]);
                if end < text.len() {
                    snippet.push_str("...");
                }

                results.push(serde_json::json!({
                    "sessionId": file_entry.session_id,
                    "snippet": snippet,
                }));
                break; // One match per session
            }
        }
    }

    Ok(results)
}

// Search specific session JSONL files with regex/case-sensitivity support.
// Returns multiple matches per session, up to `limit` total.
#[tauri::command]
pub async fn search_jsonl_files(
    sessions: Vec<serde_json::Value>,
    query: String,
    case_sensitive: bool,
    use_regex: bool,
    limit: usize,
) -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(move || {
        search_jsonl_files_sync(&sessions, &query, case_sensitive, use_regex, limit)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn search_jsonl_files_sync(
    sessions: &[serde_json::Value],
    query: &str,
    case_sensitive: bool,
    use_regex: bool,
    limit: usize,
) -> Result<Vec<serde_json::Value>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let re = if use_regex {
        if case_sensitive {
            regex::Regex::new(query)
        } else {
            regex::RegexBuilder::new(query)
                .case_insensitive(true)
                .build()
        }
        .map_err(|e| format!("Invalid regex: {}", e))?
    } else {
        let escaped = regex::escape(query);
        if case_sensitive {
            regex::Regex::new(&escaped)
        } else {
            regex::RegexBuilder::new(&escaped)
                .case_insensitive(true)
                .build()
        }
        .map_err(|e| format!("Regex build error: {}", e))?
    };

    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let projects_dir = home.join(".claude").join("projects");

    // Build working-dir -> encoded-dir-name mapping by walking projects dir
    let mut dir_map: std::collections::HashMap<String, std::path::PathBuf> =
        std::collections::HashMap::new();
    if projects_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&projects_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let encoded_name = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                let decoded = path_utils::resolve_project_dir(&encoded_name, &path);
                dir_map.insert(decoded, path);
            }
        }
    }

    let mut results: Vec<serde_json::Value> = Vec::new();

    for session in sessions {
        if results.len() >= limit {
            break;
        }

        let session_id = match session["sessionId"].as_str() {
            Some(s) => s,
            None => continue,
        };
        let app_session_id = session["appSessionId"].as_str().unwrap_or(session_id);
        let cli = session["cli"].as_str().unwrap_or("claude");
        let working_dir = match session["workingDir"].as_str() {
            Some(s) => s,
            None => continue,
        };

        if cli == "codex" {
            if let Some(path) = codex_rollout_path_for_session(app_session_id) {
                search_codex_rollout_file(&path, app_session_id, &re, &mut results, limit);
            }
            continue;
        }

        // Normalize working dir for lookup (forward slashes, lowercase on Windows)
        let normalized = working_dir.replace('\\', "/");
        let jsonl_path = dir_map
            .iter()
            .find(|(decoded, _)| {
                let d = decoded.replace('\\', "/");
                d.eq_ignore_ascii_case(&normalized)
            })
            .map(|(_, dir)| dir.join(format!("{}.jsonl", session_id)));

        let jsonl_path = match jsonl_path {
            Some(p) if p.exists() => p,
            _ => continue,
        };

        let metadata = match std::fs::metadata(&jsonl_path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if metadata.len() > MAX_CONTENT_SEARCH_FILE_SIZE {
            continue;
        }

        let file = match std::fs::File::open(&jsonl_path) {
            Ok(f) => f,
            Err(_) => continue,
        };

        use std::io::BufRead;
        let reader = std::io::BufReader::new(file);
        let mut message_index: usize = 0;

        for line in reader.lines() {
            if results.len() >= limit {
                break;
            }

            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };

            let parsed = match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let is_turn = matches!(parsed["type"].as_str(), Some("user" | "assistant"));
            let (role, text) =
                match conversation_codec(SearchCli::Claude).extract_search_text(&parsed) {
                    Some(t) => t,
                    None => {
                        if is_turn {
                            message_index += 1;
                        }
                        continue;
                    }
                };

            push_search_matches(
                &mut results,
                &re,
                session_id,
                message_index,
                role.as_str(),
                &text,
                limit,
            );

            message_index += 1;
        }
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::{
        codex_compaction_marker, codex_id_from_rollout_filename, codex_response_item_to_message,
        codex_tool_input, codex_user_event_text, extract_codex_message_text, extract_message_text,
        extract_user_text, push_search_matches, read_conversation_sync, session_dir_age_time,
        summarize_codex_rollout, truncate_preview,
    };
    use serde_json::json;
    use std::io::Write;

    #[test]
    fn extract_user_text_keeps_short_plain_messages() {
        let parsed = json!({
            "type": "user",
            "message": {
                "content": "Test"
            }
        });

        assert_eq!(extract_user_text(&parsed), Some("Test".to_string()));
    }

    #[test]
    fn extract_user_text_skips_command_payloads() {
        let parsed = json!({
            "type": "user",
            "message": {
                "content": "<command-name>/model</command-name><local-command-stdout>ok</local-command-stdout>"
            }
        });

        assert_eq!(extract_user_text(&parsed), None);
    }

    #[test]
    fn extract_user_text_keeps_literal_command_words() {
        let parsed = json!({
            "type": "user",
            "message": {
                "content": "Please explain the words command-name and local-command."
            }
        });

        assert_eq!(
            extract_user_text(&parsed),
            Some("Please explain the words command-name and local-command.".to_string())
        );
    }

    #[test]
    fn extract_message_text_joins_blocks_with_newlines() {
        let parsed = json!({
            "type": "assistant",
            "message": {
                "content": [
                    { "type": "text", "text": "first" },
                    { "type": "text", "text": "second" }
                ]
            }
        });

        assert_eq!(
            extract_message_text(&parsed),
            Some("first\nsecond".to_string())
        );
    }

    #[test]
    fn truncate_preview_normalizes_without_full_join() {
        assert_eq!(
            truncate_preview("  alpha \n beta   gamma", 12),
            "alpha beta g"
        );
        assert_eq!(truncate_preview("alpha beta", 0), "");
    }

    #[test]
    fn invalid_manifest_age_falls_back_to_dir_mtime() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("manifest.json"), "{not json").unwrap();

        assert!(session_dir_age_time(dir.path()).is_some());
    }

    #[test]
    fn codex_rollout_filename_rejects_non_uuid_suffix() {
        let path = std::path::Path::new(
            "rollout-2026-04-26T10-52-05-019dc7b3-8995-7ec1-b5f8-b8962086a50z.jsonl",
        );

        assert_eq!(codex_id_from_rollout_filename(path), None);
    }

    #[test]
    fn search_match_offsets_are_utf16_for_frontend() {
        let re = regex::Regex::new("useless").unwrap();
        let mut results = Vec::new();
        push_search_matches(
            &mut results,
            &re,
            "session-1",
            0,
            "user",
            "🙂 useless tail",
            10,
        );

        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["matchOffset"], 3);
        assert_eq!(results[0]["matchLength"], 7);
        assert_eq!(results[0]["matchedText"], "useless");
    }

    #[test]
    fn extract_codex_message_text_reads_response_messages() {
        let parsed = json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [
                    { "type": "output_text", "text": "Codex answer" }
                ]
            }
        });

        assert_eq!(
            extract_codex_message_text(&parsed),
            Some(("assistant".to_string(), "Codex answer".to_string()))
        );
    }

    #[test]
    fn codex_user_event_text_reads_user_message_events() {
        let parsed = json!({
            "type": "event_msg",
            "payload": {
                "type": "user_message",
                "message": "Resume picker support"
            }
        });

        assert_eq!(
            codex_user_event_text(&parsed),
            Some("Resume picker support".to_string())
        );
    }

    #[test]
    fn codex_rollout_summary_extracts_resume_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join("rollout-2026-04-26T10-52-05-019dc7b3-8995-7ec1-b5f8-b8962086a506.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "timestamp": "2026-04-26T02:52:25.239Z",
                "type": "session_meta",
                "payload": {
                    "id": "019dc7b3-8995-7ec1-b5f8-b8962086a506",
                    "cwd": "/workspace/project"
                }
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "turn_context",
                "payload": {
                    "cwd": "/workspace/project",
                    "model": "gpt-5.1-codex",
                    "effort": "high"
                }
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "event_msg",
                "payload": {
                    "type": "user_message",
                    "message": "Add Codex resume support"
                }
            })
        )
        .unwrap();

        let summary = summarize_codex_rollout(&path).unwrap();
        assert_eq!(summary.session_id, "019dc7b3-8995-7ec1-b5f8-b8962086a506");
        assert_eq!(summary.directory, "/workspace/project");
        assert_eq!(summary.model, "gpt-5.1-codex");
        assert_eq!(summary.first_message, "Add Codex resume support");
        assert_eq!(
            codex_id_from_rollout_filename(&path).as_deref(),
            Some("019dc7b3-8995-7ec1-b5f8-b8962086a506")
        );
    }

    #[test]
    fn read_conversation_sync_reads_codex_response_items() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout-test.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "Codex question" }]
                }
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "Codex answer" }]
                }
            })
        )
        .unwrap();

        let messages = read_conversation_sync(path.to_str().unwrap()).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["content"][0]["text"], "Codex question");
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["content"][0]["text"], "Codex answer");
    }

    #[test]
    fn read_conversation_sync_reads_claude_messages_and_tool_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("claude.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "user",
                "message": { "content": "Claude question" }
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "assistant",
                "message": {
                    "content": [
                        { "type": "text", "text": "Claude answer" },
                        { "type": "tool_use", "id": "toolu_1", "name": "Bash", "input": { "command": "pwd" } }
                    ]
                }
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "user",
                "message": {
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_1",
                            "content": [{ "type": "text", "text": "/workspace" }]
                        }
                    ]
                }
            })
        )
        .unwrap();

        let messages = read_conversation_sync(path.to_str().unwrap()).unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["content"][0]["text"], "Claude question");
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["content"][0]["text"], "Claude answer");
        assert_eq!(messages[1]["content"][1]["type"], "tool_use");
        assert_eq!(messages[1]["content"][1]["id"], "toolu_1");
        assert_eq!(messages[1]["content"][1]["input"]["command"], "pwd");
        assert_eq!(messages[2]["content"][0]["type"], "tool_result");
        assert_eq!(messages[2]["content"][0]["toolUseId"], "toolu_1");
        assert_eq!(messages[2]["content"][0]["text"], "/workspace");
    }

    #[test]
    fn read_conversation_sync_reads_codex_function_calls() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout-fc.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"pwd\"}",
                    "call_id": "call_123"
                }
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "response_item",
                "payload": {
                    "type": "function_call_output",
                    "call_id": "call_123",
                    "output": "/home/jordan"
                }
            })
        )
        .unwrap();

        let messages = read_conversation_sync(path.to_str().unwrap()).unwrap();
        assert_eq!(messages.len(), 2);

        // function_call -> assistant message with tool_use block
        assert_eq!(messages[0]["role"], "assistant");
        let tool_use = &messages[0]["content"][0];
        assert_eq!(tool_use["type"], "tool_use");
        assert_eq!(tool_use["name"], "exec_command");
        assert_eq!(tool_use["id"], "call_123");
        assert_eq!(tool_use["input"]["cmd"], "pwd");

        // function_call_output -> user message with tool_result block
        assert_eq!(messages[1]["role"], "user");
        let tool_result = &messages[1]["content"][0];
        assert_eq!(tool_result["type"], "tool_result");
        assert_eq!(tool_result["toolUseId"], "call_123");
        assert_eq!(tool_result["text"], "/home/jordan");
    }

    #[test]
    fn read_conversation_sync_reads_codex_custom_tool_calls() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout-ct.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        // apply_patch sends a raw, non-JSON patch as the arguments string.
        writeln!(
            file,
            "{}",
            json!({
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call",
                    "name": "apply_patch",
                    "arguments": "*** Begin Patch\n*** End Patch",
                    "call_id": "call_xyz"
                }
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call_output",
                    "call_id": "call_xyz",
                    "output": "Patch applied"
                }
            })
        )
        .unwrap();

        let messages = read_conversation_sync(path.to_str().unwrap()).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["content"][0]["type"], "tool_use");
        assert_eq!(messages[0]["content"][0]["name"], "apply_patch");
        // Raw (non-JSON) patch is preserved as a string input
        assert_eq!(
            messages[0]["content"][0]["input"],
            "*** Begin Patch\n*** End Patch"
        );
        assert_eq!(messages[1]["content"][0]["type"], "tool_result");
        assert_eq!(messages[1]["content"][0]["text"], "Patch applied");
    }

    #[test]
    fn read_conversation_sync_reads_codex_reasoning_as_chip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout-r.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "response_item",
                "payload": {
                    "type": "reasoning",
                    "summary": [],
                    "encrypted_content": "gAAAAA..."
                }
            })
        )
        .unwrap();

        let messages = read_conversation_sync(path.to_str().unwrap()).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["role"], "assistant");
        assert_eq!(messages[0]["content"][0]["type"], "reasoning");
        // Empty summary is omitted
        assert!(messages[0]["content"][0].get("summary").is_none());
        // No plaintext is exposed
        assert!(messages[0]["content"][0].get("text").is_none());
        assert!(messages[0]["content"][0].get("encrypted_content").is_none());
    }

    #[test]
    fn read_conversation_sync_reads_codex_compaction_marker() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout-c.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "before compact" }]
                }
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "timestamp": "2026-04-26T12:00:00Z",
                "type": "compacted",
                "payload": {
                    "message": "Summary of prior turns."
                }
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "after compact" }]
                }
            })
        )
        .unwrap();

        let messages = read_conversation_sync(path.to_str().unwrap()).unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["content"][0]["text"], "before compact");
        assert_eq!(messages[1]["role"], "system");
        assert_eq!(messages[1]["content"][0]["type"], "compaction_summary");
        assert_eq!(messages[1]["content"][0]["text"], "Summary of prior turns.");
        assert_eq!(messages[2]["content"][0]["text"], "after compact");
    }

    #[test]
    fn codex_tool_input_truncates_large_arguments() {
        let big = "A".repeat(5000);
        let arg = serde_json::Value::String(big);
        let result = codex_tool_input(&arg);
        let s = result.as_str().expect("truncated to string");
        assert!(s.ends_with("..."));
        assert!(s.len() <= 2000 + 3);
        assert!(s.starts_with("\"AAA"));
    }

    #[test]
    fn codex_response_item_to_message_skips_unknown_types() {
        let payload = json!({ "type": "local_shell_call", "name": "shell", "call_id": "c1" });
        assert!(codex_response_item_to_message(&payload).is_none());

        let no_type = json!({});
        assert!(codex_response_item_to_message(&no_type).is_none());
    }

    #[test]
    fn codex_compaction_marker_skips_empty_summary() {
        assert!(codex_compaction_marker(&json!({})).is_none());
        assert!(codex_compaction_marker(&json!({ "message": "   " })).is_none());
        let m = codex_compaction_marker(&json!({ "message": "Compacted." }));
        assert!(m.is_some());
        assert_eq!(m.unwrap()["content"][0]["text"], "Compacted.");
    }
}

#[tauri::command]
pub fn shell_open(path: String) -> Result<(), String> {
    if path.starts_with("http://")
        || path.starts_with("https://")
        || path.starts_with("ws://")
        || path.starts_with("wss://")
    {
        open::that_detached(&path).map_err(|e| format!("shell_open failed for {path}: {e}"))
    } else {
        open_path(std::path::Path::new(&path))
            .map_err(|e| format!("shell_open failed for {path}: {e}"))
    }
}

/// [RC-22] Open path in system file manager (Explorer /select on Windows, open -R on macOS, xdg-open on Linux)
#[tauri::command]
pub fn reveal_in_file_manager(path: String) -> Result<(), String> {
    reveal_path(std::path::Path::new(&path))
}

/// [SL-19] [SL-20] Check whether a path exists and is a directory.
#[tauri::command]
pub fn dir_exists(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

const MAX_CONVERSATION_FILE_SIZE: u64 = 20 * 1024 * 1024;
const MAX_CONVERSATION_MESSAGES: usize = 2000;
const MAX_BLOCK_TEXT: usize = 2000;

/// Truncate a string at a UTF-8 char boundary, appending "..." when shortened.
fn truncate_block_text(s: &str) -> String {
    if s.len() > MAX_BLOCK_TEXT {
        let end = s.floor_char_boundary(MAX_BLOCK_TEXT);
        format!("{}...", &s[..end])
    } else {
        s.to_string()
    }
}

/// Codex tool arguments are JSON-encoded strings on the wire. Parse if possible;
/// fall back to a raw string (e.g. `apply_patch` carries a non-JSON patch).
/// Always returns a value whose stringified form is <= MAX_BLOCK_TEXT chars.
fn codex_tool_input(arguments: &serde_json::Value) -> serde_json::Value {
    let parsed = if let Some(s) = arguments.as_str() {
        serde_json::from_str::<serde_json::Value>(s)
            .unwrap_or(serde_json::Value::String(s.to_string()))
    } else if arguments.is_null() {
        return serde_json::Value::Null;
    } else {
        arguments.clone()
    };
    let serialized = serde_json::to_string(&parsed).unwrap_or_default();
    if serialized.len() > MAX_BLOCK_TEXT {
        let end = serialized.floor_char_boundary(MAX_BLOCK_TEXT);
        serde_json::Value::String(format!("{}...", &serialized[..end]))
    } else {
        parsed
    }
}

/// Map a Codex `response_item` payload to a CapturedMessage-shaped JSON value.
/// Returns `None` for unknown / non-turn payloads.
fn codex_response_item_to_message(payload: &serde_json::Value) -> Option<serde_json::Value> {
    let payload_type = payload["type"].as_str()?;
    match payload_type {
        "message" => {
            let role = match payload["role"].as_str()? {
                "user" => "user",
                "assistant" => "assistant",
                _ => return None,
            };
            let text = codex_text_from_content(&payload["content"])?;
            Some(serde_json::json!({
                "role": role,
                "content": [{ "type": "text", "text": text }],
            }))
        }
        "function_call" | "custom_tool_call" => {
            let name = payload["name"].as_str().unwrap_or("unknown");
            let call_id = payload["call_id"].as_str().unwrap_or("");
            let raw_args = payload
                .get("arguments")
                .or_else(|| payload.get("input"))
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let mut block = serde_json::json!({
                "type": "tool_use",
                "name": name,
                "input": codex_tool_input(&raw_args),
            });
            if !call_id.is_empty() {
                block["id"] = serde_json::Value::String(call_id.to_string());
            }
            Some(serde_json::json!({
                "role": "assistant",
                "content": [block],
            }))
        }
        "function_call_output" | "custom_tool_call_output" => {
            let call_id = payload["call_id"].as_str().unwrap_or("");
            let output = payload["output"]
                .as_str()
                .map(str::to_string)
                .or_else(|| {
                    payload["output"]
                        .get("content")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_default();
            let mut block = serde_json::json!({ "type": "tool_result" });
            if !call_id.is_empty() {
                block["toolUseId"] = serde_json::Value::String(call_id.to_string());
            }
            if !output.is_empty() {
                block["text"] = serde_json::Value::String(truncate_block_text(&output));
            }
            Some(serde_json::json!({
                "role": "user",
                "content": [block],
            }))
        }
        "reasoning" => {
            let summary: Vec<&str> = payload["summary"]
                .as_array()
                .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect())
                .unwrap_or_default();
            let mut block = serde_json::json!({ "type": "reasoning" });
            if !summary.is_empty() {
                block["summary"] = serde_json::json!(summary);
            }
            Some(serde_json::json!({
                "role": "assistant",
                "content": [block],
            }))
        }
        _ => None,
    }
}

/// Map a Codex `compacted` rollout line to a CapturedMessage sentinel that the
/// frontend projection turns into a divider entry.
fn codex_compaction_marker(payload: &serde_json::Value) -> Option<serde_json::Value> {
    let summary = payload["message"].as_str()?.trim();
    if summary.is_empty() {
        return None;
    }
    Some(serde_json::json!({
        "role": "system",
        "content": [{ "type": "compaction_summary", "text": summary }],
    }))
}

enum CodecLine {
    Message(serde_json::Value),
    Skip,
    NotMine,
}

trait ConversationCodec {
    fn parse_turn(&self, line: &serde_json::Value) -> CodecLine;
    fn extract_search_text(&self, line: &serde_json::Value) -> Option<(String, String)>;
}

struct ClaudeCodec;
struct CodexCodec;

fn claude_line_to_message(parsed: &serde_json::Value) -> Option<serde_json::Value> {
    let msg_type = match parsed["type"].as_str()? {
        "user" => "user",
        "assistant" => "assistant",
        _ => return None,
    };

    let content = &parsed["message"]["content"];
    let content_blocks = if let Some(text) = content.as_str() {
        serde_json::json!([{ "type": "text", "text": text }])
    } else if let Some(arr) = content.as_array() {
        serde_json::Value::Array(
            arr.iter()
                .map(|block| {
                    let block_type = block["type"].as_str().unwrap_or("text");
                    match block_type {
                        "text" => serde_json::json!({
                            "type": "text",
                            "text": block["text"].as_str().unwrap_or("")
                        }),
                        "tool_use" => {
                            let mut obj = serde_json::json!({
                                "type": "tool_use",
                                "name": block["name"].as_str().unwrap_or("unknown"),
                            });
                            if let Some(id) = block["id"].as_str() {
                                obj["id"] = serde_json::Value::String(id.to_string());
                            }
                            if let Some(input) = block.get("input") {
                                obj["input"] = codex_tool_input(input);
                            }
                            obj
                        }
                        "tool_result" => {
                            let mut obj = serde_json::json!({ "type": "tool_result" });
                            if let Some(id) = block["tool_use_id"].as_str() {
                                obj["toolUseId"] = serde_json::Value::String(id.to_string());
                            }
                            if let Some(err) = block["is_error"].as_bool() {
                                obj["isError"] = serde_json::Value::Bool(err);
                            }
                            if let Some(text) = block["content"].as_str() {
                                obj["text"] = serde_json::Value::String(truncate_block_text(text));
                            } else if let Some(arr) = block["content"].as_array() {
                                let parts: Vec<&str> = arr
                                    .iter()
                                    .filter(|b| b["type"].as_str() == Some("text"))
                                    .filter_map(|b| b["text"].as_str())
                                    .collect();
                                if !parts.is_empty() {
                                    obj["text"] = serde_json::Value::String(truncate_block_text(
                                        &parts.join("\n"),
                                    ));
                                }
                            }
                            obj
                        }
                        _ => serde_json::json!({ "type": block_type }),
                    }
                })
                .collect(),
        )
    } else {
        return None;
    };

    Some(serde_json::json!({
        "role": msg_type,
        "content": content_blocks,
    }))
}

impl ConversationCodec for ClaudeCodec {
    fn parse_turn(&self, line: &serde_json::Value) -> CodecLine {
        match claude_line_to_message(line) {
            Some(message) => CodecLine::Message(message),
            None => CodecLine::NotMine,
        }
    }

    fn extract_search_text(&self, line: &serde_json::Value) -> Option<(String, String)> {
        let role = match line["type"].as_str()? {
            "user" => "user",
            "assistant" => "assistant",
            _ => return None,
        };
        extract_message_text(line).map(|text| (role.to_string(), text))
    }
}

impl ConversationCodec for CodexCodec {
    fn parse_turn(&self, line: &serde_json::Value) -> CodecLine {
        match line["type"].as_str() {
            Some("response_item") => codex_response_item_to_message(&line["payload"])
                .map(CodecLine::Message)
                .unwrap_or(CodecLine::Skip),
            Some("compacted") => codex_compaction_marker(&line["payload"])
                .map(CodecLine::Message)
                .unwrap_or(CodecLine::Skip),
            Some("session_meta") | Some("turn_context") | Some("event_msg") => CodecLine::Skip,
            _ => CodecLine::NotMine,
        }
    }

    fn extract_search_text(&self, line: &serde_json::Value) -> Option<(String, String)> {
        if let Some(text) = codex_user_event_text(line) {
            return Some(("user".to_string(), text));
        }
        extract_codex_message_text(line)
    }
}

fn conversation_codec(cli: SearchCli) -> &'static dyn ConversationCodec {
    static CLAUDE_CODEC: ClaudeCodec = ClaudeCodec;
    static CODEX_CODEC: CodexCodec = CodexCodec;
    match cli {
        SearchCli::Claude => &CLAUDE_CODEC,
        SearchCli::Codex => &CODEX_CODEC,
    }
}

fn push_conversation_message(
    messages: &mut Vec<serde_json::Value>,
    message: serde_json::Value,
) -> bool {
    messages.push(message);
    messages.len() >= MAX_CONVERSATION_MESSAGES
}

/// Read a conversation JSONL file and return structured messages as CapturedMessage[].
#[tauri::command]
pub async fn read_conversation(file_path: String) -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(move || read_conversation_sync(&file_path))
        .await
        .map_err(|e| e.to_string())?
}

/// [RC-25] Read the live Codex rollout for a code-tabs session and return its
/// turns as CapturedMessage[]. Used by the Context modal during a running
/// session where the rollout file path is not visible to the frontend.
#[tauri::command]
pub async fn read_codex_session_messages(
    session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(move || {
        let path = codex_rollout_path_for_session(&session_id)
            .ok_or_else(|| format!("No rollout file attributed to session {session_id}"))?;
        let s = path
            .to_str()
            .ok_or_else(|| "Rollout path is not valid UTF-8".to_string())?;
        read_conversation_sync(s)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn read_conversation_sync(file_path: &str) -> Result<Vec<serde_json::Value>, String> {
    let path = std::path::Path::new(file_path);
    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
    }

    let metadata =
        std::fs::metadata(path).map_err(|e| format!("Cannot read file metadata: {}", e))?;
    if metadata.len() > MAX_CONVERSATION_FILE_SIZE {
        return Err(format!(
            "File too large ({:.1} MB, max {} MB)",
            metadata.len() as f64 / (1024.0 * 1024.0),
            MAX_CONVERSATION_FILE_SIZE / (1024 * 1024)
        ));
    }

    let file = std::fs::File::open(path).map_err(|e| format!("Cannot open file: {}", e))?;

    use std::io::BufRead;
    let reader = std::io::BufReader::new(file);
    let mut messages: Vec<serde_json::Value> = Vec::new();
    let codex = CodexCodec;
    let claude = ClaudeCodec;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let parsed: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        match codex.parse_turn(&parsed) {
            CodecLine::Message(message) => {
                if push_conversation_message(&mut messages, message) {
                    break;
                }
                continue;
            }
            CodecLine::Skip => continue,
            CodecLine::NotMine => {}
        }

        if let CodecLine::Message(message) = claude.parse_turn(&parsed) {
            if push_conversation_message(&mut messages, message) {
                break;
            }
        }
    }

    Ok(messages)
}

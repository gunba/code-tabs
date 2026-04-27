use crate::path_utils;

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
    if stem.len() >= 36 {
        let candidate = &stem[stem.len() - 36..];
        if candidate.chars().filter(|c| *c == '-').count() == 4 {
            return Some(candidate.to_string());
        }
    }
    None
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
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(limit)
        .collect()
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
            // Try manifest.json startedAt, fall back to dir mtime
            let is_old = {
                let manifest_path = path.join("manifest.json");
                if manifest_path.exists() {
                    if let Ok(content) = std::fs::read_to_string(&manifest_path) {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                            if let Some(started) = val["startedAt"].as_str() {
                                // Parse ISO timestamp and compare
                                chrono::DateTime::parse_from_rfc3339(started)
                                    .map(|dt| {
                                        let sys: std::time::SystemTime = dt.into();
                                        sys < cutoff
                                    })
                                    .unwrap_or(false)
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                } else {
                    // No manifest — use directory mtime
                    path.metadata()
                        .and_then(|m| m.modified())
                        .map(|t| t < cutoff)
                        .unwrap_or(false)
                }
            };
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

// [RC-04] list_past_sessions_sync detects plan-mode forks by capturing sourceToolAssistantUUID during the head pass and resolving it during chain detection.
fn list_past_sessions_sync() -> Result<Vec<serde_json::Value>, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let projects_dir = home.join(".claude").join("projects");

    if !projects_dir.exists() {
        return Ok(Vec::new());
    }

    // Collect raw entries with their first-event sessionId for chain detection
    struct RawEntry {
        modified: std::time::SystemTime,
        session_id: String,
        source_tool_uuid: Option<String>,
        json: serde_json::Value,
    }

    let mut raw_entries: Vec<RawEntry> = Vec::new();
    // Global map: message UUID → session_id (for resolving chain parents)
    let mut uuid_to_session: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    // Walk project dirs
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

        // Resolve the real directory path: reads cwd from JSONL files first,
        // falls back to filesystem-probing heuristic for legacy/empty dirs.
        let decoded_dir = path_utils::resolve_project_dir(&encoded_name, &path);

        // Get the last segment as a short project name
        let project_name = decoded_dir
            .replace('\\', "/")
            .split('/')
            .filter(|s| !s.is_empty())
            .last()
            .unwrap_or(&encoded_name)
            .to_string();

        // Look for .jsonl conversation files in each project dir
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

            let modified = metadata.modified().unwrap_or(std::time::UNIX_EPOCH);
            let size_bytes = metadata.len();

            // Extract session ID from filename (strip .jsonl)
            let session_id = fpath
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();

            if session_id.is_empty() {
                continue;
            }

            let last_modified = chrono::DateTime::<chrono::Utc>::from(modified)
                .format("%Y-%m-%dT%H:%M:%SZ")
                .to_string();

            // --- Head pass: BufReader, first 30 lines → firstMessage + sourceToolAssistantUUID ---
            let mut first_msg = String::new();
            let mut source_tool_uuid: Option<String> = None;
            if let Ok(file_handle) = std::fs::File::open(&fpath) {
                use std::io::BufRead;
                let reader = std::io::BufReader::new(file_handle);
                for line in reader.lines().take(30).flatten() {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
                        // Collect message UUIDs for chain resolution
                        if let Some(uuid) = parsed.get("uuid").and_then(|v| v.as_str()) {
                            uuid_to_session.insert(uuid.to_string(), session_id.clone());
                        }
                        // Capture sourceToolAssistantUUID (plan-mode fork link)
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
                        // Extract first user message
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
            }

            // --- Tail pass: seek to last 256KB, reverse scan → lastMessage + model ---
            let mut last_msg = String::new();
            let mut model = String::new();
            if let Ok(file_handle) = std::fs::File::open(&fpath) {
                use std::io::{Read, Seek, SeekFrom};
                let mut reader = std::io::BufReader::new(file_handle);
                let tail_offset = size_bytes.saturating_sub(256 * 1024);
                let _ = reader.seek(SeekFrom::Start(tail_offset));
                let mut tail_bytes = Vec::new();
                let _ = reader.read_to_end(&mut tail_bytes);
                let tail_buf = String::from_utf8_lossy(&tail_bytes);
                // Forward pass through tail: collect UUIDs for chain resolution
                for line in tail_buf.lines() {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) {
                        if let Some(uuid) = parsed.get("uuid").and_then(|v| v.as_str()) {
                            uuid_to_session.insert(uuid.to_string(), session_id.clone());
                        }
                    }
                }
                // Reverse scan lines for last user message and model
                for line in tail_buf.lines().rev() {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) {
                        // Capture model from last assistant message
                        if model.is_empty() && parsed["type"].as_str() == Some("assistant") {
                            if let Some(m) = parsed["message"]["model"].as_str() {
                                if !m.is_empty() {
                                    model = m.to_string();
                                }
                            }
                        }
                        // Capture last user message
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
            }

            raw_entries.push(RawEntry {
                modified,
                session_id: session_id.clone(),
                source_tool_uuid,
                json: serde_json::json!({
                    "id": session_id,
                    "cli": "claude",
                    "path": project_name,
                    "directory": decoded_dir,
                    "lastModified": last_modified,
                    "sizeBytes": size_bytes,
                    "firstMessage": first_msg,
                    "lastMessage": last_msg,
                    "parentId": serde_json::Value::Null,
                    "model": model,
                    "filePath": fpath.to_string_lossy().to_string(),
                    "dirExists": std::path::Path::new(&decoded_dir).is_dir(),
                }),
            });
        }
    }

    for fpath in collect_codex_rollout_files() {
        let metadata = match std::fs::metadata(&fpath) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified = metadata.modified().unwrap_or(std::time::UNIX_EPOCH);
        let size_bytes = metadata.len();
        let Some(summary) = summarize_codex_rollout(&fpath) else {
            continue;
        };
        let directory = if summary.directory.is_empty() {
            ".".to_string()
        } else {
            summary.directory
        };
        let project_name = directory
            .replace('\\', "/")
            .split('/')
            .filter(|s| !s.is_empty())
            .last()
            .unwrap_or("codex")
            .to_string();
        let last_modified = chrono::DateTime::<chrono::Utc>::from(modified)
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string();
        let last_message = if summary.last_user_message.is_empty() {
            summary.last_assistant_message
        } else {
            summary.last_user_message
        };

        raw_entries.push(RawEntry {
            modified,
            session_id: summary.session_id.clone(),
            source_tool_uuid: None,
            json: serde_json::json!({
                "id": summary.session_id,
                "cli": "codex",
                "path": project_name,
                "directory": directory,
                "lastModified": last_modified,
                "sizeBytes": size_bytes,
                "firstMessage": summary.first_message,
                "lastMessage": last_message,
                "parentId": serde_json::Value::Null,
                "model": summary.model,
                "filePath": fpath.to_string_lossy().to_string(),
                "dirExists": std::path::Path::new(&directory).is_dir(),
            }),
        });
    }

    // --- Chain detection: resolve sourceToolAssistantUUID → parent session via UUID map ---
    let id_set: std::collections::HashSet<String> =
        raw_entries.iter().map(|e| e.session_id.clone()).collect();
    for entry in &mut raw_entries {
        if let Some(ref stid) = entry.source_tool_uuid {
            if let Some(parent_sid) = uuid_to_session.get(stid) {
                if parent_sid != &entry.session_id && id_set.contains(parent_sid) {
                    entry.json["parentId"] = serde_json::Value::String(parent_sid.clone());
                }
            }
        }
    }

    // Sort by most recent first — return all (frontend filters by directory)
    raw_entries.sort_by(|a, b| b.modified.cmp(&a.modified));
    let entries: Vec<serde_json::Value> = raw_entries.into_iter().map(|e| e.json).collect();
    Ok(entries)
}

/// Extract user message text from a JSONL event, filtering out commands.
fn extract_user_text(parsed: &serde_json::Value) -> Option<String> {
    let truncate = |s: &str| -> Option<String> {
        let normalized = s.split_whitespace().collect::<Vec<_>>().join(" ");
        if normalized.is_empty()
            || normalized.contains("command-name")
            || normalized.contains("local-command")
        {
            return None;
        }
        Some(normalized.chars().take(150).collect())
    };
    let content = &parsed["message"]["content"];
    if let Some(text) = content.as_str() {
        if let Some(t) = truncate(text) {
            return Some(t);
        }
    }
    if let Some(arr) = content.as_array() {
        for block in arr {
            if block["type"].as_str() == Some("text") {
                if let Some(t) = block["text"].as_str().and_then(truncate) {
                    return Some(t);
                }
            }
        }
    }
    None
}

/// Extract full message text from a JSONL event (user or assistant), for content search.
/// Unlike `extract_user_text`, this returns the complete text without truncation or filtering.
fn extract_message_text(parsed: &serde_json::Value) -> Option<String> {
    let msg_type = parsed["type"].as_str()?;
    if msg_type != "user" && msg_type != "assistant" {
        return None;
    }
    let content = &parsed["message"]["content"];

    // User messages can be a plain string
    if let Some(text) = content.as_str() {
        if !text.is_empty() {
            return Some(text.to_string());
        }
    }
    // Both user and assistant use text blocks in arrays
    if let Some(arr) = content.as_array() {
        let parts: Vec<&str> = arr
            .iter()
            .filter(|b| b["type"].as_str() == Some("text"))
            .filter_map(|b| b["text"].as_str())
            .collect();
        if !parts.is_empty() {
            return Some(parts.join(" "));
        }
    }
    None
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
            if block_type == "input_text" || block_type == "output_text" || block_type == "text" {
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
        Some(parts.join("\n"))
    }
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
    if path.exists() {
        Some(path)
    } else {
        None
    }
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
        let (role, text) = match extract_codex_message_text(&parsed) {
            Some(t) => t,
            None => continue,
        };

        push_search_matches(
            results,
            re,
            app_session_id,
            message_index,
            &role,
            &text,
            limit,
        );
        message_index += 1;
    }
}

// [RC-17] Search session content: walks ~/.claude/projects/, skips >20MB, 50-result cap
/// Search conversation content across all past sessions.
/// Returns up to 50 matches with a snippet centered on the match.
#[tauri::command]
pub async fn search_session_content(query: String) -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(move || search_session_content_sync(&query))
        .await
        .map_err(|e| e.to_string())?
}

const MAX_CONTENT_SEARCH_FILE_SIZE: u64 = 20 * 1024 * 1024;
const MAX_CONTENT_SEARCH_RESULTS: usize = 50;

fn search_session_content_sync(query: &str) -> Result<Vec<serde_json::Value>, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let projects_dir = home.join(".claude").join("projects");

    let query_lower = query.to_lowercase();

    // Collect all .jsonl files with metadata, sorted by mtime descending
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum SearchCli {
        Claude,
        Codex,
    }

    struct FileEntry {
        path: std::path::PathBuf,
        session_id: String,
        modified: std::time::SystemTime,
        cli: SearchCli,
    }

    let mut files: Vec<FileEntry> = Vec::new();

    if projects_dir.exists() {
        let project_dirs = std::fs::read_dir(&projects_dir)
            .map_err(|e| format!("Failed to read projects dir: {}", e))?;

        for entry in project_dirs.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let dir_files = match std::fs::read_dir(&path) {
                Ok(f) => f,
                Err(_) => continue,
            };

            for file in dir_files.flatten() {
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

                files.push(FileEntry {
                    path: fpath,
                    session_id,
                    modified: metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
                    cli: SearchCli::Claude,
                });
            }
        }
    }

    for fpath in collect_codex_rollout_files() {
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
        files.push(FileEntry {
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
            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };

            let parsed = match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let text = match file_entry.cli {
                SearchCli::Claude => match extract_message_text(&parsed) {
                    Some(t) => t,
                    None => continue,
                },
                SearchCli::Codex => match codex_user_event_text(&parsed)
                    .or_else(|| extract_codex_message_text(&parsed).map(|(_, text)| text))
                {
                    Some(t) => t,
                    None => continue,
                },
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

            let role = match parsed["type"].as_str() {
                Some("user") => "user",
                Some("assistant") => "assistant",
                _ => continue,
            };

            let text = match extract_message_text(&parsed) {
                Some(t) => t,
                None => {
                    message_index += 1;
                    continue;
                }
            };

            push_search_matches(
                &mut results,
                &re,
                session_id,
                message_index,
                role,
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
        codex_id_from_rollout_filename, codex_user_event_text, extract_codex_message_text,
        extract_user_text, push_search_matches, read_conversation_sync, summarize_codex_rollout,
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
                "content": "local-command command-name"
            }
        });

        assert_eq!(extract_user_text(&parsed), None);
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
const MAX_CONVERSATION_MESSAGES: usize = 500;

/// Read a conversation JSONL file and return structured messages as CapturedMessage[].
#[tauri::command]
pub async fn read_conversation(file_path: String) -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(move || read_conversation_sync(&file_path))
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

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let parsed: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if parsed["type"].as_str() == Some("response_item") {
            let payload = &parsed["payload"];
            if payload["type"].as_str() != Some("message") {
                continue;
            }
            let role = match payload["role"].as_str() {
                Some("user") => "user",
                Some("assistant") => "assistant",
                _ => continue,
            };
            let Some(text) = codex_text_from_content(&payload["content"]) else {
                continue;
            };
            messages.push(serde_json::json!({
                "role": role,
                "content": [{ "type": "text", "text": text }],
            }));
            if messages.len() >= MAX_CONVERSATION_MESSAGES {
                break;
            }
            continue;
        }

        let msg_type = match parsed["type"].as_str() {
            Some(t) => t,
            None => continue,
        };

        if msg_type != "user" && msg_type != "assistant" {
            continue;
        }

        // Preserve the content block array structure for CapturedMessage compatibility
        let content = &parsed["message"]["content"];
        let content_blocks = if let Some(text) = content.as_str() {
            // User messages can be a plain string — wrap in a text block
            serde_json::json!([{ "type": "text", "text": text }])
        } else if let Some(arr) = content.as_array() {
            // Already an array of content blocks — pass through
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
                                // Truncate large tool inputs
                                if let Some(input) = block.get("input") {
                                    let input_str =
                                        serde_json::to_string(input).unwrap_or_default();
                                    if input_str.len() > 2000 {
                                        let end = input_str.floor_char_boundary(2000);
                                        obj["input"] = serde_json::Value::String(format!(
                                            "{}...",
                                            &input_str[..end]
                                        ));
                                    } else {
                                        obj["input"] = input.clone();
                                    }
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
                                // Extract text from tool result content
                                if let Some(text) = block["content"].as_str() {
                                    let truncated = if text.len() > 2000 {
                                        let end = text.floor_char_boundary(2000);
                                        format!("{}...", &text[..end])
                                    } else {
                                        text.to_string()
                                    };
                                    obj["text"] = serde_json::Value::String(truncated);
                                } else if let Some(arr) = block["content"].as_array() {
                                    let parts: Vec<&str> = arr
                                        .iter()
                                        .filter(|b| b["type"].as_str() == Some("text"))
                                        .filter_map(|b| b["text"].as_str())
                                        .collect();
                                    if !parts.is_empty() {
                                        let joined = parts.join("\n");
                                        let truncated = if joined.len() > 2000 {
                                            let end = joined.floor_char_boundary(2000);
                                            format!("{}...", &joined[..end])
                                        } else {
                                            joined
                                        };
                                        obj["text"] = serde_json::Value::String(truncated);
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
            continue;
        };

        messages.push(serde_json::json!({
            "role": msg_type,
            "content": content_blocks,
        }));

        if messages.len() >= MAX_CONVERSATION_MESSAGES {
            break;
        }
    }

    Ok(messages)
}

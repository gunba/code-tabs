use crate::path_utils;

/// Get the claude-tabs data directory (%LOCALAPPDATA%/claude-tabs/).
/// Creates it if it doesn't exist.
pub(crate) fn get_data_dir() -> Result<std::path::PathBuf, String> {
    let data_dir = dirs::data_local_dir()
        .ok_or("Could not determine local data directory")?
        .join("claude-tabs");
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
    open::that_detached(&path)
        .map_err(|e| format!("Failed to open tap log: {}", e))
}

/// Open a session's data directory in the system file manager.
#[tauri::command]
pub fn open_session_data_dir(session_id: String) -> Result<(), String> {
    let dir = get_session_data_dir(&session_id)?;
    open::that_detached(&dir)
        .map_err(|e| format!("Failed to open session data dir: {}", e))
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
    let cutoff = std::time::SystemTime::now()
        - std::time::Duration::from_secs(max_age_hours * 3600);
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
    let mut uuid_to_session: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    // Walk project dirs
    let entries = std::fs::read_dir(&projects_dir)
        .map_err(|e| format!("Failed to read projects dir: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }

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

            if session_id.is_empty() { continue; }

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
                            if let Some(stid) = parsed.get("sourceToolAssistantUUID").and_then(|v| v.as_str()) {
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
                    if !first_msg.is_empty() && source_tool_uuid.is_some() { break; }
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
                    if !last_msg.is_empty() && !model.is_empty() { break; }
                }
            }

            raw_entries.push(RawEntry {
                modified,
                session_id: session_id.clone(),
                source_tool_uuid,
                json: serde_json::json!({
                    "id": session_id,
                    "path": project_name,
                    "directory": decoded_dir,
                    "lastModified": last_modified,
                    "sizeBytes": size_bytes,
                    "firstMessage": first_msg,
                    "lastMessage": last_msg,
                    "parentId": serde_json::Value::Null,
                    "model": model,
                }),
            });
        }
    }

    // --- Chain detection: resolve sourceToolAssistantUUID → parent session via UUID map ---
    let id_set: std::collections::HashSet<String> = raw_entries.iter()
        .map(|e| e.session_id.clone())
        .collect();
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
        if s.len() > 20 && !s.contains("command-name") && !s.contains("local-command") {
            Some(s.chars().take(150).collect())
        } else {
            None
        }
    };
    let content = &parsed["message"]["content"];
    if let Some(text) = content.as_str() {
        if let Some(t) = truncate(text) { return Some(t); }
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
    if msg_type != "user" && msg_type != "assistant" { return None; }
    let content = &parsed["message"]["content"];

    // User messages can be a plain string
    if let Some(text) = content.as_str() {
        if !text.is_empty() { return Some(text.to_string()); }
    }
    // Both user and assistant use text blocks in arrays
    if let Some(arr) = content.as_array() {
        let parts: Vec<&str> = arr.iter()
            .filter(|b| b["type"].as_str() == Some("text"))
            .filter_map(|b| b["text"].as_str())
            .collect();
        if !parts.is_empty() { return Some(parts.join(" ")); }
    }
    None
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

    if !projects_dir.exists() {
        return Ok(Vec::new());
    }

    let query_lower = query.to_lowercase();

    // Collect all .jsonl files with metadata, sorted by mtime descending
    struct FileEntry {
        path: std::path::PathBuf,
        session_id: String,
        modified: std::time::SystemTime,
    }

    let mut files: Vec<FileEntry> = Vec::new();

    let project_dirs = std::fs::read_dir(&projects_dir)
        .map_err(|e| format!("Failed to read projects dir: {}", e))?;

    for entry in project_dirs.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }

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
            if size > MAX_CONTENT_SEARCH_FILE_SIZE { continue; }

            let session_id = fpath
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();

            if session_id.is_empty() { continue; }

            files.push(FileEntry {
                path: fpath,
                session_id,
                modified: metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
            });
        }
    }

    // Sort newest first — recent sessions are most relevant
    files.sort_by(|a, b| b.modified.cmp(&a.modified));

    let mut results: Vec<serde_json::Value> = Vec::new();

    for file_entry in &files {
        if results.len() >= MAX_CONTENT_SEARCH_RESULTS { break; }

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

            let text = match extract_message_text(&parsed) {
                Some(t) => t,
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
                let end = text.ceil_char_boundary((pos + query_lower.len() + snippet_half).min(text.len()));
                let mut snippet = String::new();
                if start > 0 { snippet.push_str("..."); }
                snippet.push_str(&text[start..end]);
                if end < text.len() { snippet.push_str("..."); }

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

#[tauri::command]
pub fn shell_open(path: String) -> Result<(), String> {
    open::that_detached(&path).map_err(|e| format!("shell_open failed for {path}: {e}"))
}

/// [SL-19] [SL-20] Check whether a path exists and is a directory.
#[tauri::command]
pub fn dir_exists(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

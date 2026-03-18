use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub struct WatcherState {
    active: HashMap<String, bool>, // session_id -> should_stop
    subagent_watchers: HashMap<String, Vec<String>>, // session_id -> list of subagent_ids being watched
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            active: HashMap::new(),
            subagent_watchers: HashMap::new(),
        }
    }
}

/// Public wrapper for encode_dir (used by commands.rs)
pub fn encode_dir_pub(dir: &str) -> String { encode_dir(dir) }

fn encode_dir(dir: &str) -> String {
    // Mirrors Claude Code's project directory encoding:
    // replaces ALL non-alphanumeric characters with hyphens.
    // C:\Users\jorda\Desktop\Obsidian -> C--Users-jorda-Desktop-Obsidian
    // C:\Users\Jordan.Graham\Desktop  -> C--Users-Jordan-Graham-Desktop
    dir.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect::<String>()
        .trim_end_matches('-')
        .to_string()
}

fn jsonl_path(session_id: &str, working_dir: &str) -> PathBuf {
    let home = match dirs::home_dir() { Some(h) => h, None => return PathBuf::new() };
    let encoded = encode_dir(working_dir);
    home.join(".claude")
        .join("projects")
        .join(encoded)
        .join(format!("{}.jsonl", session_id))
}

/// Find JSONL file modified after a given timestamp in a project directory.
/// Used to discover the actual Claude session ID created during PTY spawn.
#[tauri::command]
pub fn find_active_jsonl_session(working_dir: String, since_ms: u64) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let encoded = encode_dir(&working_dir);
    let project_dir = home.join(".claude").join("projects").join(encoded);

    if !project_dir.exists() {
        return Err("Project dir not found".into());
    }

    let since = std::time::UNIX_EPOCH + std::time::Duration::from_millis(since_ms);
    let mut best: Option<(std::time::SystemTime, String)> = None;

    if let Ok(entries) = std::fs::read_dir(&project_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Ok(meta) = path.metadata() {
                let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
                // Only consider files modified after our spawn time
                if modified < since { continue; }
                let sid = path.file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                if sid.is_empty() { continue; }
                if best.is_none() || modified > best.as_ref().unwrap().0 {
                    best = Some((modified, sid));
                }
            }
        }
    }

    best.map(|(_, sid)| sid).ok_or("No JSONL files found since spawn".into())
}

/// Check if a JSONL conversation file exists and has content.
/// Used to determine if --resume will work for a given session.
#[tauri::command]
pub fn session_has_conversation(session_id: String, working_dir: String) -> bool {
    let path = jsonl_path(&session_id, &working_dir);
    path.exists() && path.metadata().map(|m| m.len() > 100).unwrap_or(false)
}

/// Find a continuation JSONL file for a given session ID.
/// When Claude enters plan mode or forks a conversation, the new JSONL file
/// references the old sessionId in its first few events. This command scans
/// the project directory for such a file and returns its session ID.
#[tauri::command]
pub fn find_continuation_session(session_id: String, working_dir: String) -> Result<Option<String>, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let encoded = encode_dir(&working_dir);
    let project_dir = home.join(".claude").join("projects").join(encoded);

    if !project_dir.exists() {
        return Ok(None);
    }

    let current_file = format!("{}.jsonl", session_id);

    if let Ok(entries) = fs::read_dir(&project_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            if !fname.ends_with(".jsonl") || fname == current_file { continue; }

            // Read first 5 lines and check if any reference our session ID
            if let Ok(file) = std::fs::File::open(&path) {
                let reader = std::io::BufReader::new(file);
                let mut found_ref = false;
                let mut new_sid: Option<String> = None;
                for (i, line) in std::io::BufRead::lines(reader).take(5).enumerate() {
                    if let Ok(line) = line {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
                            let line_sid = parsed["sessionId"].as_str().unwrap_or("");
                            if line_sid == session_id {
                                found_ref = true;
                            } else if !line_sid.is_empty() && found_ref && i > 0 {
                                // Found a line with a DIFFERENT sessionId after seeing our old one
                                new_sid = Some(line_sid.to_string());
                                break;
                            }
                        }
                    }
                }
                if let Some(sid) = new_sid {
                    return Ok(Some(sid));
                }
            }
        }
    }

    Ok(None)
}

#[tauri::command]
pub fn start_jsonl_watcher(
    app: AppHandle,
    session_id: String,
    working_dir: String,
    jsonl_session_id: Option<String>,
    watcher_state: tauri::State<'_, Arc<Mutex<WatcherState>>>,
) {
    // For resumed sessions, the JSONL file uses the original session's ID,
    // but events are tagged with the app's internal session ID.
    let file_sid = jsonl_session_id.as_deref().unwrap_or(&session_id).to_string();
    let is_resumed = jsonl_session_id.is_some();
    let path = jsonl_path(&file_sid, &working_dir);
    let sid = session_id.clone();
    let state = watcher_state.inner().clone();

    eprintln!("[jsonl_watcher] Starting watcher for session {} at {} (resumed={})", sid, path.display(), is_resumed);

    // Mark as active
    if let Ok(mut s) = state.lock() {
        s.active.insert(sid.clone(), false);
    }

    // Spawn background polling thread
    std::thread::spawn(move || {
        let mut offset: u64 = 0;
        let mut retries = 0;
        let mut did_fast_scan = false;

        loop {
            // Check if stopped
            if let Ok(s) = state.lock() {
                if s.active.get(&sid) == Some(&true) {
                    break;
                }
            }

            // Try to open/read file
            if let Ok(file) = File::open(&path) {
                retries = 0;
                let len = file.metadata().map(|m| m.len()).unwrap_or(0);

                // For resumed sessions on first read: fast two-point scan instead of
                // reading the entire file. Emit only the first 30 lines (for first user
                // message / tab naming) and the last 100 lines (for current state,
                // cost, tokens). Then skip to end and watch for new events.
                if is_resumed && !did_fast_scan && len > 0 {
                    did_fast_scan = true;
                    eprintln!("[jsonl_watcher] Fast scan: {} bytes for session {}", len, sid);

                    // HEAD: read first 30 lines for first user message / tab naming
                    {
                        let head_file = File::open(&path).unwrap();
                        let reader = BufReader::new(head_file);
                        let mut line = String::new();
                        let mut count = 0;
                        let mut r = reader;
                        while count < 30 && r.read_line(&mut line).unwrap_or(0) > 0 {
                            let trimmed = line.trim();
                            if !trimmed.is_empty() {
                                app.emit("jsonl-event", serde_json::json!({
                                    "sessionId": sid, "line": trimmed
                                })).ok();
                                count += 1;
                            }
                            line.clear();
                        }
                    }

                    // TAIL: seek to last ~256KB and read last 100 lines for state/cost/tokens
                    {
                        let tail_file = File::open(&path).unwrap();
                        let mut reader = BufReader::new(tail_file);
                        let seek_pos = if len > 256_000 { len - 256_000 } else { 0 };
                        reader.seek(SeekFrom::Start(seek_pos)).ok();
                        // Collect lines, keep last 100
                        let mut tail_lines: Vec<String> = Vec::new();
                        let mut line = String::new();
                        while reader.read_line(&mut line).unwrap_or(0) > 0 {
                            let trimmed = line.trim().to_string();
                            if !trimmed.is_empty() {
                                tail_lines.push(trimmed);
                            }
                            line.clear();
                        }
                        let start = if tail_lines.len() > 100 { tail_lines.len() - 100 } else { 0 };
                        for tl in &tail_lines[start..] {
                            app.emit("jsonl-event", serde_json::json!({
                                "sessionId": sid, "line": tl
                            })).ok();
                        }
                    }

                    app.emit("jsonl-caught-up", serde_json::json!({ "sessionId": sid })).ok();
                    offset = len;
                } else if len > offset {
                    let mut reader = BufReader::new(file);
                    if reader.seek(SeekFrom::Start(offset)).is_ok() {
                        let mut line = String::new();
                        while reader.read_line(&mut line).unwrap_or(0) > 0 {
                            let trimmed = line.trim();
                            if !trimmed.is_empty() {
                                app.emit(
                                    "jsonl-event",
                                    serde_json::json!({
                                        "sessionId": sid,
                                        "line": trimmed
                                    }),
                                )
                                .ok();
                            }
                            line.clear();
                        }
                    }
                    app.emit(
                        "jsonl-caught-up",
                        serde_json::json!({ "sessionId": sid }),
                    ).ok();
                    offset = len;
                }
            } else {
                retries += 1;
                if retries > 60 {
                    break; // Give up after ~30 seconds
                }
            }

            std::thread::sleep(std::time::Duration::from_millis(500));
        }

        // Cleanup
        if let Ok(mut s) = state.lock() {
            s.active.remove(&sid);
        }
    });
}

#[tauri::command]
pub fn stop_jsonl_watcher(
    session_id: String,
    watcher_state: tauri::State<'_, Arc<Mutex<WatcherState>>>,
) {
    if let Ok(mut s) = watcher_state.lock() {
        s.active.insert(session_id, true); // Signal stop
    }
}

fn subagent_dir(session_id: &str, working_dir: &str) -> PathBuf {
    let home = match dirs::home_dir() { Some(h) => h, None => return PathBuf::new() };
    let encoded = encode_dir(working_dir);
    home.join(".claude")
        .join("projects")
        .join(encoded)
        .join(session_id)
        .join("subagents")
}

#[tauri::command]
pub fn start_subagent_watcher(
    app: AppHandle,
    session_id: String,
    working_dir: String,
    jsonl_session_id: Option<String>,
    watcher_state: tauri::State<'_, Arc<Mutex<WatcherState>>>,
) {
    let file_sid = jsonl_session_id.unwrap_or_else(|| session_id.clone());
    let dir = subagent_dir(&file_sid, &working_dir);
    let sid = session_id.clone();
    let state = watcher_state.inner().clone();

    // Initialize subagent tracking for this session
    if let Ok(mut s) = state.lock() {
        s.subagent_watchers.entry(sid.clone()).or_default();
    }

    // Spawn directory scanner thread
    let dir_str = dir.to_string_lossy().to_string();
    std::thread::spawn(move || {
        // Track per-subagent file offsets
        let mut offsets: HashMap<String, u64> = HashMap::new();
        eprintln!("[subagent_watcher] Scanning dir: {} for session {}", dir_str, sid);

        loop {
            // Check if parent session stopped
            if let Ok(s) = state.lock() {
                if s.active.get(&sid) == Some(&true) {
                    break;
                }
            }

            // Scan for subagent JSONL files
            if let Ok(entries) = fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let filename = path.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string();

                    // Match agent-{hex}.jsonl pattern
                    if !filename.starts_with("agent-") || !filename.ends_with(".jsonl") {
                        continue;
                    }

                    let subagent_id = filename.trim_end_matches(".jsonl").to_string();
                    let offset = offsets.entry(subagent_id.clone()).or_insert(0);
                    if *offset == 0 {
                        eprintln!("[subagent_watcher] Found new subagent file: {} for session {}", filename, sid);
                    }

                    // Tail the subagent JSONL file
                    if let Ok(file) = File::open(&path) {
                        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
                        if len > *offset {
                            let mut reader = BufReader::new(file);
                            if reader.seek(SeekFrom::Start(*offset)).is_ok() {
                                let mut line = String::new();
                                while reader.read_line(&mut line).unwrap_or(0) > 0 {
                                    let trimmed = line.trim();
                                    if !trimmed.is_empty() {
                                        app.emit(
                                            "jsonl-subagent-event",
                                            serde_json::json!({
                                                "sessionId": sid,
                                                "subagentId": subagent_id,
                                                "line": trimmed
                                            }),
                                        )
                                        .ok();
                                    }
                                    line.clear();
                                }
                            }
                            *offset = len;
                        }
                    }
                }
            }

            std::thread::sleep(std::time::Duration::from_millis(500));
        }

        // Cleanup
        if let Ok(mut s) = state.lock() {
            s.subagent_watchers.remove(&sid);
        }
    });
}

#[tauri::command]
pub fn stop_subagent_watcher(
    session_id: String,
    watcher_state: tauri::State<'_, Arc<Mutex<WatcherState>>>,
) {
    // Clean up subagent tracking. The watcher thread exits when
    // the parent session's active flag is set.
    if let Ok(mut s) = watcher_state.lock() {
        s.subagent_watchers.remove(&session_id);
    }
}

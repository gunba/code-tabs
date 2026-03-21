use tauri::State;

use crate::path_utils;
use crate::session::persistence;
use crate::session::types::{Session, SessionConfig, SessionState};
use crate::session::SessionManager;
use crate::ActivePids;

#[tauri::command]
pub fn create_session(
    name: String,
    config: SessionConfig,
    manager: State<'_, SessionManager>,
) -> Result<Session, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let mut config = config;
    config.session_id = Some(id.clone());
    let session = Session::new(id, name, config);
    let session_clone = session.clone();
    manager.add_session(session);
    Ok(session_clone)
}

#[tauri::command]
pub fn close_session(id: String, manager: State<'_, SessionManager>) -> Result<(), String> {
    manager.remove_session(&id);
    // Don't persist here — the frontend owns persistence via persist_sessions_json
    // (Rust-side metadata is stale and would overwrite the frontend's live data).
    Ok(())
}

#[tauri::command]
pub fn get_session(id: String, manager: State<'_, SessionManager>) -> Result<Session, String> {
    manager
        .get_session(&id)
        .ok_or_else(|| format!("Session {} not found", id))
}

#[tauri::command]
pub fn list_sessions(manager: State<'_, SessionManager>) -> Result<Vec<Session>, String> {
    Ok(manager.list_sessions())
}

#[tauri::command]
pub fn set_active_tab(id: String, manager: State<'_, SessionManager>) -> Result<(), String> {
    manager.set_active(&id);
    Ok(())
}

#[tauri::command]
pub fn get_active_tab(manager: State<'_, SessionManager>) -> Result<Option<String>, String> {
    Ok(manager.get_active())
}

#[tauri::command]
pub fn reorder_tabs(
    order: Vec<String>,
    manager: State<'_, SessionManager>,
) -> Result<(), String> {
    manager.reorder_tabs(order);
    Ok(())
}

#[tauri::command]
pub fn update_session_state(
    id: String,
    state: SessionState,
    manager: State<'_, SessionManager>,
) -> Result<(), String> {
    manager.update_state(&id, state);
    Ok(())
}

#[tauri::command]
pub fn set_session_pty_id(
    id: String,
    pty_id: u32,
    manager: State<'_, SessionManager>,
) -> Result<(), String> {
    manager.set_pty_id(&id, pty_id);
    Ok(())
}

#[tauri::command]
pub fn persist_sessions(manager: State<'_, SessionManager>) -> Result<(), String> {
    let snapshots = manager.snapshots();
    persistence::save_sessions(&snapshots)
}

/// Save session data directly from the frontend (includes live metadata).
/// The Rust session manager doesn't receive metadata updates from the frontend,
/// so this command lets the frontend persist its own authoritative data.
#[tauri::command]
pub fn persist_sessions_json(json: String) -> Result<(), String> {
    let path = persistence::sessions_file_path();
    std::fs::write(path, json).map_err(|e| format!("Failed to write sessions: {}", e))
}

#[tauri::command]
pub fn load_persisted_sessions(manager: State<'_, SessionManager>) -> Result<Vec<Session>, String> {
    let snapshots = persistence::load_sessions()?;
    manager.restore_from_snapshots(snapshots);
    Ok(manager.list_sessions())
}

#[tauri::command]
pub async fn detect_claude_cli() -> Result<String, String> {
    // Run on a background thread so the WebView event loop isn't blocked
    tokio::task::spawn_blocking(|| {
        detect_claude_cli_sync()
    }).await.map_err(|e| e.to_string())?
}

fn detect_claude_cli_sync() -> Result<String, String> {
    let mut cmd = std::process::Command::new("where");
    cmd.arg("claude");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = cmd.output()
        .map_err(|e| format!("Failed to search for claude: {}", e))?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if !path.is_empty() {
            return Ok(path);
        }
    }

    // Check common install locations
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let candidates = [
        home.join(".npm-global").join("bin").join("claude.cmd"),
        home.join("AppData")
            .join("Roaming")
            .join("npm")
            .join("claude.cmd"),
    ];

    for candidate in &candidates {
        if candidate.exists() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }

    Err("Claude CLI not found. Please install it: npm install -g @anthropic-ai/claude-code".into())
}

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
        first_event_session_id: Option<String>,
        json: serde_json::Value,
    }

    let mut raw_entries: Vec<RawEntry> = Vec::new();

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

            // --- Head pass: BufReader, first 30 lines → firstMessage + first-event sessionId ---
            let mut first_msg = String::new();
            let mut first_event_sid: Option<String> = None;
            if let Ok(file_handle) = std::fs::File::open(&fpath) {
                use std::io::BufRead;
                let reader = std::io::BufReader::new(file_handle);
                for line in reader.lines().take(30).flatten() {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
                        // Capture sessionId from first event that has one
                        if first_event_sid.is_none() {
                            if let Some(sid) = parsed.get("sessionId").and_then(|v| v.as_str()) {
                                if !sid.is_empty() {
                                    first_event_sid = Some(sid.to_string());
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
                    // Stop early if we have both
                    if !first_msg.is_empty() && first_event_sid.is_some() { break; }
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
                first_event_session_id: first_event_sid,
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

    // --- Chain detection: if a file's first-event sessionId differs from its own ID
    //     and exists in the result set, set parentId to that ID. ---
    let id_set: std::collections::HashSet<String> = raw_entries.iter()
        .map(|e| e.session_id.clone())
        .collect();
    for entry in &mut raw_entries {
        if let Some(ref fesid) = entry.first_event_session_id {
            if fesid != &entry.session_id && id_set.contains(fesid) {
                entry.json["parentId"] = serde_json::Value::String(fesid.clone());
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

/// Run `claude --version` — async to avoid blocking the WebView.
#[tauri::command]
pub async fn check_cli_version() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        let mut cmd = std::process::Command::new("claude");
        cmd.arg("--version");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let output = cmd.output()
            .map_err(|e| format!("Failed to run claude --version: {}", e))?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            Err("claude --version failed".into())
        }
    }).await.map_err(|e| e.to_string())?
}

/// Run `claude --help` — async to avoid blocking the WebView.
#[tauri::command]
pub async fn get_cli_help() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        let mut cmd = std::process::Command::new("claude");
        cmd.arg("--help");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let output = cmd.output()
            .map_err(|e| format!("Failed to run claude --help: {}", e))?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            if !stderr.is_empty() { Ok(stderr) }
            else { Err("claude --help failed".into()) }
        }
    }).await.map_err(|e| e.to_string())?
}

/// Get the claude-tabs data directory (%LOCALAPPDATA%/claude-tabs/).
/// Creates it if it doesn't exist.
fn get_data_dir() -> Result<std::path::PathBuf, String> {
    let data_dir = dirs::data_local_dir()
        .ok_or("Could not determine local data directory")?
        .join("claude-tabs");
    if !data_dir.exists() {
        std::fs::create_dir_all(&data_dir)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;
    }
    Ok(data_dir)
}

/// Read the UI config file. Returns the content or empty string if not found.
#[tauri::command]
pub fn read_ui_config() -> Result<String, String> {
    let data_dir = get_data_dir()?;
    let path = data_dir.join("ui-config.json");

    if !path.exists() {
        return Ok(String::new());
    }

    std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read ui-config.json: {}", e))
}

/// Write the UI config file (used to create defaults).
#[tauri::command]
pub fn write_ui_config(config_json: String) -> Result<(), String> {
    let data_dir = get_data_dir()?;
    let path = data_dir.join("ui-config.json");
    std::fs::write(&path, config_json)
        .map_err(|e| format!("Failed to write ui-config.json: {}", e))
}

/// Read the Claude Code binary content (latest version).
/// Shared by discover_builtin_commands and discover_settings_schema.
fn read_claude_binary() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let versions_dir = home.join(".local").join("share").join("claude").join("versions");
    if !versions_dir.exists() {
        return Err("No versions dir".into());
    }

    let mut versions: Vec<_> = std::fs::read_dir(&versions_dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    versions.sort();

    let binary_path = match versions.last() {
        Some(v) => versions_dir.join(v),
        None => return Err("No versions found".into()),
    };

    match std::fs::read(&binary_path) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).to_string()),
        Err(e) => Err(format!("Failed to read binary: {}", e)),
    }
}

/// Scan the Claude Code binary for built-in slash commands.
/// Extracts from the command registration pattern: name:"cmd",description:"..."
#[tauri::command]
pub async fn discover_builtin_commands() -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(discover_builtin_commands_sync)
        .await
        .map_err(|e| e.to_string())?
}

fn discover_builtin_commands_sync() -> Result<Vec<serde_json::Value>, String> {
    let content = match read_claude_binary() {
        Ok(c) => c,
        Err(_) => return Ok(Vec::new()),
    };

    let mut commands = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // Primary pattern: command registration objects — name:"cmd",description:"..."
    let re = regex::Regex::new(r#"name:"([\w][\w-]*)",description:"([^"]*?)""#).unwrap();
    for cap in re.captures_iter(&content) {
        let name = &cap[1];
        let desc_raw = &cap[2];
        // Clean up escaped newlines in descriptions
        let desc = desc_raw.replace("\\n", " ");
        let cmd = format!("/{}", name);
        if cmd.len() >= 4 && seen.insert(cmd.clone()) {
            commands.push(serde_json::json!({ "cmd": cmd, "desc": desc }));
        }
    }

    // Filter out noise (internal tools, MCP tools, non-slash-commands)
    commands.retain(|c| {
        let cmd = c["cmd"].as_str().unwrap_or("");
        let desc = c["desc"].as_str().unwrap_or("");
        // Skip commands that look like CLI tools or MCP tools (very long descriptions about DOM/browser)
        !cmd.starts_with("/--") && !desc.contains("tab ID") && !desc.contains("DOM")
            && cmd.len() >= 4 && cmd.len() <= 30
    });

    Ok(commands)
}

/// Scan the Claude Code binary for settings schema definitions.
/// Extracts Zod schema patterns: keyName:u.type().optional().describe("...")
/// Returns discovered settings with key, type, description, choices.
#[tauri::command]
pub async fn discover_settings_schema() -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(discover_settings_schema_sync)
        .await
        .map_err(|e| e.to_string())?
}

fn discover_settings_schema_sync() -> Result<Vec<serde_json::Value>, String> {
    let content = match read_claude_binary() {
        Ok(c) => c,
        Err(_) => return Ok(Vec::new()),
    };

    let mut fields = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // Pattern: keyName:u.type(args).optional().catch(...).describe("description")
    // The Zod schema in the binary uses a minified `u` variable.
    // We capture: key name, base type, optional args (for enum choices), and description.
    //
    // Match key:u.type( — then scan ahead for .describe("...") within ~300 chars
    let key_re = regex::Regex::new(
        r#"([a-zA-Z][a-zA-Z0-9]{2,40}):u\.(enum|string|boolean|number|array|record|object|lazy|union)\("#
    ).unwrap();

    for cap in key_re.captures_iter(&content) {
        let key = cap[1].to_string();
        let base_type = cap[2].to_string();

        // Skip internal/noise keys (too short, all-caps constants, common JS identifiers)
        if key.len() < 3 || key.chars().all(|c| c.is_uppercase()) {
            continue;
        }
        // Skip common JS/minification noise
        if matches!(key.as_str(),
            "type" | "name" | "value" | "message" | "data" | "error" | "status" |
            "content" | "role" | "input" | "output" | "result" | "text" | "key" |
            "description" | "title" | "path" | "args" | "options" | "config" |
            "params" | "command" | "event" | "action" | "state" | "context" |
            "source" | "target" | "children" | "parent" | "index" | "length"
        ) {
            continue;
        }

        if !seen.insert(key.clone()) {
            continue;
        }

        // Look at the ~400 chars after the match to find .describe("...") and enum choices
        let match_end = cap.get(0).unwrap().end();
        let lookahead = &content[match_end..std::cmp::min(match_end + 400, content.len())];

        // Extract description from .describe("...")
        let description = regex::Regex::new(r#"\.describe\("([^"]{4,200})"\)"#)
            .ok()
            .and_then(|re| re.captures(lookahead))
            .map(|c| c[1].replace("\\n", " "));

        // Only keep entries that have a description (filters out non-settings Zod schemas)
        let desc = match description {
            Some(d) => d,
            None => continue,
        };

        // Extract enum choices from u.enum(["a","b","c"])
        let choices: Option<Vec<String>> = if base_type == "enum" {
            regex::Regex::new(r#"\[([^\]]{1,200})\]"#)
                .ok()
                .and_then(|re| re.captures(lookahead))
                .map(|c| {
                    c[1].split(',')
                        .filter_map(|s| {
                            let trimmed = s.trim().trim_matches('"');
                            if !trimmed.is_empty() { Some(trimmed.to_string()) } else { None }
                        })
                        .collect()
                })
        } else {
            None
        };

        // Check for .optional()
        let optional = lookahead.contains(".optional()");

        // Map Zod type to our field type
        let field_type = match base_type.as_str() {
            "boolean" => "boolean",
            "number" => "number",
            "enum" => "enum",
            "array" => "stringArray",
            "record" => "stringMap",
            "object" | "lazy" | "union" => "object",
            _ => "string",
        };

        let mut entry = serde_json::json!({
            "key": key,
            "type": field_type,
            "description": desc,
            "optional": optional,
        });
        if let Some(c) = choices {
            entry["choices"] = serde_json::json!(c);
        }
        fields.push(entry);
    }

    // Sort alphabetically for consistency
    fields.sort_by(|a, b| {
        a["key"].as_str().unwrap_or("").cmp(b["key"].as_str().unwrap_or(""))
    });

    Ok(fields)
}

/// Scan for plugin/custom command files in multiple locations.
#[tauri::command]
pub fn discover_plugin_commands(extra_dirs: Vec<String>) -> Result<Vec<serde_json::Value>, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let mut commands = Vec::new();

    fn scan_dir(dir: &std::path::Path, commands: &mut Vec<serde_json::Value>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    scan_dir(&path, commands);
                } else if path.file_name().and_then(|n| n.to_str()) == Some("SKILL.md") {
                    // Parse SKILL.md with YAML frontmatter
                    if let Ok(content) = std::fs::read_to_string(&path) {
                        if let Some(fm) = content.strip_prefix("---") {
                            if let Some(end) = fm.find("---") {
                                let meta = &fm[..end];
                                let name = meta.lines()
                                    .find(|l| l.trim().starts_with("name:"))
                                    .and_then(|l| l.trim().strip_prefix("name:"))
                                    .map(|s| s.trim().to_string());
                                let desc = meta.lines()
                                    .find(|l| l.trim().starts_with("description:"))
                                    .and_then(|l| l.trim().strip_prefix("description:"))
                                    .map(|s| s.trim().chars().take(120).collect::<String>());
                                if let Some(n) = name {
                                    commands.push(serde_json::json!({
                                        "cmd": format!("/{}", n),
                                        "desc": desc.unwrap_or_default()
                                    }));
                                }
                            }
                        }
                    }
                } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
                    if let Some(parent) = path.parent() {
                        if parent.file_name().and_then(|n| n.to_str()) == Some("commands") {
                            let name = path.file_stem()
                                .and_then(|s| s.to_str())
                                .unwrap_or("")
                                .to_string();
                            if !name.is_empty() {
                                let desc = std::fs::read_to_string(&path)
                                    .ok()
                                    .and_then(|c| c.lines().next().map(|l| l.trim().trim_start_matches('#').trim().to_string()))
                                    .unwrap_or_default();
                                commands.push(serde_json::json!({
                                    "cmd": format!("/{}", name),
                                    "desc": desc
                                }));
                            }
                        }
                    }
                }
            }
        }
    }

    // 1. Global plugins
    let plugins_dir = home.join(".claude").join("plugins");
    if plugins_dir.exists() {
        scan_dir(&plugins_dir, &mut commands);
    }

    // 2. User-level custom commands (~/.claude/commands/)
    let user_cmds = home.join(".claude").join("commands");
    if user_cmds.exists() {
        scan_dir(&user_cmds, &mut commands);
    }

    // 3. User-level skills (~/.claude/skills/)
    let user_skills = home.join(".claude").join("skills");
    if user_skills.exists() {
        scan_dir(&user_skills, &mut commands);
    }

    // 4. Project-level custom commands and skills for each provided directory
    for dir in &extra_dirs {
        let project_cmds = std::path::Path::new(dir).join(".claude").join("commands");
        if project_cmds.exists() {
            scan_dir(&project_cmds, &mut commands);
        }
        let project_skills = std::path::Path::new(dir).join(".claude").join("skills");
        if project_skills.exists() {
            scan_dir(&project_skills, &mut commands);
        }
    }

    // Dedup by command name
    let mut seen = std::collections::HashSet::new();
    commands.retain(|c| {
        let name = c["cmd"].as_str().unwrap_or("").to_string();
        seen.insert(name)
    });

    Ok(commands)
}

/// Read the first user message from a session's JSONL file.
#[tauri::command]
pub fn get_first_user_message(session_id: String, working_dir: String) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let encoded = path_utils::encode_dir(&working_dir);
    let path = home.join(".claude").join("projects").join(encoded).join(format!("{}.jsonl", session_id));

    if !path.exists() {
        return Err("JSONL file not found".into());
    }

    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    for line in content.lines() {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) {
            if parsed["type"].as_str() != Some("user") { continue; }
            let msg_content = &parsed["message"]["content"];
            // String content
            if let Some(text) = msg_content.as_str() {
                if text.len() > 10 && !text.contains("command-name") && !text.contains("local-command") {
                    return Ok(text.chars().take(500).collect());
                }
            }
            // Array content (text blocks) — skip tool_result messages (auto-generated, not user prompts)
            if let Some(arr) = msg_content.as_array() {
                let has_tool_result = arr.iter().any(|b| b["type"].as_str() == Some("tool_result"));
                if !has_tool_result {
                    for block in arr {
                        if block["type"].as_str() == Some("text") {
                            if let Some(t) = block["text"].as_str() {
                                if t.len() > 10 && !t.contains("command-name") && !t.contains("local-command") {
                                    return Ok(t.chars().take(500).collect());
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    Err("No user message found".into())
}

#[tauri::command]
pub fn build_claude_args(config: SessionConfig) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = Vec::new();

    if let Some(ref model) = config.model {
        args.push("--model".into());
        args.push(model.clone());
    }

    match config.permission_mode {
        crate::session::types::PermissionMode::Default => {}
        crate::session::types::PermissionMode::AcceptEdits => {
            args.push("--permission-mode".into());
            args.push("acceptEdits".into());
        }
        crate::session::types::PermissionMode::BypassPermissions => {
            args.push("--permission-mode".into());
            args.push("bypassPermissions".into());
        }
        crate::session::types::PermissionMode::DontAsk => {
            args.push("--permission-mode".into());
            args.push("dontAsk".into());
        }
        crate::session::types::PermissionMode::PlanMode => {
            args.push("--permission-mode".into());
            args.push("plan".into());
        }
        crate::session::types::PermissionMode::Auto => {
            args.push("--permission-mode".into());
            args.push("auto".into());
        }
    }

    if config.dangerously_skip_permissions {
        args.push("--dangerously-skip-permissions".into());
    }

    if let Some(ref prompt) = config.system_prompt {
        if !prompt.is_empty() {
            args.push("--system-prompt".into());
            args.push(prompt.clone());
        }
    }

    if let Some(ref prompt) = config.append_system_prompt {
        if !prompt.is_empty() {
            args.push("--append-system-prompt".into());
            args.push(prompt.clone());
        }
    }

    for tool in &config.allowed_tools {
        args.push("--allowedTools".into());
        args.push(tool.clone());
    }

    for tool in &config.disallowed_tools {
        args.push("--disallowedTools".into());
        args.push(tool.clone());
    }

    for dir in &config.additional_dirs {
        args.push("--add-dir".into());
        args.push(dir.clone());
    }

    if let Some(ref mcp) = config.mcp_config {
        if !mcp.is_empty() {
            args.push("--mcp-config".into());
            args.push(mcp.clone());
        }
    }

    if let Some(ref agent) = config.agent {
        if !agent.is_empty() {
            args.push("--agent".into());
            args.push(agent.clone());
        }
    }

    if let Some(ref effort) = config.effort {
        args.push("--effort".into());
        args.push(effort.clone());
    }

    if config.verbose {
        args.push("--verbose".into());
    }

    if config.debug {
        args.push("--debug".into());
    }

    if let Some(budget) = config.max_budget {
        args.push("--max-budget-usd".into());
        args.push(budget.to_string());
    }

    if config.project_dir {
        args.push("--project-dir".into());
        // Normalize forward slashes to backslashes for Windows
        args.push(config.working_dir.replace('/', "\\"));
    }

    if config.continue_session {
        args.push("--continue".into());
    } else if let Some(ref session_id) = config.resume_session {
        if !session_id.is_empty() {
            if config.fork_session {
                args.push("--fork-session".into());
                args.push(session_id.clone());
            } else {
                args.push("--resume".into());
                args.push(session_id.clone());
            }
        }
    }

    // Pass --session-id only for new sessions. Claude CLI rejects
    // --session-id combined with --resume or --continue unless
    // --fork-session is also specified.
    if !config.continue_session && config.resume_session.is_none() {
        if let Some(ref sid) = config.session_id {
            args.push("--session-id".into());
            args.push(sid.clone());
        }
    }

    // Append any raw extra flags
    if let Some(ref extra) = config.extra_flags {
        let extra = extra.trim();
        if !extra.is_empty() {
            for flag in extra.split_whitespace() {
                args.push(flag.to_string());
            }
        }
    }

    Ok(args)
}

/// Discover hooks from Claude Code settings files.
/// Reads from (in priority order):
/// 1. Project .claude/settings.local.json
/// 2. Project .claude/settings.json
/// 3. User ~/.claude/settings.json
#[tauri::command]
pub fn discover_hooks(working_dirs: Vec<String>) -> Result<serde_json::Value, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let mut all_hooks = serde_json::Map::new();

    // User-level hooks
    let user_settings = home.join(".claude").join("settings.json");
    if let Ok(content) = std::fs::read_to_string(&user_settings) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(hooks) = parsed.get("hooks") {
                all_hooks.insert("user".to_string(), hooks.clone());
            }
        }
    }

    // Project-level hooks for each working directory
    for dir in &working_dirs {
        let dir_path = std::path::Path::new(dir);
        for (settings_name, prefix) in &[
            ("settings.local.json", "project-local"),
            ("settings.json", "project"),
        ] {
            let settings_path = dir_path.join(".claude").join(settings_name);
            if let Ok(content) = std::fs::read_to_string(&settings_path) {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(hooks) = parsed.get("hooks") {
                        let key = format!("{}:{}", prefix, dir);
                        all_hooks.insert(key, hooks.clone());
                    }
                }
            }
        }
    }

    Ok(serde_json::Value::Object(all_hooks))
}

/// Save hooks configuration to a specific settings file.
/// scope: "user" | "project" | "project-local"
/// working_dir: project directory (needed for project scopes)
#[tauri::command]
pub fn save_hooks(scope: String, working_dir: String, hooks_json: String) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("No home dir")?;

    let settings_path = match scope.as_str() {
        "user" => home.join(".claude").join("settings.json"),
        "project" => std::path::Path::new(&working_dir).join(".claude").join("settings.json"),
        "project-local" => std::path::Path::new(&working_dir).join(".claude").join("settings.local.json"),
        _ => return Err("Invalid scope".into()),
    };

    // Read existing settings or create empty object
    let mut settings: serde_json::Value = if settings_path.exists() {
        let content = std::fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        // Create .claude directory if needed
        if let Some(parent) = settings_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        serde_json::json!({})
    };

    // Parse and set hooks
    let hooks: serde_json::Value = serde_json::from_str(&hooks_json).map_err(|e| e.to_string())?;
    settings["hooks"] = hooks;

    // Write back
    let output = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&settings_path, output).map_err(|e| e.to_string())?;

    Ok(())
}

/// Write test state to a separate file (test-state.json) so the test harness
/// doesn't conflict with ui-config.json.
/// Read test commands from the command file (test harness polls this).
#[tauri::command]
pub fn read_test_commands() -> Result<String, String> {
    let data_dir = dirs::data_local_dir()
        .ok_or("Could not determine local data directory")?
        .join("claude-tabs");
    let path = data_dir.join("test-commands.json");
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Write test commands (used by the harness to clear after reading).
#[tauri::command]
pub fn write_test_commands(json: String) -> Result<(), String> {
    let data_dir = dirs::data_local_dir()
        .ok_or("Could not determine local data directory")?
        .join("claude-tabs");
    if !data_dir.exists() {
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(data_dir.join("test-commands.json"), json)
        .map_err(|e| format!("Failed to write test commands: {}", e))
}

/// Scan JSONL conversation history for slash command usage.
/// Walks ~/.claude/projects/*/*.jsonl, caps at 200 most recent files by mtime,
/// and counts `<command-name>X</command-name>` patterns.
#[tauri::command]
pub async fn scan_command_usage() -> Result<std::collections::HashMap<String, u64>, String> {
    tokio::task::spawn_blocking(scan_command_usage_sync)
        .await
        .map_err(|e| e.to_string())?
}

fn scan_command_usage_sync() -> Result<std::collections::HashMap<String, u64>, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let projects_dir = home.join(".claude").join("projects");
    if !projects_dir.exists() {
        return Ok(std::collections::HashMap::new());
    }

    // Collect all .jsonl files with their modification times
    let mut files: Vec<(std::time::SystemTime, std::path::PathBuf)> = Vec::new();
    let entries = std::fs::read_dir(&projects_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }
        if let Ok(dir_entries) = std::fs::read_dir(&path) {
            for file in dir_entries.flatten() {
                let fpath = file.path();
                if fpath.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
                if let Ok(meta) = std::fs::metadata(&fpath) {
                    let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
                    files.push((mtime, fpath));
                }
            }
        }
    }

    // Sort by mtime desc, cap at 200
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.truncate(200);

    use std::io::{BufRead, BufReader};

    let re = regex::Regex::new(r"<command-name>(/[\w-]+)</command-name>").unwrap();
    let mut counts: std::collections::HashMap<String, u64> = std::collections::HashMap::new();

    for (_, path) in &files {
        let file = match std::fs::File::open(path) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for line in BufReader::new(file).lines().flatten() {
            for cap in re.captures_iter(&line) {
                *counts.entry(cap[1].to_string()).or_insert(0) += 1;
            }
        }
    }

    Ok(counts)
}

#[tauri::command]
pub fn write_test_state(json: String) -> Result<(), String> {
    let data_dir = dirs::data_local_dir()
        .ok_or("Could not determine local data directory")?
        .join("claude-tabs");
    if !data_dir.exists() {
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(data_dir.join("test-state.json"), json)
        .map_err(|e| format!("Failed to write test state: {}", e))
}

// ── Active PID registry (for cleanup on app close) ────────────────

#[tauri::command]
pub fn register_active_pid(pid: u32, pids: State<'_, ActivePids>) -> Result<(), String> {
    pids.0.lock().unwrap().insert(pid);
    Ok(())
}

#[tauri::command]
pub fn unregister_active_pid(pid: u32, pids: State<'_, ActivePids>) -> Result<(), String> {
    pids.0.lock().unwrap().remove(&pid);
    Ok(())
}

// ── Process tree kill (Windows) ────────────────────────────────────

/// Kill a process and all its descendants by PID.
/// Uses CreateToolhelp32Snapshot to walk the process tree via BFS,
/// then terminates children first, then the root.
#[tauri::command]
pub async fn kill_process_tree(pid: u32) -> Result<(), String> {
    tokio::task::spawn_blocking(move || kill_process_tree_sync(pid))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(target_os = "windows")]
pub(crate) fn kill_process_tree_sync(root_pid: u32) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return Err("CreateToolhelp32Snapshot failed".into());
        }

        // Collect all processes
        let mut entries: Vec<(u32, u32)> = Vec::new(); // (pid, parent_pid)
        let mut entry: PROCESSENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32>() as u32;

        if Process32First(snap, &mut entry) != 0 {
            loop {
                entries.push((entry.th32ProcessID, entry.th32ParentProcessID));
                if Process32Next(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);

        // BFS to find all descendants
        let mut to_kill = Vec::new();
        let mut queue = std::collections::VecDeque::new();
        queue.push_back(root_pid);
        while let Some(parent) = queue.pop_front() {
            for &(pid, ppid) in &entries {
                if ppid == parent && pid != root_pid {
                    to_kill.push(pid);
                    queue.push_back(pid);
                }
            }
        }
        // Kill children first, then root
        to_kill.reverse();
        to_kill.push(root_pid);

        for pid in to_kill {
            let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !handle.is_null() {
                TerminateProcess(handle, 1);
                CloseHandle(handle);
            }
        }
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn kill_process_tree_sync(root_pid: u32) -> Result<(), String> {
    // On non-Windows, just send SIGKILL to the process group
    unsafe {
        libc::kill(-(root_pid as i32), libc::SIGKILL);
    }
    Ok(())
}

// ── Kill session holder ────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct SessionHolderResult {
    /// Number of our own descendant processes killed (safe — stale orphans).
    killed: u32,
    /// PIDs of external processes holding the session (NOT killed).
    external: Vec<u32>,
}

/// Find processes holding a specific session ID. Kills our own descendants
/// automatically (stale orphans from crashed tabs). Returns external holder
/// PIDs so the frontend can prompt the user before killing those.
#[tauri::command]
pub async fn kill_session_holder(session_id: String) -> Result<SessionHolderResult, String> {
    tokio::task::spawn_blocking(move || kill_session_holder_sync(&session_id))
        .await
        .map_err(|e| e.to_string())?
}

/// Force-kill a specific external process by PID (user confirmed).
#[tauri::command]
pub async fn force_kill_session_holder(pid: u32) -> Result<(), String> {
    tokio::task::spawn_blocking(move || kill_process_tree_sync(pid))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(target_os = "windows")]
fn kill_session_holder_sync(session_id: &str) -> Result<SessionHolderResult, String> {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32,
        TH32CS_SNAPPROCESS,
    };

    // 1. Find PIDs whose command line contains this session ID
    let output = std::process::Command::new("wmic")
        .args([
            "process",
            "where",
            &format!("CommandLine like '%{}%'", session_id),
            "get",
            "ProcessId",
            "/value",
        ])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| format!("Failed to enumerate processes: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let my_pid = std::process::id();
    let mut matching_pids = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if let Some(pid_str) = line.strip_prefix("ProcessId=") {
            if let Ok(pid) = pid_str.trim().parse::<u32>() {
                if pid != my_pid && pid != 0 {
                    matching_pids.push(pid);
                }
            }
        }
    }

    if matching_pids.is_empty() {
        return Ok(SessionHolderResult { killed: 0, external: vec![] });
    }

    // 2. Build process tree to check ancestry
    let process_tree = unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return Err("CreateToolhelp32Snapshot failed".into());
        }
        let mut entries: Vec<(u32, u32)> = Vec::new();
        let mut entry: PROCESSENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32>() as u32;
        if Process32First(snap, &mut entry) != 0 {
            loop {
                entries.push((entry.th32ProcessID, entry.th32ParentProcessID));
                if Process32Next(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
        entries
    };

    // 3. For each matching PID, walk parent chain to see if it's our descendant
    let mut result = SessionHolderResult { killed: 0, external: vec![] };

    for pid in matching_pids {
        if is_descendant_of(pid, my_pid, &process_tree) {
            if kill_process_tree_sync(pid).is_ok() {
                result.killed += 1;
            }
        } else {
            result.external.push(pid);
        }
    }

    Ok(result)
}

#[cfg(not(target_os = "windows"))]
fn kill_session_holder_sync(session_id: &str) -> Result<SessionHolderResult, String> {
    let output = std::process::Command::new("pgrep")
        .args(["-f", session_id])
        .output()
        .map_err(|e| format!("Failed to enumerate processes: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let my_pid = std::process::id();

    // On Unix, read /proc/<pid>/stat for parent PID
    let process_tree: Vec<(u32, u32)> = std::fs::read_dir("/proc")
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter_map(|e| {
                    let pid: u32 = e.file_name().to_str()?.parse().ok()?;
                    let stat = std::fs::read_to_string(format!("/proc/{}/stat", pid)).ok()?;
                    let ppid: u32 = stat.split_whitespace().nth(3)?.parse().ok()?;
                    Some((pid, ppid))
                })
                .collect()
        })
        .unwrap_or_default();

    let mut result = SessionHolderResult { killed: 0, external: vec![] };

    for line in stdout.lines() {
        if let Ok(pid) = line.trim().parse::<u32>() {
            if pid != my_pid && pid != 0 {
                if is_descendant_of(pid, my_pid, &process_tree) {
                    if kill_process_tree_sync(pid).is_ok() {
                        result.killed += 1;
                    }
                } else {
                    result.external.push(pid);
                }
            }
        }
    }

    Ok(result)
}

/// Walk parent chain to check if `pid` is a descendant of `ancestor`.
fn is_descendant_of(pid: u32, ancestor: u32, tree: &[(u32, u32)]) -> bool {
    let mut current = pid;
    let mut visited = std::collections::HashSet::new();
    while visited.insert(current) {
        if let Some(&(_, ppid)) = tree.iter().find(|&&(p, _)| p == current) {
            if ppid == ancestor {
                return true;
            }
            if ppid == 0 || ppid == current {
                return false;
            }
            current = ppid;
        } else {
            return false;
        }
    }
    false
}

// ── Config Manager commands ────────────────────────────────────────

/// Validate an agent name — only alphanumeric, hyphens, underscores.
fn validate_agent_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Agent name cannot be empty".into());
    }
    if !name.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("Invalid agent name '{}': only alphanumeric, hyphens, underscores allowed", name));
    }
    Ok(())
}

/// Resolve the path for a config file based on scope and file type.
fn resolve_config_path(scope: &str, working_dir: &str, file_type: &str) -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;

    match file_type {
        "settings" => match scope {
            "user" => Ok(home.join(".claude").join("settings.json")),
            "project" => Ok(std::path::Path::new(working_dir).join(".claude").join("settings.json")),
            "project-local" => Ok(std::path::Path::new(working_dir).join(".claude").join("settings.local.json")),
            _ => Err("Invalid scope".into()),
        },
        "claudemd-user" => Ok(home.join(".claude").join("CLAUDE.md")),
        "claudemd-root" => Ok(std::path::Path::new(working_dir).join("CLAUDE.md")),
        "claudemd-dotclaude" => Ok(std::path::Path::new(working_dir).join(".claude").join("CLAUDE.md")),
        _ if file_type.starts_with("agent:") || file_type.starts_with("agent-delete:") => {
            let name = file_type.split_once(':').map(|(_, n)| n).unwrap_or("");
            validate_agent_name(name)?;
            Ok(std::path::Path::new(working_dir).join(".claude").join("agents").join(format!("{}.md", name)))
        },
        _ => Err(format!("Unknown file_type: {}", file_type)),
    }
}

/// Read a config file. Returns content or empty string if not found.
#[tauri::command]
pub fn read_config_file(scope: String, working_dir: String, file_type: String) -> Result<String, String> {
    let path = resolve_config_path(&scope, &working_dir, &file_type)?;
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path.display(), e))
}

/// Write a config file. Creates parent directories if needed.
/// For settings files, validates JSON. For agent-delete, deletes the file.
#[tauri::command]
pub fn write_config_file(scope: String, working_dir: String, file_type: String, content: String) -> Result<(), String> {
    // Handle agent deletion
    if file_type.starts_with("agent-delete:") {
        let path = resolve_config_path(&scope, &working_dir, &file_type)?;
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("Failed to delete: {}", e))?;
        }
        return Ok(());
    }

    let path = resolve_config_path(&scope, &working_dir, &file_type)?;

    // Validate JSON for settings files
    if file_type == "settings" {
        serde_json::from_str::<serde_json::Value>(&content)
            .map_err(|e| format!("Invalid JSON: {}", e))?;
    }

    // Create parent directories
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
        }
    }

    std::fs::write(&path, &content).map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

/// List agent definition files in a project's .claude/agents/ directory.
#[tauri::command]
pub fn list_agents(working_dir: String) -> Result<Vec<serde_json::Value>, String> {
    let agents_dir = std::path::Path::new(&working_dir).join(".claude").join("agents");
    if !agents_dir.exists() {
        return Ok(Vec::new());
    }

    let mut agents = Vec::new();
    let entries = std::fs::read_dir(&agents_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("md") {
            let name = path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if !name.is_empty() {
                agents.push(serde_json::json!({
                    "name": name,
                    "path": path.to_string_lossy().to_string(),
                }));
            }
        }
    }

    agents.sort_by(|a, b| {
        a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
    });
    Ok(agents)
}

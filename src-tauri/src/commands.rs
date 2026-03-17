use tauri::State;

use crate::session::persistence;
use crate::session::types::{Session, SessionConfig, SessionState};
use crate::session::SessionManager;

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

/// Decode a Claude projects directory name back to a filesystem path.
/// Claude encodes paths by replacing ALL non-alphanumeric chars with hyphens,
/// so the encoding is lossy (periods, spaces, slashes all become '-').
/// We resolve ambiguity by probing the filesystem to find which path exists.
fn decode_project_dir(encoded: &str) -> String {
    // Split drive letter on Windows: "C--Users-..." → ("C", "Users-...")
    let (prefix, segments_str) = if let Some((drive, rest)) = encoded.split_once("--") {
        (format!("{}:\\", drive), rest)
    } else {
        ("/".to_string(), encoded)
    };

    let parts: Vec<&str> = segments_str.split('-').collect();
    if parts.is_empty() {
        return prefix;
    }

    // Greedy filesystem walk: at each position, try joining multiple parts
    // with non-slash separators (period, hyphen, space) and check if the
    // resulting directory exists. Uses longest match first to handle names
    // like "Jordan.Graham" (2 parts joined with '.') correctly.
    let mut current = std::path::PathBuf::from(&prefix);
    let mut i = 0;

    while i < parts.len() {
        let mut matched = false;

        // Try multi-part names (longest first), with each separator
        let max_j = std::cmp::min(i + 6, parts.len());
        for j in (i + 2..=max_j).rev() {
            for sep in &[".", "-", " "] {
                let candidate = current.join(parts[i..j].join(sep));
                if candidate.exists() {
                    current = candidate;
                    i = j;
                    matched = true;
                    break;
                }
            }
            if matched { break; }
        }

        if !matched {
            // Single part as path segment (original behavior)
            current = current.join(parts[i]);
            i += 1;
        }
    }

    current.to_string_lossy().to_string()
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

    let mut results: Vec<(std::time::SystemTime, serde_json::Value)> = Vec::new();

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

        // Decode the directory path from the encoded folder name
        let decoded_dir = decode_project_dir(&encoded_name);

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

            // Read first meaningful user message from JSONL
            let first_msg = std::fs::read_to_string(&fpath)
                .ok()
                .and_then(|content| {
                    for line in content.lines().take(30) {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) {
                            if parsed["type"].as_str() == Some("user") {
                                let content = &parsed["message"]["content"];
                                if let Some(text) = content.as_str() {
                                    if text.len() > 20 && !text.contains("command-name") && !text.contains("local-command") {
                                        return Some(text.chars().take(150).collect::<String>());
                                    }
                                }
                                if let Some(arr) = content.as_array() {
                                    for block in arr {
                                        if block["type"].as_str() == Some("text") {
                                            if let Some(t) = block["text"].as_str() {
                                                if t.len() > 20 && !t.contains("command-name") && !t.contains("local-command") {
                                                    return Some(t.chars().take(150).collect::<String>());
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    None
                })
                .unwrap_or_default();

            results.push((modified, serde_json::json!({
                "id": session_id,
                "path": project_name,
                "directory": decoded_dir,
                "lastModified": last_modified,
                "sizeBytes": size_bytes,
                "firstMessage": first_msg,
            })));
        }
    }

    // Sort by most recent first — return all (frontend filters by directory)
    results.sort_by(|a, b| b.0.cmp(&a.0));
    let entries: Vec<serde_json::Value> = results.into_iter().map(|(_, v)| v).collect();
    Ok(entries)
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

/// Scan the Claude Code binary for built-in slash commands.
/// Extracts from the command registration pattern: name:"cmd",description:"..."
#[tauri::command]
pub async fn discover_builtin_commands() -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(discover_builtin_commands_sync)
        .await
        .map_err(|e| e.to_string())?
}

fn discover_builtin_commands_sync() -> Result<Vec<serde_json::Value>, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let versions_dir = home.join(".local").join("share").join("claude").join("versions");
    if !versions_dir.exists() {
        return Ok(Vec::new());
    }

    let mut versions: Vec<_> = std::fs::read_dir(&versions_dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    versions.sort();

    let binary_path = match versions.last() {
        Some(v) => versions_dir.join(v),
        None => return Ok(Vec::new()),
    };

    let content = match std::fs::read(&binary_path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
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
        let desc = desc_raw.replace("\\n", " ").chars().take(120).collect::<String>();
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
                                    .map(|s| s.trim().to_string());
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
    let encoded = crate::jsonl_watcher::encode_dir_pub(&working_dir);
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
            // Array content (text blocks)
            if let Some(arr) = msg_content.as_array() {
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
        args.push(config.working_dir.clone());
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
        for settings_name in &["settings.local.json", "settings.json"] {
            let settings_path = dir_path.join(".claude").join(settings_name);
            if let Ok(content) = std::fs::read_to_string(&settings_path) {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(hooks) = parsed.get("hooks") {
                        let key = format!("project:{}", dir);
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

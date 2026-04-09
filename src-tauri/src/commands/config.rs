use super::data::get_data_dir;
use crate::observability::record_backend_event;
use serde_json::json;
use tauri::AppHandle;

fn log_discovery(app: &AppHandle, event: &str, message: &str, data: serde_json::Value) {
    record_backend_event(app, "LOG", "discovery", None, event, message, data);
}

/// Read the UI config file. Returns the content or empty string if not found.
#[tauri::command]
pub fn read_ui_config(app: AppHandle) -> Result<String, String> {
    let data_dir = get_data_dir()?;
    let path = data_dir.join("ui-config.json");

    if !path.exists() {
        log_discovery(
            &app,
            "discovery.ui_config_read",
            "UI config file does not exist yet",
            json!({
                "path": path.to_string_lossy().to_string(),
                "exists": false,
            }),
        );
        return Ok(String::new());
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read ui-config.json: {}", e))?;
    log_discovery(
        &app,
        "discovery.ui_config_read",
        "UI config file read",
        json!({
            "path": path.to_string_lossy().to_string(),
            "exists": true,
            "contentLength": content.len(),
        }),
    );
    Ok(content)
}

/// Write the UI config file (used to create defaults).
#[tauri::command]
pub fn write_ui_config(config_json: String) -> Result<(), String> {
    let data_dir = get_data_dir()?;
    let path = data_dir.join("ui-config.json");
    std::fs::write(&path, config_json).map_err(|e| format!("Failed to write ui-config.json: {}", e))
}

/// Discover hooks from Claude Code settings files.
/// Reads from (in priority order):
/// 1. Project .claude/settings.local.json
/// 2. Project .claude/settings.json
/// 3. User ~/.claude/settings.json
// [RC-10] Hook configuration: discover_hooks / save_hooks (merges into existing settings)
#[tauri::command]
pub fn discover_hooks(
    app: AppHandle,
    working_dirs: Vec<String>,
) -> Result<serde_json::Value, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let mut all_hooks = serde_json::Map::new();
    let mut scanned_files: Vec<String> = Vec::new();

    // User-level hooks
    let user_settings = home.join(".claude").join("settings.json");
    if let Ok(content) = std::fs::read_to_string(&user_settings) {
        scanned_files.push(user_settings.to_string_lossy().to_string());
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
                scanned_files.push(settings_path.to_string_lossy().to_string());
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(hooks) = parsed.get("hooks") {
                        // [HM-02] Scope-prefixed keys keep project and project-local hooks distinct.
                        let key = format!("{}:{}", prefix, dir);
                        all_hooks.insert(key, hooks.clone());
                    }
                }
            }
        }
    }

    log_discovery(
        &app,
        "discovery.hooks_loaded",
        "Hook discovery completed",
        json!({
            "workingDirs": working_dirs,
            "scannedFiles": scanned_files,
            "scopeCount": all_hooks.len(),
            "scopes": all_hooks.keys().cloned().collect::<Vec<_>>(),
        }),
    );

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
        "project" => std::path::Path::new(&working_dir)
            .join(".claude")
            .join("settings.json"),
        "project-local" => std::path::Path::new(&working_dir)
            .join(".claude")
            .join("settings.local.json"),
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

/// Validate a markdown file name — only alphanumeric, hyphens, underscores.
fn validate_md_file_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Name cannot be empty".into());
    }
    if !name
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!(
            "Invalid name '{}': only alphanumeric, hyphens, underscores allowed",
            name
        ));
    }
    Ok(())
}

/// Resolve the path for a config file based on scope and file type.
fn resolve_config_path(
    scope: &str,
    working_dir: &str,
    file_type: &str,
) -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;

    match file_type {
        "settings" => match scope {
            "user" => Ok(home.join(".claude").join("settings.json")),
            "project" => Ok(std::path::Path::new(working_dir)
                .join(".claude")
                .join("settings.json")),
            "project-local" => Ok(std::path::Path::new(working_dir)
                .join(".claude")
                .join("settings.local.json")),
            _ => Err("Invalid scope".into()),
        },
        "claudemd-user" => Ok(home.join(".claude").join("CLAUDE.md")),
        "claudemd-root" => Ok(std::path::Path::new(working_dir).join("CLAUDE.md")),
        "claudemd-local" => Ok(std::path::Path::new(working_dir).join("CLAUDE.local.md")),
        _ if file_type.starts_with("agent:") || file_type.starts_with("agent-delete:") => {
            let name = file_type.split_once(':').map(|(_, n)| n).unwrap_or("");
            validate_md_file_name(name)?;
            match scope {
                "user" => Ok(home
                    .join(".claude")
                    .join("agents")
                    .join(format!("{}.md", name))),
                "project" => Ok(std::path::Path::new(working_dir)
                    .join(".claude")
                    .join("agents")
                    .join(format!("{}.md", name))),
                _ => Err("Invalid scope".into()),
            }
        }
        _ if file_type.starts_with("skill:") || file_type.starts_with("skill-delete:") => {
            let name = file_type.split_once(':').map(|(_, n)| n).unwrap_or("");
            validate_md_file_name(name)?;
            match scope {
                "user" => Ok(home
                    .join(".claude")
                    .join("commands")
                    .join(format!("{}.md", name))),
                "project" => Ok(std::path::Path::new(working_dir)
                    .join(".claude")
                    .join("commands")
                    .join(format!("{}.md", name))),
                _ => Err("Invalid scope".into()),
            }
        }
        _ => Err(format!("Unknown file_type: {}", file_type)),
    }
}

// [RC-12] Config files read/write: settings JSON, CLAUDE.md (3 scopes), agent/skill files
// [CM-08] JSON validated before write, parent dirs auto-created
/// Read a config file. Returns content or empty string if not found.
#[tauri::command]
pub fn read_config_file(
    scope: String,
    working_dir: String,
    file_type: String,
) -> Result<String, String> {
    let path = resolve_config_path(&scope, &working_dir, &file_type)?;
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path.display(), e))
}

/// Write a config file. Creates parent directories if needed.
/// For settings files, validates JSON. For agent-delete, deletes the file.
#[tauri::command]
pub fn write_config_file(
    scope: String,
    working_dir: String,
    file_type: String,
    content: String,
) -> Result<(), String> {
    // Handle agent/skill deletion
    if file_type.starts_with("agent-delete:") || file_type.starts_with("skill-delete:") {
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

    std::fs::write(&path, &content)
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

/// Merge, dedupe, sort, and write event kind strings to src/types/eventKinds.json.
/// Resolves the repo root from CARGO_MANIFEST_DIR (compile-time), falling back to `project_root` arg.
#[tauri::command]
pub fn save_event_kinds(project_root: String, kinds: Vec<String>) -> Result<(), String> {
    // In dev builds, CARGO_MANIFEST_DIR points to src-tauri/; parent is the repo root.
    // In release builds, fall back to the provided project_root.
    let root = option_env!("CARGO_MANIFEST_DIR")
        .map(|d| {
            std::path::Path::new(d)
                .parent()
                .unwrap_or(std::path::Path::new(d))
                .to_path_buf()
        })
        .unwrap_or_else(|| std::path::PathBuf::from(&project_root));
    let path = root.join("src").join("types").join("eventKinds.json");

    // Merge with existing file content
    let mut all: Vec<String> = kinds;
    if path.exists() {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
        if let Ok(existing) = serde_json::from_str::<Vec<String>>(&content) {
            all.extend(existing);
        }
    }

    // Dedupe + sort
    all.sort();
    all.dedup();

    let json =
        serde_json::to_string_pretty(&all).map_err(|e| format!("Failed to serialize: {}", e))?;

    std::fs::write(&path, json + "\n")
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

/// List .md files in a directory, returning sorted [{name, path}].
fn list_md_in_dir(dir: &std::path::Path) -> Vec<serde_json::Value> {
    if !dir.exists() {
        return Vec::new();
    }
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("md") {
                let name = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                if !name.is_empty() {
                    files.push(serde_json::json!({
                        "name": name,
                        "path": path.to_string_lossy().to_string(),
                    }));
                }
            }
        }
    }
    files.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .cmp(b["name"].as_str().unwrap_or(""))
    });
    files
}

/// List agent definition files based on scope.
#[tauri::command]
pub fn list_agents(
    app: AppHandle,
    scope: String,
    working_dir: String,
) -> Result<Vec<serde_json::Value>, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let dir = match scope.as_str() {
        "user" => home.join(".claude").join("agents"),
        "project" => std::path::Path::new(&working_dir)
            .join(".claude")
            .join("agents"),
        _ => return Err("Invalid scope".into()),
    };
    let files = list_md_in_dir(&dir);
    log_discovery(
        &app,
        "discovery.agent_files_loaded",
        "Agent definitions listed",
        json!({
            "scope": scope,
            "workingDir": working_dir,
            "dir": dir.to_string_lossy().to_string(),
            "count": files.len(),
            "names": files.iter().filter_map(|file| file["name"].as_str()).collect::<Vec<_>>(),
        }),
    );
    Ok(files)
}

/// List skill/command definition files based on scope.
#[tauri::command]
pub fn list_skills(
    app: AppHandle,
    scope: String,
    working_dir: String,
) -> Result<Vec<serde_json::Value>, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let dir = match scope.as_str() {
        "user" => home.join(".claude").join("commands"),
        "project" => std::path::Path::new(&working_dir)
            .join(".claude")
            .join("commands"),
        _ => return Err("Invalid scope".into()),
    };
    let files = list_md_in_dir(&dir);
    log_discovery(
        &app,
        "discovery.skill_files_loaded",
        "Skill definitions listed",
        json!({
            "scope": scope,
            "workingDir": working_dir,
            "dir": dir.to_string_lossy().to_string(),
            "count": files.len(),
            "names": files.iter().filter_map(|file| file["name"].as_str()).collect::<Vec<_>>(),
        }),
    );
    Ok(files)
}

// [RC-20] Hardcoded DNS resolution of api.anthropic.com, 5s timeout, no user input
/// Resolve api.anthropic.com to its IP address (Cloudflare edge).
/// Hardcoded hostname — no user-supplied input. 5s timeout.
#[tauri::command]
pub async fn resolve_api_host(app: AppHandle) -> Result<String, String> {
    let resolved = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::task::spawn_blocking(|| {
            use std::net::ToSocketAddrs;
            "api.anthropic.com:443"
                .to_socket_addrs()
                .map_err(|e| e.to_string())?
                .next()
                .map(|a| a.ip().to_string())
                .ok_or_else(|| "No addresses found".to_string())
        }),
    )
    .await
    .map_err(|_| "DNS lookup timed out".to_string())?
    .map_err(|e| e.to_string())??;
    log_discovery(
        &app,
        "discovery.api_host_resolved",
        "Resolved api.anthropic.com",
        json!({
            "host": "api.anthropic.com",
            "ip": resolved,
        }),
    );
    Ok(resolved)
}

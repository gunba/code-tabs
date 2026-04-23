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
            // Format: "skill:<kind>:<name>" or "skill-delete:<kind>:<name>"
            // <kind> is "command" or "skill".
            let rest = file_type.split_once(':').map(|(_, r)| r).unwrap_or("");
            let (kind, name) = rest
                .split_once(':')
                .ok_or_else(|| format!("Invalid file_type '{}': expected '<prefix>:<kind>:<name>'", file_type))?;
            validate_md_file_name(name)?;
            let claude_dir = match scope {
                "user" => home.join(".claude"),
                "project" => std::path::Path::new(working_dir).join(".claude"),
                _ => return Err("Invalid scope".into()),
            };
            match kind {
                "command" => Ok(claude_dir.join("commands").join(format!("{}.md", name))),
                "skill" => Ok(claude_dir.join("skills").join(name).join("SKILL.md")),
                other => Err(format!("Invalid kind '{}': expected 'command' or 'skill'", other)),
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
        // Skills resolve to <skill-dir>/SKILL.md; remove the enclosing directory so we don't
        // leave an empty husk behind. Commands and agents are single .md files.
        let target = if file_type.starts_with("skill-delete:skill:") {
            path.parent().map(|p| p.to_path_buf()).unwrap_or(path)
        } else {
            path
        };
        let result = if target.is_dir() {
            std::fs::remove_dir_all(&target)
        } else {
            std::fs::remove_file(&target)
        };
        if let Err(e) = result {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(format!("Failed to delete {}: {}", target.display(), e));
            }
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

/// List skill directories (subdirectories containing SKILL.md), returning sorted [{name, path}].
fn list_skill_dirs(dir: &std::path::Path) -> Vec<serde_json::Value> {
    if !dir.exists() {
        return Vec::new();
    }
    let mut skills = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let skill_md = path.join("SKILL.md");
            if !skill_md.is_file() {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if name.is_empty() {
                continue;
            }
            skills.push(serde_json::json!({
                "name": name,
                "path": skill_md.to_string_lossy().to_string(),
            }));
        }
    }
    skills.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .cmp(b["name"].as_str().unwrap_or(""))
    });
    skills
}

/// List skill/command definition files based on scope.
/// Returns entries from both `.claude/commands/` (kind=command) and `.claude/skills/` (kind=skill).
#[tauri::command]
pub fn list_skills(
    app: AppHandle,
    scope: String,
    working_dir: String,
) -> Result<Vec<serde_json::Value>, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let claude_dir = match scope.as_str() {
        "user" => home.join(".claude"),
        "project" => std::path::Path::new(&working_dir).join(".claude"),
        _ => return Err("Invalid scope".into()),
    };
    let commands_dir = claude_dir.join("commands");
    let skills_dir = claude_dir.join("skills");

    let mut entries: Vec<serde_json::Value> = Vec::new();
    for mut entry in list_md_in_dir(&commands_dir) {
        entry["kind"] = serde_json::Value::String("command".into());
        entries.push(entry);
    }
    for mut entry in list_skill_dirs(&skills_dir) {
        entry["kind"] = serde_json::Value::String("skill".into());
        entries.push(entry);
    }

    log_discovery(
        &app,
        "discovery.skill_files_loaded",
        "Skill and command definitions listed",
        json!({
            "scope": scope,
            "workingDir": working_dir,
            "commandsDir": commands_dir.to_string_lossy().to_string(),
            "skillsDir": skills_dir.to_string_lossy().to_string(),
            "count": entries.len(),
            "names": entries.iter()
                .map(|e| format!("{}:{}",
                    e["kind"].as_str().unwrap_or(""),
                    e["name"].as_str().unwrap_or("")))
                .collect::<Vec<_>>(),
        }),
    );
    Ok(entries)
}

/// Path to the user-level Claude state file where Claude Code stores `mcpServers`
/// (user-scope at top level, project-scope under `projects.<abs-path>.mcpServers`).
fn claude_json_path() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    Ok(home.join(".claude.json"))
}

fn read_claude_json() -> Result<serde_json::Value, String> {
    let path = claude_json_path()?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    if content.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse {}: {}", path.display(), e))
}

fn extract_mcp_servers(data: &serde_json::Value, scope: &str, working_dir: &str) -> serde_json::Value {
    match scope {
        "user" => data
            .get("mcpServers")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
        "project" => data
            .get("projects")
            .and_then(|p| p.get(working_dir))
            .and_then(|p| p.get("mcpServers"))
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
        _ => serde_json::json!({}),
    }
}

/// Read MCP servers from `~/.claude.json`.
/// - user scope: top-level `mcpServers`
/// - project scope: `projects[<working_dir>].mcpServers`
/// Returns a JSON object string (never null). Empty object `{}` if absent.
#[tauri::command]
pub fn read_mcp_servers(scope: String, working_dir: String) -> Result<String, String> {
    if scope == "project" && working_dir.is_empty() {
        return Err("working_dir required for project scope".into());
    }
    let data = read_claude_json()?;
    let servers = extract_mcp_servers(&data, &scope, &working_dir);
    serde_json::to_string(&servers).map_err(|e| e.to_string())
}

/// Write MCP servers into `~/.claude.json` at the scope-appropriate key.
/// Preserves all other keys in the file and in the project entry.
#[tauri::command]
pub fn write_mcp_servers(
    scope: String,
    working_dir: String,
    servers_json: String,
) -> Result<(), String> {
    if scope == "project" && working_dir.is_empty() {
        return Err("working_dir required for project scope".into());
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&servers_json).map_err(|e| format!("Invalid servers JSON: {}", e))?;
    if !parsed.is_object() {
        return Err("servers_json must be a JSON object".into());
    }
    let is_empty = parsed.as_object().map(|m| m.is_empty()).unwrap_or(true);

    let path = claude_json_path()?;
    let mut data = read_claude_json()?;
    if !data.is_object() {
        data = serde_json::json!({});
    }

    match scope.as_str() {
        "user" => {
            let obj = data.as_object_mut().unwrap();
            if is_empty {
                obj.remove("mcpServers");
            } else {
                obj.insert("mcpServers".into(), parsed);
            }
        }
        "project" => {
            let obj = data.as_object_mut().unwrap();
            let projects = obj
                .entry("projects".to_string())
                .or_insert_with(|| serde_json::json!({}));
            if !projects.is_object() {
                *projects = serde_json::json!({});
            }
            let projects_map = projects.as_object_mut().unwrap();
            let entry = projects_map
                .entry(working_dir.clone())
                .or_insert_with(|| serde_json::json!({}));
            if !entry.is_object() {
                *entry = serde_json::json!({});
            }
            let entry_map = entry.as_object_mut().unwrap();
            if is_empty {
                entry_map.remove("mcpServers");
            } else {
                entry_map.insert("mcpServers".into(), parsed);
            }
        }
        _ => return Err("Invalid scope".into()),
    }

    let output = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    std::fs::write(&path, output).map_err(|e| format!("Failed to write {}: {}", path.display(), e))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_skill_command_user_scope() {
        let path = resolve_config_path("user", "", "skill:command:foo").unwrap();
        let s = path.to_string_lossy().replace('\\', "/");
        assert!(s.ends_with("/.claude/commands/foo.md"), "got {}", s);
    }

    #[test]
    fn resolve_skill_skill_user_scope() {
        let path = resolve_config_path("user", "", "skill:skill:my-skill").unwrap();
        let s = path.to_string_lossy().replace('\\', "/");
        assert!(s.ends_with("/.claude/skills/my-skill/SKILL.md"), "got {}", s);
    }

    #[test]
    fn resolve_skill_command_project_scope() {
        let path = resolve_config_path("project", "/tmp/proj", "skill:command:bar").unwrap();
        let s = path.to_string_lossy().replace('\\', "/");
        assert!(s.ends_with("/tmp/proj/.claude/commands/bar.md"), "got {}", s);
    }

    #[test]
    fn resolve_skill_delete_skill() {
        let path = resolve_config_path("project", "/tmp/proj", "skill-delete:skill:s1").unwrap();
        let s = path.to_string_lossy().replace('\\', "/");
        assert!(s.ends_with("/tmp/proj/.claude/skills/s1/SKILL.md"), "got {}", s);
    }

    #[test]
    fn resolve_skill_invalid_kind() {
        let err = resolve_config_path("user", "", "skill:bogus:foo").unwrap_err();
        assert!(err.contains("Invalid kind"), "got {}", err);
    }

    #[test]
    fn resolve_skill_missing_kind() {
        // Old format ("skill:foo") should be rejected now.
        let err = resolve_config_path("user", "", "skill:foo").unwrap_err();
        assert!(err.contains("Invalid kind") || err.contains("expected"), "got {}", err);
    }

    #[test]
    fn resolve_skill_unsafe_name() {
        let err = resolve_config_path("user", "", "skill:command:../etc").unwrap_err();
        assert!(err.contains("Invalid name"), "got {}", err);
    }

    #[test]
    fn list_skill_dirs_finds_subdirs_with_skill_md() {
        let tmp = std::env::temp_dir().join(format!("ct_test_{}", std::process::id()));
        let skills_root = tmp.join("skills");
        std::fs::create_dir_all(skills_root.join("alpha")).unwrap();
        std::fs::create_dir_all(skills_root.join("beta")).unwrap();
        std::fs::create_dir_all(skills_root.join("no-skill-md")).unwrap();
        std::fs::write(skills_root.join("alpha").join("SKILL.md"), "x").unwrap();
        std::fs::write(skills_root.join("beta").join("SKILL.md"), "y").unwrap();
        // no-skill-md has no SKILL.md so should be skipped

        let result = list_skill_dirs(&skills_root);
        let names: Vec<&str> = result.iter().filter_map(|v| v["name"].as_str()).collect();
        assert_eq!(names, vec!["alpha", "beta"]);
        for v in &result {
            let p = v["path"].as_str().unwrap();
            assert!(p.ends_with("SKILL.md"), "path should be SKILL.md: {}", p);
        }

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn list_skill_dirs_missing_dir_returns_empty() {
        let missing = std::env::temp_dir().join(format!("ct_no_such_{}", std::process::id()));
        assert!(list_skill_dirs(&missing).is_empty());
    }

    #[test]
    fn extract_mcp_user_scope_returns_top_level() {
        let data = serde_json::json!({
            "mcpServers": { "ato": { "command": "ato-mcp", "args": ["serve"] } },
            "projects": { "/tmp/p": { "mcpServers": { "other": { "command": "x" } } } },
        });
        let got = extract_mcp_servers(&data, "user", "");
        assert_eq!(
            got,
            serde_json::json!({ "ato": { "command": "ato-mcp", "args": ["serve"] } })
        );
    }

    #[test]
    fn extract_mcp_project_scope_returns_project_entry() {
        let data = serde_json::json!({
            "mcpServers": { "user-only": { "command": "x" } },
            "projects": { "/tmp/p": { "mcpServers": { "proj": { "command": "y" } } } },
        });
        let got = extract_mcp_servers(&data, "project", "/tmp/p");
        assert_eq!(got, serde_json::json!({ "proj": { "command": "y" } }));
    }

    #[test]
    fn extract_mcp_missing_keys_yield_empty_object() {
        let data = serde_json::json!({});
        assert_eq!(extract_mcp_servers(&data, "user", ""), serde_json::json!({}));
        assert_eq!(
            extract_mcp_servers(&data, "project", "/tmp/p"),
            serde_json::json!({})
        );
    }

    #[test]
    fn extract_mcp_project_scope_unknown_dir_yields_empty() {
        let data = serde_json::json!({
            "projects": { "/tmp/other": { "mcpServers": { "x": {} } } },
        });
        let got = extract_mcp_servers(&data, "project", "/tmp/p");
        assert_eq!(got, serde_json::json!({}));
    }
}

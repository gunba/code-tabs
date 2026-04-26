use super::data::get_data_dir;
use crate::observability::record_backend_event;
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Manager};

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

// [CD-01] codex_config_path / codex_hooks_json_path / read_codex_config_value / write_codex_config_value (atomic TOML); file_type variants codex-config, agentsmd-*, codex-skill[-delete]:
fn codex_config_path(scope: &str, working_dir: &str) -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    match scope {
        "user" => Ok(home.join(".codex").join("config.toml")),
        "project" => {
            if working_dir.is_empty() {
                return Err("working_dir required for project scope".into());
            }
            Ok(std::path::Path::new(working_dir)
                .join(".codex")
                .join("config.toml"))
        }
        _ => Err("Invalid scope".into()),
    }
}

fn codex_hooks_json_path(scope: &str, working_dir: &str) -> Result<std::path::PathBuf, String> {
    let config_path = codex_config_path(scope, working_dir)?;
    Ok(config_path
        .parent()
        .ok_or("config path has no parent")?
        .join("hooks.json"))
}

fn read_codex_config_value(path: &std::path::Path) -> Result<toml::Value, String> {
    if !path.exists() {
        return Ok(toml::Value::Table(toml::value::Table::new()));
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    if raw.trim().is_empty() {
        return Ok(toml::Value::Table(toml::value::Table::new()));
    }
    toml::from_str(&raw).map_err(|e| format!("Invalid TOML in {}: {}", path.display(), e))
}

fn write_codex_config_value(path: &std::path::Path, value: &toml::Value) -> Result<(), String> {
    let output =
        toml::to_string_pretty(value).map_err(|e| format!("Failed to serialize TOML: {e}"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    atomic_write(path, output.as_bytes())
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

fn json_to_toml_value(v: serde_json::Value) -> Option<toml::Value> {
    match v {
        // TOML has no null. Dropping is safer than coercing to "" because
        // explicit-null env vars / optional hook fields would otherwise
        // round-trip into empty strings.
        serde_json::Value::Null => None,
        serde_json::Value::Bool(b) => Some(toml::Value::Boolean(b)),
        serde_json::Value::Number(n) => Some(if let Some(i) = n.as_i64() {
            toml::Value::Integer(i)
        } else if let Some(f) = n.as_f64() {
            toml::Value::Float(f)
        } else {
            toml::Value::String(n.to_string())
        }),
        serde_json::Value::String(s) => Some(toml::Value::String(s)),
        serde_json::Value::Array(a) => Some(toml::Value::Array(
            a.into_iter().filter_map(json_to_toml_value).collect(),
        )),
        serde_json::Value::Object(o) => {
            let mut table = toml::value::Table::new();
            for (k, v) in o {
                if let Some(value) = json_to_toml_value(v) {
                    table.insert(k, value);
                }
            }
            Some(toml::Value::Table(table))
        }
    }
}

fn toml_value_to_json(v: toml::Value) -> serde_json::Value {
    serde_json::to_value(v).unwrap_or_else(|_| serde_json::json!({}))
}

fn merge_hook_values(base: &mut serde_json::Value, incoming: serde_json::Value) {
    let Some(base_obj) = base.as_object_mut() else {
        *base = incoming;
        return;
    };
    let Some(incoming_obj) = incoming.as_object() else {
        return;
    };
    for (event_name, event_hooks) in incoming_obj {
        match (base_obj.get_mut(event_name), event_hooks) {
            (Some(serde_json::Value::Array(existing)), serde_json::Value::Array(new_hooks)) => {
                for hook in new_hooks {
                    if !existing.iter().any(|e| e == hook) {
                        existing.push(hook.clone());
                    }
                }
            }
            _ => {
                base_obj.insert(event_name.clone(), event_hooks.clone());
            }
        }
    }
}

fn read_codex_hooks_for_scope(scope: &str, working_dir: &str) -> Result<serde_json::Value, String> {
    let config_path = codex_config_path(scope, working_dir)?;
    let hooks_json_path = codex_hooks_json_path(scope, working_dir)?;
    let mut hooks = serde_json::json!({});

    let config = read_codex_config_value(&config_path)?;
    if let Some(inline_hooks) = config.get("hooks").cloned() {
        hooks = toml_value_to_json(inline_hooks);
    }

    if hooks_json_path.exists() {
        let raw = std::fs::read_to_string(&hooks_json_path)
            .map_err(|e| format!("Failed to read {}: {}", hooks_json_path.display(), e))?;
        if !raw.trim().is_empty() {
            let parsed: serde_json::Value = serde_json::from_str(&raw)
                .map_err(|e| format!("Invalid JSON in {}: {}", hooks_json_path.display(), e))?;
            let incoming = parsed.get("hooks").cloned().unwrap_or(parsed);
            merge_hook_values(&mut hooks, incoming);
        }
    }

    Ok(hooks)
}

// [CH-01] discover_codex_hooks merges config.toml [hooks] + hooks.json (array-extend); save_codex_hooks writes ONLY to config.toml [hooks] and force-sets features.codex_hooks=true. KNOWN BUG: save->reload doubles hooks.json entries.
#[tauri::command]
pub fn discover_codex_hooks(
    app: AppHandle,
    working_dirs: Vec<String>,
) -> Result<serde_json::Value, String> {
    let mut all_hooks = serde_json::Map::new();
    let mut scanned_files: Vec<String> = Vec::new();

    if let Ok(path) = codex_config_path("user", "") {
        scanned_files.push(path.to_string_lossy().to_string());
        if let Ok(json_path) = codex_hooks_json_path("user", "") {
            scanned_files.push(json_path.to_string_lossy().to_string());
        }
    }
    let user_hooks = read_codex_hooks_for_scope("user", "")?;
    if !user_hooks.as_object().map(|m| m.is_empty()).unwrap_or(true) {
        all_hooks.insert("user".to_string(), user_hooks);
    }

    for dir in &working_dirs {
        if let Ok(path) = codex_config_path("project", dir) {
            scanned_files.push(path.to_string_lossy().to_string());
            if let Ok(json_path) = codex_hooks_json_path("project", dir) {
                scanned_files.push(json_path.to_string_lossy().to_string());
            }
        }
        let project_hooks = read_codex_hooks_for_scope("project", dir)?;
        if !project_hooks
            .as_object()
            .map(|m| m.is_empty())
            .unwrap_or(true)
        {
            all_hooks.insert(format!("project:{}", dir), project_hooks);
        }
    }

    log_discovery(
        &app,
        "discovery.codex_hooks_loaded",
        "Codex hook discovery completed",
        json!({
            "workingDirs": working_dirs,
            "scannedFiles": scanned_files,
            "scopeCount": all_hooks.len(),
            "scopes": all_hooks.keys().cloned().collect::<Vec<_>>(),
        }),
    );

    Ok(serde_json::Value::Object(all_hooks))
}

#[tauri::command]
pub fn save_codex_hooks(
    scope: String,
    working_dir: String,
    hooks_json: String,
) -> Result<(), String> {
    let path = codex_config_path(&scope, &working_dir)?;
    let mut config = read_codex_config_value(&path)?;
    let table = config
        .as_table_mut()
        .ok_or("Codex config root is not a table")?;

    let hooks: serde_json::Value = serde_json::from_str(&hooks_json).map_err(|e| e.to_string())?;
    if let Some(hooks_toml) = json_to_toml_value(hooks) {
        table.insert("hooks".to_string(), hooks_toml);
    } else {
        table.remove("hooks");
    }

    let needs_feature_flag = !table
        .get("features")
        .and_then(|f| f.as_table())
        .and_then(|f| f.get("codex_hooks"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if needs_feature_flag {
        let features = table
            .entry("features".to_string())
            .or_insert_with(|| toml::Value::Table(toml::value::Table::new()))
            .as_table_mut()
            .ok_or("features is not a table")?;
        features.insert("codex_hooks".to_string(), toml::Value::Boolean(true));
    }

    write_codex_config_value(&path, &config)?;

    let hooks_json_path = codex_hooks_json_path(&scope, &working_dir)?;
    if hooks_json_path.exists() {
        atomic_write(&hooks_json_path, b"{}")
            .map_err(|e| format!("Failed to clear {}: {}", hooks_json_path.display(), e))?;
    }

    Ok(())
}

// [CD-02] Codex spawn-env sidecar (~/.config or %APPDATA%/code-tabs/codex-spawn-env/<scope>.json). Stores per-scope env vars Code Tabs injects when launching Codex; sidecar lives in Code Tabs appdata (NOT in project tree) so OPENAI_API_KEY etc. don't leak into git.
//
// File layout: { "project_root": "/abs/path", "env": { "KEY": "value" } }.
// Scope precedence at spawn time: project-local > project > user (later wins).
fn codex_spawn_env_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve appdata dir: {e}"))?;
    let dir = base.join("codex-spawn-env");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;
    Ok(dir)
}

fn project_hash(working_dir: &str) -> String {
    use sha2::{Digest, Sha256};
    let canonical = std::fs::canonicalize(working_dir)
        .ok()
        .and_then(|p| p.to_str().map(|s| s.to_string()))
        .unwrap_or_else(|| working_dir.to_string());
    let hash = Sha256::digest(canonical.as_bytes());
    let hex = format!("{:x}", hash);
    hex.chars().take(16).collect()
}

fn codex_spawn_env_file(
    app: &AppHandle,
    scope: &str,
    working_dir: &str,
) -> Result<std::path::PathBuf, String> {
    let dir = codex_spawn_env_dir(app)?;
    match scope {
        "user" => Ok(dir.join("user.json")),
        "project" => {
            if working_dir.is_empty() {
                return Err("working_dir required for project scope".into());
            }
            Ok(dir.join(format!("project-{}.json", project_hash(working_dir))))
        }
        "project-local" => {
            if working_dir.is_empty() {
                return Err("working_dir required for project-local scope".into());
            }
            Ok(dir.join(format!("project-local-{}.json", project_hash(working_dir))))
        }
        _ => Err(format!("Invalid scope: {scope}")),
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct CodexSpawnEnvFile {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub project_root: String,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
}

fn read_codex_spawn_env_file(path: &std::path::Path) -> CodexSpawnEnvFile {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return CodexSpawnEnvFile::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

#[tauri::command]
pub fn read_codex_spawn_env(
    app: AppHandle,
    scope: String,
    working_dir: String,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    let path = codex_spawn_env_file(&app, &scope, &working_dir)?;
    Ok(read_codex_spawn_env_file(&path).env)
}

#[tauri::command]
pub fn write_codex_spawn_env(
    app: AppHandle,
    scope: String,
    working_dir: String,
    env: std::collections::BTreeMap<String, String>,
) -> Result<(), String> {
    let path = codex_spawn_env_file(&app, &scope, &working_dir)?;
    let project_root = if scope == "user" {
        String::new()
    } else {
        std::fs::canonicalize(&working_dir)
            .ok()
            .and_then(|p| p.to_str().map(|s| s.to_string()))
            .unwrap_or(working_dir)
    };
    let payload = CodexSpawnEnvFile { project_root, env };
    let serialized = serde_json::to_string_pretty(&payload)
        .map_err(|e| format!("Failed to serialize spawn env: {e}"))?;
    atomic_write(&path, serialized.as_bytes())
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

/// Read all spawn-env scopes for a project and merge them in precedence
/// order (project-local > project > user; later wins). Used by the Codex
/// CLI adapter at session launch.
pub fn merged_codex_spawn_env(
    app: &AppHandle,
    working_dir: &str,
) -> std::collections::BTreeMap<String, String> {
    let mut merged: std::collections::BTreeMap<String, String> = Default::default();
    for scope in ["user", "project", "project-local"] {
        let needs_dir = matches!(scope, "project" | "project-local");
        if needs_dir && working_dir.is_empty() {
            continue;
        }
        let Ok(path) = codex_spawn_env_file(app, scope, working_dir) else {
            continue;
        };
        let contents = read_codex_spawn_env_file(&path);
        for (k, v) in contents.env {
            merged.insert(k, v);
        }
    }
    merged
}

// [CD-03] insert_codex_toml_key: format-preserving insert via toml_edit. Creates intermediate tables for dotted paths (`shell_environment_policy.inherit`); never overwrites an existing key (returns the original content unchanged); does not handle array-of-tables paths (use insert_codex_toml_array_entry for that).
/// Insert a JSON-shaped value at the given dotted TOML path, preserving
/// whitespace, comments, and key order in the surrounding file. Existing
/// keys are NOT overwritten — the original content is returned unchanged so
/// the user's existing value isn't clobbered. Use this for the click-to-
/// insert path in the Codex Settings reference panel.
///
/// Limitations:
///   * Inserting into an inline table (`tools = { ... }`) silently expands
///     it to standard table form.
///   * `[[arrays.of.tables]]` aren't supported here — use
///     `insert_codex_toml_array_entry`.
///   * New keys are appended at the end of an existing table; comments
///     anchored to the table tail can become visually orphaned.
#[tauri::command]
pub fn insert_codex_toml_key(
    content: String,
    key_path: Vec<String>,
    value: serde_json::Value,
) -> Result<String, String> {
    if key_path.is_empty() {
        return Err("key_path must have at least one segment".into());
    }
    let mut doc = if content.trim().is_empty() {
        toml_edit::DocumentMut::new()
    } else {
        content
            .parse::<toml_edit::DocumentMut>()
            .map_err(|e| format!("Existing TOML is invalid: {e}"))?
    };

    let toml_value = json_to_toml_edit_item(value)
        .ok_or_else(|| "value is null; TOML has no null type".to_string())?;

    // Walk to the parent table, creating intermediate tables as needed.
    let (last, parents) = key_path.split_last().unwrap(); // checked above
    let mut cursor: &mut toml_edit::Item = doc.as_item_mut();
    for segment in parents {
        let table = cursor
            .as_table_mut()
            .ok_or_else(|| format!("path traverses a non-table at `{segment}`"))?;
        if !table.contains_key(segment) {
            table.insert(segment, toml_edit::Item::Table(toml_edit::Table::new()));
        }
        cursor = &mut table[segment];
    }

    let parent_table = cursor
        .as_table_mut()
        .ok_or_else(|| format!("parent of `{last}` is not a table"))?;
    if parent_table.contains_key(last) {
        // Don't clobber existing values.
        return Ok(content);
    }
    parent_table.insert(last, toml_value);
    Ok(doc.to_string())
}

/// Append a JSON object to a TOML array-of-tables path (`[[a.b.c]]`).
/// Wired for the future MCP-server / profile flows; not surfaced in the v1
/// Settings UI (those entries already live in dedicated panes).
#[tauri::command]
pub fn insert_codex_toml_array_entry(
    content: String,
    table_path: Vec<String>,
    entry: serde_json::Value,
) -> Result<String, String> {
    if table_path.is_empty() {
        return Err("table_path must have at least one segment".into());
    }
    let mut doc = if content.trim().is_empty() {
        toml_edit::DocumentMut::new()
    } else {
        content
            .parse::<toml_edit::DocumentMut>()
            .map_err(|e| format!("Existing TOML is invalid: {e}"))?
    };

    let entry_table = match json_to_toml_edit_item(entry) {
        Some(toml_edit::Item::Value(toml_edit::Value::InlineTable(it))) => it.into_table(),
        Some(toml_edit::Item::Table(t)) => t,
        Some(_) => return Err("array-of-tables entry must be an object".into()),
        None => return Err("entry is null".into()),
    };

    let (last, parents) = table_path.split_last().unwrap();
    let mut cursor: &mut toml_edit::Item = doc.as_item_mut();
    for segment in parents {
        let table = cursor
            .as_table_mut()
            .ok_or_else(|| format!("path traverses a non-table at `{segment}`"))?;
        if !table.contains_key(segment) {
            table.insert(segment, toml_edit::Item::Table(toml_edit::Table::new()));
        }
        cursor = &mut table[segment];
    }

    let parent_table = cursor
        .as_table_mut()
        .ok_or_else(|| format!("parent of `{last}` is not a table"))?;
    let array = if parent_table.contains_key(last) {
        parent_table[last]
            .as_array_of_tables_mut()
            .ok_or_else(|| format!("`{last}` exists but is not an array of tables"))?
    } else {
        parent_table.insert(last, toml_edit::Item::ArrayOfTables(toml_edit::ArrayOfTables::new()));
        parent_table[last].as_array_of_tables_mut().unwrap()
    };
    array.push(entry_table);
    Ok(doc.to_string())
}

/// Convert a serde_json value to a `toml_edit::Item`. Returns `None` for
/// JSON `null` (TOML has no null). Used by both insert helpers.
fn json_to_toml_edit_item(value: serde_json::Value) -> Option<toml_edit::Item> {
    use toml_edit::value as tev;
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::Bool(b) => Some(tev(b)),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(tev(i))
            } else if let Some(f) = n.as_f64() {
                Some(tev(f))
            } else {
                Some(tev(n.to_string()))
            }
        }
        serde_json::Value::String(s) => Some(tev(s)),
        serde_json::Value::Array(items) => {
            let mut arr = toml_edit::Array::new();
            for item in items {
                let Some(toml_item) = json_to_toml_edit_item(item) else { continue; };
                if let toml_edit::Item::Value(v) = toml_item {
                    arr.push(v);
                }
            }
            Some(toml_edit::Item::Value(toml_edit::Value::Array(arr)))
        }
        serde_json::Value::Object(map) => {
            let mut table = toml_edit::Table::new();
            for (k, v) in map {
                if let Some(item) = json_to_toml_edit_item(v) {
                    table.insert(&k, item);
                }
            }
            Some(toml_edit::Item::Table(table))
        }
    }
}

/// Resolve the path for a config file based on scope and file type.
fn resolve_config_path(
    scope: &str,
    working_dir: &str,
    file_type: &str,
) -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;

    match file_type {
        "codex-config" => codex_config_path(scope, working_dir),
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
        "agentsmd-user" => Ok(home.join(".codex").join("AGENTS.md")),
        "agentsmd-root" => Ok(std::path::Path::new(working_dir).join("AGENTS.md")),
        "agentsmd-local" => Ok(std::path::Path::new(working_dir).join("AGENTS.local.md")),
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
            let (kind, name) = rest.split_once(':').ok_or_else(|| {
                format!(
                    "Invalid file_type '{}': expected '<prefix>:<kind>:<name>'",
                    file_type
                )
            })?;
            validate_md_file_name(name)?;
            let claude_dir = match scope {
                "user" => home.join(".claude"),
                "project" => std::path::Path::new(working_dir).join(".claude"),
                _ => return Err("Invalid scope".into()),
            };
            match kind {
                "command" => Ok(claude_dir.join("commands").join(format!("{}.md", name))),
                "skill" => Ok(claude_dir.join("skills").join(name).join("SKILL.md")),
                other => Err(format!(
                    "Invalid kind '{}': expected 'command' or 'skill'",
                    other
                )),
            }
        }
        _ if file_type.starts_with("codex-skill:")
            || file_type.starts_with("codex-skill-delete:") =>
        {
            let name = file_type.split_once(':').map(|(_, n)| n).unwrap_or("");
            validate_md_file_name(name)?;
            match scope {
                "user" => Ok(home
                    .join(".agents")
                    .join("skills")
                    .join(name)
                    .join("SKILL.md")),
                "project" => Ok(std::path::Path::new(working_dir)
                    .join(".agents")
                    .join("skills")
                    .join(name)
                    .join("SKILL.md")),
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
    if file_type.starts_with("agent-delete:")
        || file_type.starts_with("skill-delete:")
        || file_type.starts_with("codex-skill-delete:")
    {
        let path = resolve_config_path(&scope, &working_dir, &file_type)?;
        // Skills resolve to <skill-dir>/SKILL.md; remove the enclosing directory so we don't
        // leave an empty husk behind. Commands and agents are single .md files.
        let target = if file_type.starts_with("skill-delete:skill:")
            || file_type.starts_with("codex-skill-delete:")
        {
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
    if file_type == "codex-config" {
        toml::from_str::<toml::Value>(&content).map_err(|e| format!("Invalid TOML: {}", e))?;
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

fn remove_existing_path(path: &std::path::Path) -> Result<(), String> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("Failed to inspect {}: {}", path.display(), e)),
    };
    if meta.is_dir() && !meta.file_type().is_symlink() {
        std::fs::remove_dir_all(path)
            .map_err(|e| format!("Failed to remove {}: {}", path.display(), e))
    } else {
        std::fs::remove_file(path)
            .map_err(|e| format!("Failed to remove {}: {}", path.display(), e))
    }
}

#[cfg(unix)]
fn symlink_file_cross_platform(
    source: &std::path::Path,
    dest: &std::path::Path,
) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, dest)
}

#[cfg(windows)]
fn symlink_file_cross_platform(
    source: &std::path::Path,
    dest: &std::path::Path,
) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(source, dest)
}

#[tauri::command]
pub fn symlink_config_file(
    scope: String,
    working_dir: String,
    source_file_type: String,
    dest_file_type: String,
    overwrite: bool,
) -> Result<(), String> {
    let source = resolve_config_path(&scope, &working_dir, &source_file_type)?;
    let dest = resolve_config_path(&scope, &working_dir, &dest_file_type)?;

    if !source.is_file() {
        return Err(format!("Source file does not exist: {}", source.display()));
    }
    if dest.exists() || std::fs::symlink_metadata(&dest).is_ok() {
        if !overwrite {
            return Err(format!("Destination already exists: {}", dest.display()));
        }
        remove_existing_path(&dest)?;
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }
    symlink_file_cross_platform(&source, &dest).map_err(|e| {
        format!(
            "Failed to symlink {} -> {}: {}",
            dest.display(),
            source.display(),
            e
        )
    })
}

#[derive(Serialize)]
pub struct CopyCliSkillsReport {
    copied: Vec<String>,
    skipped: Vec<String>,
}

fn cli_skill_source_roots(
    cli: &str,
    scope: &str,
    working_dir: &str,
) -> Result<Vec<std::path::PathBuf>, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let roots = match (cli, scope) {
        ("claude", "user") => vec![home.join(".claude").join("skills")],
        ("claude", "project") => vec![std::path::Path::new(working_dir)
            .join(".claude")
            .join("skills")],
        ("codex", "user") => vec![
            home.join(".agents").join("skills"),
            home.join(".codex").join("skills"),
        ],
        ("codex", "project") => vec![
            std::path::Path::new(working_dir)
                .join(".agents")
                .join("skills"),
            std::path::Path::new(working_dir)
                .join(".codex")
                .join("skills"),
        ],
        _ => return Err("Invalid CLI or scope".into()),
    };
    Ok(roots)
}

fn cli_skill_dest_root(
    cli: &str,
    scope: &str,
    working_dir: &str,
) -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    match (cli, scope) {
        ("claude", "user") => Ok(home.join(".claude").join("skills")),
        ("claude", "project") => Ok(std::path::Path::new(working_dir)
            .join(".claude")
            .join("skills")),
        ("codex", "user") => Ok(home.join(".agents").join("skills")),
        ("codex", "project") => Ok(std::path::Path::new(working_dir)
            .join(".agents")
            .join("skills")),
        _ => Err("Invalid CLI or scope".into()),
    }
}

fn discover_copyable_skills(roots: &[std::path::PathBuf]) -> Vec<(String, std::path::PathBuf)> {
    let mut skills = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for root in roots {
        if !root.is_dir() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() || !path.join("SKILL.md").is_file() {
                continue;
            }
            let Some(name) = path
                .file_name()
                .and_then(|s| s.to_str())
                .and_then(safe_skill_segment)
            else {
                continue;
            };
            if seen.insert(name.to_string()) {
                skills.push((name.to_string(), path));
            }
        }
    }
    skills.sort_by(|a, b| a.0.cmp(&b.0));
    skills
}

fn copy_dir_recursive(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dest)
        .map_err(|e| format!("Failed to create {}: {}", dest.display(), e))?;
    let entries =
        std::fs::read_dir(src).map_err(|e| format!("Failed to read {}: {}", src.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        let meta = entry
            .file_type()
            .map_err(|e| format!("Failed to inspect {}: {}", src_path.display(), e))?;
        if meta.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else if meta.is_file() {
            if let Some(parent) = dest_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
            }
            std::fs::copy(&src_path, &dest_path).map_err(|e| {
                format!(
                    "Failed to copy {} to {}: {}",
                    src_path.display(),
                    dest_path.display(),
                    e
                )
            })?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn copy_cli_skills(
    scope: String,
    working_dir: String,
    source_cli: String,
    dest_cli: String,
    overwrite: bool,
) -> Result<CopyCliSkillsReport, String> {
    if source_cli == dest_cli {
        return Err("Source and destination CLI are the same".into());
    }
    if scope == "project" && working_dir.trim().is_empty() {
        return Err("working_dir required for project scope".into());
    }

    let source_roots = cli_skill_source_roots(&source_cli, &scope, &working_dir)?;
    let dest_root = cli_skill_dest_root(&dest_cli, &scope, &working_dir)?;
    let mut copied = Vec::new();
    let mut skipped = Vec::new();

    for (name, source_dir) in discover_copyable_skills(&source_roots) {
        let dest_dir = dest_root.join(&name);
        if dest_dir.exists() {
            if !overwrite {
                skipped.push(name);
                continue;
            }
            remove_existing_path(&dest_dir)?;
        }
        copy_dir_recursive(&source_dir, &dest_dir)?;
        copied.push(name);
    }

    Ok(CopyCliSkillsReport { copied, skipped })
}

#[derive(Serialize)]
pub struct CodexPluginConfigEntry {
    id: String,
    scope: String,
    enabled: bool,
}

fn codex_plugin_entries_for_scope(
    scope: &str,
    working_dir: &str,
) -> Result<Vec<CodexPluginConfigEntry>, String> {
    let path = codex_config_path(scope, working_dir)?;
    let config = read_codex_config_value(&path)?;
    let Some(plugins) = config.get("plugins").and_then(|v| v.as_table()) else {
        return Ok(Vec::new());
    };
    let mut entries = Vec::new();
    for (id, value) in plugins {
        let enabled = value
            .as_bool()
            .or_else(|| {
                value
                    .as_table()
                    .and_then(|t| t.get("enabled"))
                    .and_then(|v| v.as_bool())
            })
            .unwrap_or(true);
        entries.push(CodexPluginConfigEntry {
            id: id.clone(),
            scope: scope.to_string(),
            enabled,
        });
    }
    entries.sort_by(|a, b| a.id.cmp(&b.id).then(a.scope.cmp(&b.scope)));
    Ok(entries)
}

#[tauri::command]
pub fn read_codex_plugins(working_dir: String) -> Result<Vec<CodexPluginConfigEntry>, String> {
    let mut entries = codex_plugin_entries_for_scope("user", "")?;
    if !working_dir.trim().is_empty() {
        entries.extend(codex_plugin_entries_for_scope("project", &working_dir)?);
    }
    entries.sort_by(|a, b| a.id.cmp(&b.id).then(a.scope.cmp(&b.scope)));
    Ok(entries)
}

fn mutate_codex_plugin_config(
    scope: &str,
    working_dir: &str,
    id: &str,
    f: impl FnOnce(&mut toml::value::Table),
) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("Plugin id cannot be empty".into());
    }
    let path = codex_config_path(scope, working_dir)?;
    let mut config = read_codex_config_value(&path)?;
    let root = config
        .as_table_mut()
        .ok_or("Codex config root is not a table")?;
    let plugins = root
        .entry("plugins".to_string())
        .or_insert_with(|| toml::Value::Table(toml::value::Table::new()))
        .as_table_mut()
        .ok_or("plugins is not a table")?;
    f(plugins);
    write_codex_config_value(&path, &config)
}

#[tauri::command]
pub fn set_codex_plugin_enabled(
    id: String,
    scope: String,
    working_dir: String,
    enabled: bool,
) -> Result<(), String> {
    let plugin_id = id.clone();
    mutate_codex_plugin_config(&scope, &working_dir, &id, |plugins| {
        let entry = plugins
            .entry(plugin_id)
            .or_insert_with(|| toml::Value::Table(toml::value::Table::new()));
        if let Some(table) = entry.as_table_mut() {
            table.insert("enabled".to_string(), toml::Value::Boolean(enabled));
        } else {
            let mut table = toml::value::Table::new();
            table.insert("enabled".to_string(), toml::Value::Boolean(enabled));
            *entry = toml::Value::Table(table);
        }
    })
}

#[tauri::command]
pub fn remove_codex_plugin_config(
    id: String,
    scope: String,
    working_dir: String,
) -> Result<(), String> {
    mutate_codex_plugin_config(&scope, &working_dir, &id, |plugins| {
        plugins.remove(&id);
    })
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

// [CS-01] list_codex_skill_files: user=~/.agents/skills, project=<project>/.agents/skills; codex-skill: file_type resolves SKILL.md path
/// List Codex skill directories in the preferred authoring locations.
/// User scope uses `~/.agents/skills`; project scope uses `<project>/.agents/skills`.
#[tauri::command]
pub fn list_codex_skill_files(
    app: AppHandle,
    scope: String,
    working_dir: String,
) -> Result<Vec<serde_json::Value>, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let skills_dir = match scope.as_str() {
        "user" => home.join(".agents").join("skills"),
        "project" => std::path::Path::new(&working_dir)
            .join(".agents")
            .join("skills"),
        _ => return Err("Invalid scope".into()),
    };

    let mut entries: Vec<serde_json::Value> = Vec::new();
    for mut entry in list_skill_dirs(&skills_dir) {
        entry["kind"] = serde_json::Value::String("skill".into());
        entry["cli"] = serde_json::Value::String("codex".into());
        entries.push(entry);
    }

    log_discovery(
        &app,
        "discovery.codex_skill_files_loaded",
        "Codex skill definitions listed",
        json!({
            "scope": scope,
            "workingDir": working_dir,
            "skillsDir": skills_dir.to_string_lossy().to_string(),
            "count": entries.len(),
            "names": entries.iter()
                .filter_map(|e| e["name"].as_str())
                .collect::<Vec<_>>(),
        }),
    );
    Ok(entries)
}

fn canonical_file_string(path: &std::path::Path) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

fn push_existing_file(paths: &mut Vec<String>, path: std::path::PathBuf) {
    if !path.is_file() {
        return;
    }
    let s = canonical_file_string(&path);
    if !paths.iter().any(|p| p == &s) {
        paths.push(s);
    }
}

fn expand_rule_reference(
    raw: &str,
    base_dir: &std::path::Path,
    home: &std::path::Path,
) -> std::path::PathBuf {
    if let Some(rest) = raw.strip_prefix("~/") {
        return home.join(rest);
    }
    let path = std::path::Path::new(raw);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base_dir.join(path)
    }
}

fn rule_import_from_token(token: &str) -> Option<&str> {
    let token = token.trim();
    let raw = token.strip_prefix('@')?;
    let raw = raw.trim_matches(|c: char| {
        matches!(
            c,
            '`' | '"' | '\'' | ')' | '(' | ']' | '[' | '<' | '>' | ',' | ';' | ':'
        )
    });
    if raw.is_empty()
        || raw.starts_with("http://")
        || raw.starts_with("https://")
        || raw.contains('\0')
    {
        None
    } else {
        Some(raw)
    }
}

fn collect_rule_file(
    paths: &mut Vec<String>,
    path: std::path::PathBuf,
    home: &std::path::Path,
    visited: &mut std::collections::HashSet<String>,
    depth: usize,
) {
    if depth > 4 || visited.len() > 64 || !path.is_file() {
        return;
    }
    let canonical = canonical_file_string(&path);
    if !visited.insert(canonical.clone()) {
        return;
    }
    if !paths.iter().any(|p| p == &canonical) {
        paths.push(canonical);
    }
    let Ok(content) = std::fs::read_to_string(&path) else {
        return;
    };
    let base_dir = path.parent().unwrap_or_else(|| std::path::Path::new(""));
    for line in content.lines() {
        for token in line.split_whitespace() {
            let Some(import_path) = rule_import_from_token(token) else {
                continue;
            };
            collect_rule_file(
                paths,
                expand_rule_reference(import_path, base_dir, home),
                home,
                visited,
                depth + 1,
            );
        }
    }
}

fn safe_skill_segment(name: &str) -> Option<&str> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        None
    } else {
        Some(name)
    }
}

fn skill_lookup_names(skill_name: &str) -> Vec<String> {
    let trimmed = skill_name.trim().trim_start_matches('$');
    let mut names = Vec::new();
    if !trimmed.is_empty() {
        names.push(trimmed.to_string());
    }
    if let Some((_, suffix)) = trimmed.rsplit_once(':') {
        if !suffix.is_empty() && !names.iter().any(|n| n == suffix) {
            names.push(suffix.to_string());
        }
    }
    names
}

fn skill_name_matches(candidate: &str, wanted: &[String]) -> bool {
    wanted
        .iter()
        .any(|name| candidate == name || candidate.eq_ignore_ascii_case(name))
}

fn frontmatter_skill_name(content: &str) -> Option<String> {
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            return None;
        }
        if let Some(rest) = trimmed.strip_prefix("name:") {
            let name = rest.trim().trim_matches('"').trim_matches('\'').trim();
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
    }
    None
}

fn skill_file_matches(path: &std::path::Path, wanted: &[String]) -> bool {
    if path.file_name().and_then(|s| s.to_str()) != Some("SKILL.md") {
        return false;
    }
    if let Some(parent_name) = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
    {
        if skill_name_matches(parent_name, wanted) {
            return true;
        }
    }
    if let Ok(content) = std::fs::read_to_string(path) {
        if let Some(name) = frontmatter_skill_name(&content) {
            return skill_name_matches(&name, wanted);
        }
    }
    false
}

fn find_skill_recursive(
    root: &std::path::Path,
    wanted: &[String],
    max_depth: usize,
) -> Option<String> {
    if !root.exists() {
        return None;
    }
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut visited = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        if depth > max_depth || visited > 4_000 {
            continue;
        }
        visited += 1;
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if skill_file_matches(&path, wanted) {
                    return Some(canonical_file_string(&path));
                }
            } else if path.is_dir() {
                stack.push((path, depth + 1));
            }
        }
    }
    None
}

fn skill_roots(
    cli: &str,
    working_dir: &str,
) -> Result<(Vec<std::path::PathBuf>, Vec<std::path::PathBuf>), String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let project = std::path::Path::new(working_dir);
    let mut direct = Vec::new();
    let mut recursive = Vec::new();
    match cli {
        "codex" => {
            direct.push(project.join(".agents").join("skills"));
            direct.push(project.join(".codex").join("skills"));
            direct.push(home.join(".agents").join("skills"));
            direct.push(home.join(".codex").join("skills"));
            recursive.extend(direct.clone());
            recursive.push(project.join(".agents").join("plugins"));
            recursive.push(project.join(".codex").join("plugins"));
            recursive.push(home.join(".codex").join("plugins").join("cache"));
        }
        _ => {
            direct.push(project.join(".claude").join("skills"));
            direct.push(home.join(".claude").join("skills"));
            recursive.extend(direct.clone());
            recursive.push(project.join(".claude").join("plugins"));
            recursive.push(home.join(".claude").join("plugins"));
        }
    }
    Ok((direct, recursive))
}

fn resolve_skill_file_inner(
    cli: &str,
    skill_name: &str,
    working_dir: &str,
) -> Result<Option<String>, String> {
    let wanted = skill_lookup_names(skill_name);
    if wanted.is_empty() {
        return Ok(None);
    }
    let (direct_roots, recursive_roots) = skill_roots(cli, working_dir)?;

    for root in &direct_roots {
        for name in &wanted {
            if let Some(segment) = safe_skill_segment(name) {
                let candidate = root.join(segment).join("SKILL.md");
                if candidate.is_file() {
                    return Ok(Some(canonical_file_string(&candidate)));
                }
            }
        }
    }

    for root in &recursive_roots {
        if let Some(path) = find_skill_recursive(root, &wanted, 8) {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

#[tauri::command]
pub fn resolve_skill_file(
    cli: String,
    skill_name: String,
    working_dir: String,
) -> Result<Option<String>, String> {
    resolve_skill_file_inner(&cli, &skill_name, &working_dir)
}

#[tauri::command]
pub fn resolve_activity_context_files(
    cli: String,
    context_kind: String,
    working_dir: String,
) -> Result<Vec<String>, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let project = std::path::Path::new(&working_dir);
    let mut paths = Vec::new();

    match (cli.as_str(), context_kind.as_str()) {
        ("codex", "mcp") | ("codex", "config") => {
            push_existing_file(&mut paths, project.join(".codex").join("config.toml"));
            push_existing_file(&mut paths, home.join(".codex").join("config.toml"));
        }
        ("codex", "rules") => {
            let mut visited = std::collections::HashSet::new();
            for dir in project.ancestors().take(8) {
                collect_rule_file(&mut paths, dir.join("AGENTS.md"), &home, &mut visited, 0);
            }
        }
        (_, "mcp") => {
            push_existing_file(&mut paths, project.join(".mcp.json"));
            push_existing_file(
                &mut paths,
                project.join(".claude").join("settings.local.json"),
            );
            push_existing_file(&mut paths, project.join(".claude").join("settings.json"));
            push_existing_file(&mut paths, home.join(".claude").join("settings.json"));
            push_existing_file(&mut paths, home.join(".claude.json"));
        }
        (_, "config") => {
            push_existing_file(
                &mut paths,
                project.join(".claude").join("settings.local.json"),
            );
            push_existing_file(&mut paths, project.join(".claude").join("settings.json"));
            push_existing_file(&mut paths, home.join(".claude").join("settings.json"));
        }
        (_, "plugin") => {
            push_existing_file(&mut paths, project.join(".claude").join("settings.json"));
            push_existing_file(&mut paths, home.join(".claude").join("settings.json"));
        }
        (_, "rules") => {
            let mut visited = std::collections::HashSet::new();
            collect_rule_file(
                &mut paths,
                project.join("CLAUDE.md"),
                &home,
                &mut visited,
                0,
            );
            collect_rule_file(
                &mut paths,
                project.join(".claude").join("CLAUDE.md"),
                &home,
                &mut visited,
                0,
            );
            collect_rule_file(
                &mut paths,
                home.join(".claude").join("CLAUDE.md"),
                &home,
                &mut visited,
                0,
            );
        }
        _ => {}
    }

    Ok(paths)
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
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse {}: {}", path.display(), e))
}

fn extract_mcp_servers(
    data: &serde_json::Value,
    scope: &str,
    working_dir: &str,
) -> serde_json::Value {
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

// [RT-02] read_mcp_servers / write_mcp_servers read/write MCP server configs from ~/.claude.json
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

// [CE-01] read_codex_mcp_servers / write_codex_mcp_servers read/write config.toml [mcp_servers]; HTTP MCPs bare {url, http_headers}
#[tauri::command]
pub fn read_codex_mcp_servers(scope: String, working_dir: String) -> Result<String, String> {
    let path = codex_config_path(&scope, &working_dir)?;
    let config = read_codex_config_value(&path)?;
    let servers = config
        .get("mcp_servers")
        .cloned()
        .unwrap_or_else(|| toml::Value::Table(toml::value::Table::new()));
    serde_json::to_string(&toml_value_to_json(servers)).map_err(|e| e.to_string())
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
    atomic_write(&path, output.as_bytes())
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

#[tauri::command]
pub fn write_codex_mcp_servers(
    scope: String,
    working_dir: String,
    servers_json: String,
) -> Result<(), String> {
    let parsed: serde_json::Value =
        serde_json::from_str(&servers_json).map_err(|e| format!("Invalid servers JSON: {}", e))?;
    if !parsed.is_object() {
        return Err("servers_json must be a JSON object".into());
    }

    let path = codex_config_path(&scope, &working_dir)?;
    let mut config = read_codex_config_value(&path)?;
    let table = config
        .as_table_mut()
        .ok_or("Codex config root is not a table")?;

    let is_empty = parsed.as_object().map(|m| m.is_empty()).unwrap_or(true);
    if is_empty {
        table.remove("mcp_servers");
    } else if let Some(servers_toml) = json_to_toml_value(parsed) {
        table.insert("mcp_servers".to_string(), servers_toml);
    } else {
        table.remove("mcp_servers");
    }

    write_codex_config_value(&path, &config)
}

// [RT-02] Atomic write: same-directory temp file + rename. Prevents partial
// ~/.claude.json reads when Claude Code CLI writes the same file concurrently.
// std::fs::rename is atomic on Unix and uses MoveFileEx with REPLACE_EXISTING on
// Windows; both require src/dst to be on the same filesystem, so the temp file
// sits next to the target rather than in std::env::temp_dir.
fn atomic_write(path: &std::path::Path, contents: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("config");
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = parent.join(format!(
        ".{}.tmp-{}-{}",
        file_name,
        std::process::id(),
        nanos
    ));
    if let Err(e) = std::fs::write(&tmp, contents) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
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
        assert!(
            s.ends_with("/.claude/skills/my-skill/SKILL.md"),
            "got {}",
            s
        );
    }

    #[test]
    fn resolve_skill_command_project_scope() {
        let path = resolve_config_path("project", "/tmp/proj", "skill:command:bar").unwrap();
        let s = path.to_string_lossy().replace('\\', "/");
        assert!(
            s.ends_with("/tmp/proj/.claude/commands/bar.md"),
            "got {}",
            s
        );
    }

    #[test]
    fn resolve_skill_delete_skill() {
        let path = resolve_config_path("project", "/tmp/proj", "skill-delete:skill:s1").unwrap();
        let s = path.to_string_lossy().replace('\\', "/");
        assert!(
            s.ends_with("/tmp/proj/.claude/skills/s1/SKILL.md"),
            "got {}",
            s
        );
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
        assert!(
            err.contains("Invalid kind") || err.contains("expected"),
            "got {}",
            err
        );
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
    fn skill_file_matches_parent_dir_or_frontmatter_name() {
        let tmp = std::env::temp_dir().join(format!("ct_skill_match_{}", std::process::id()));
        let alpha = tmp.join("alpha");
        let nested = tmp.join("plugin").join("skills").join("other");
        std::fs::create_dir_all(&alpha).unwrap();
        std::fs::create_dir_all(&nested).unwrap();
        let alpha_skill = alpha.join("SKILL.md");
        let nested_skill = nested.join("SKILL.md");
        std::fs::write(&alpha_skill, "body").unwrap();
        std::fs::write(&nested_skill, "---\nname: plugin-skill\n---\nbody").unwrap();

        assert!(skill_file_matches(&alpha_skill, &["alpha".to_string()]));
        assert!(skill_file_matches(
            &nested_skill,
            &["plugin-skill".to_string()]
        ));
        assert!(!skill_file_matches(&nested_skill, &["missing".to_string()]));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn collect_rule_file_includes_at_imports() {
        let tmp = std::env::temp_dir().join(format!("ct_rule_match_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let claude_md = tmp.join("CLAUDE.md");
        let imported = tmp.join("RTK.md");
        std::fs::write(&claude_md, "# Rules\n\n@RTK.md\n").unwrap();
        std::fs::write(&imported, "# Import\n").unwrap();

        let mut paths = Vec::new();
        let mut visited = std::collections::HashSet::new();
        collect_rule_file(&mut paths, claude_md.clone(), &tmp, &mut visited, 0);

        assert!(
            paths.iter().any(|p| p.ends_with("CLAUDE.md")),
            "got {:?}",
            paths
        );
        assert!(
            paths.iter().any(|p| p.ends_with("RTK.md")),
            "got {:?}",
            paths
        );

        std::fs::remove_dir_all(&tmp).ok();
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
        assert_eq!(
            extract_mcp_servers(&data, "user", ""),
            serde_json::json!({})
        );
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

    #[test]
    fn atomic_write_leaves_no_temp_file_on_success() {
        let tmp = std::env::temp_dir().join(format!(
            "ct_atomic_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let target = tmp.join(".claude.json");
        std::fs::write(&target, br#"{"old":true}"#).unwrap();
        atomic_write(&target, br#"{"new":true}"#).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), br#"{"new":true}"#);
        let leftovers: Vec<_> = std::fs::read_dir(&tmp)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .contains(".claude.json.tmp-")
            })
            .collect();
        assert!(
            leftovers.is_empty(),
            "atomic_write left {} temp file(s) behind",
            leftovers.len()
        );
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn atomic_write_overwrites_existing_file() {
        let tmp = std::env::temp_dir().join(format!(
            "ct_atomic_overwrite_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let target = tmp.join("file.json");
        std::fs::write(&target, b"first").unwrap();
        atomic_write(&target, b"second").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "second");
        std::fs::remove_dir_all(&tmp).ok();
    }
}

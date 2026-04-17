use crate::observability::record_backend_event;
use crate::session::types::SessionConfig;
use serde_json::json;
use tauri::AppHandle;

// Discovery primitives live in `crate::discovery` so the standalone
// `discover_audit` binary can invoke the exact same code as the Tauri app.
use crate::discovery::{
    discover_builtin_commands_sync, discover_env_vars_sync, discover_plugin_commands_sync,
    discover_settings_schema_sync, read_claude_binary,
};
pub use crate::discovery::DiscoveredEnvVar;

fn log_discovery(
    app: &AppHandle,
    level: &str,
    event: &str,
    message: &str,
    data: serde_json::Value,
) {
    record_backend_event(app, level, "discovery", None, event, message, data);
}

fn command_names(values: &[serde_json::Value], key: &str) -> Vec<String> {
    values
        .iter()
        .filter_map(|value| value.get(key).and_then(|entry| entry.as_str()))
        .map(|value| value.to_string())
        .collect()
}

// [RC-05] CLI discovery: detect_claude_cli / check_cli_version / get_cli_help
#[tauri::command]
pub async fn detect_claude_cli(app: AppHandle) -> Result<String, String> {
    // Run on a background thread so the WebView event loop isn't blocked
    let result = tokio::task::spawn_blocking(detect_claude_cli_details_sync)
        .await
        .map_err(|e| e.to_string())?;
    match &result {
        Ok((path, source)) => log_discovery(
            &app,
            "LOG",
            "discovery.claude_cli_detected",
            "Detected Claude CLI",
            json!({
                "path": path,
                "source": source,
            }),
        ),
        Err(err) => log_discovery(
            &app,
            "WARN",
            "discovery.claude_cli_detection_failed",
            "Failed to detect Claude CLI",
            json!({
                "error": err,
            }),
        ),
    }
    result.map(|(path, _)| path)
}

pub(crate) fn detect_claude_cli_sync() -> Result<String, String> {
    detect_claude_cli_details_sync().map(|(path, _)| path)
}

fn detect_claude_cli_details_sync() -> Result<(String, &'static str), String> {
    // Escape hatch for environments where `where`/`which` is slow or blocked by
    // policy. Takes precedence over PATH lookup and fallback candidates.
    if let Ok(explicit) = std::env::var("CLAUDE_CLI_PATH") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() && std::path::Path::new(trimmed).exists() {
            return Ok((trimmed.to_string(), "env_override"));
        }
    }

    let which_cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };
    let mut cmd = std::process::Command::new(which_cmd);
    cmd.arg("claude");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to search for claude: {}", e))?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if !path.is_empty() {
            return Ok((path, "path_lookup"));
        }
    }

    // Check common install locations
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    #[cfg(target_os = "windows")]
    let candidates = [
        home.join(".local").join("bin").join("claude.exe"),
        home.join(".npm-global").join("bin").join("claude.cmd"),
        home.join("AppData")
            .join("Roaming")
            .join("npm")
            .join("claude.cmd"),
        home.join("AppData")
            .join("Local")
            .join("Programs")
            .join("npm-global")
            .join("claude.cmd"),
    ];
    #[cfg(not(target_os = "windows"))]
    let candidates = [
        home.join(".npm-global").join("bin").join("claude"),
        home.join(".local").join("bin").join("claude"),
    ];

    for candidate in &candidates {
        if candidate.exists() {
            return Ok((
                candidate.to_string_lossy().to_string(),
                "fallback_candidate",
            ));
        }
    }

    Err("Claude CLI not found. Please install it: npm install -g @anthropic-ai/claude-code".into())
}

/// Run a `claude` CLI subcommand and return trimmed stdout on success.
/// Shared by check_cli_version, plugin_* commands, etc.
/// Resolves the full CLI path via `detect_claude_cli_sync()` so commands
/// work even when PATH doesn't include the install directory (e.g. Linux
/// AppImage / desktop launches).
fn run_claude_cli(args: &[&str], label: &str) -> Result<String, String> {
    let cli_path = detect_claude_cli_sync()?;
    let mut cmd = std::process::Command::new(&cli_path);
    cmd.args(args);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run {}: {}", label, e))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!(
            "{} failed: {}",
            label,
            if stderr.is_empty() {
                "unknown error".to_string()
            } else {
                stderr
            }
        ))
    }
}

/// Run `claude --version` — async to avoid blocking the WebView.
#[tauri::command]
pub async fn check_cli_version(app: AppHandle) -> Result<String, String> {
    let version =
        tokio::task::spawn_blocking(|| run_claude_cli(&["--version"], "claude --version"))
            .await
            .map_err(|e| e.to_string())??;
    log_discovery(
        &app,
        "LOG",
        "discovery.cli_version_loaded",
        "Loaded Claude CLI version",
        json!({
            "version": version,
        }),
    );
    Ok(version)
}

/// Run `claude --help` — async to avoid blocking the WebView.
#[tauri::command]
pub async fn get_cli_help(app: AppHandle) -> Result<String, String> {
    let help = tokio::task::spawn_blocking(|| {
        let cli_path = detect_claude_cli_sync()?;
        let mut cmd = std::process::Command::new(&cli_path);
        cmd.arg("--help");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run claude --help: {}", e))?;
        if output.status.success() {
            Ok::<String, String>(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            if !stderr.is_empty() {
                Ok::<String, String>(stderr)
            } else {
                Err("claude --help failed".to_string())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    log_discovery(
        &app,
        "LOG",
        "discovery.cli_help_loaded",
        "Loaded Claude CLI help text",
        json!({
            "length": help.len(),
        }),
    );
    Ok(help)
}

// [RC-16] 5-step binary resolution: .cmd shim -> direct -> sibling node_modules -> legacy versions -> npm root -g
// Implementation lives in `crate::discovery::read_claude_binary`.

// [RC-09] Slash command discovery: builtin from binary scan, plugin from command directories
/// Scan the Claude Code binary for built-in slash commands.
/// Two-step scan: finds name:"..." positions, then searches a brace-depth-bounded
/// window for descriptions (literal, reversed, computed/ternary, template literal).
#[tauri::command]
pub async fn discover_builtin_commands(
    app: AppHandle,
    cli_path: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let cli_path_for_log = cli_path.clone();
    let commands =
        tokio::task::spawn_blocking(move || discover_builtin_commands_sync(cli_path.as_deref()))
            .await
            .map_err(|e| e.to_string())??;
    let binary_info = if cfg!(debug_assertions) {
        read_claude_binary(cli_path_for_log.as_deref())
            .ok()
            .map(|binary| {
                json!({
                    "binarySource": binary.source,
                    "binaryPath": binary.path,
                })
            })
            .unwrap_or_else(|| json!({}))
    } else {
        json!({})
    };
    log_discovery(
        &app,
        "LOG",
        "discovery.builtin_commands_loaded",
        "Discovered built-in slash commands",
        json!({
            "cliPathArg": cli_path_for_log,
            "count": commands.len(),
            "commands": command_names(&commands, "cmd"),
            "binary": binary_info,
        }),
    );
    Ok(commands)
}

/// Scan the Claude Code binary for settings schema definitions.
/// Extracts Zod schema patterns: keyName:u.type().optional().describe("...")
/// Returns discovered settings with key, type, description, choices.
#[tauri::command]
pub async fn discover_settings_schema(
    app: AppHandle,
    cli_path: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let cli_path_for_log = cli_path.clone();
    let fields =
        tokio::task::spawn_blocking(move || discover_settings_schema_sync(cli_path.as_deref()))
            .await
            .map_err(|e| e.to_string())??;
    let binary_info = if cfg!(debug_assertions) {
        read_claude_binary(cli_path_for_log.as_deref())
            .ok()
            .map(|binary| {
                json!({
                    "binarySource": binary.source,
                    "binaryPath": binary.path,
                })
            })
            .unwrap_or_else(|| json!({}))
    } else {
        json!({})
    };
    log_discovery(
        &app,
        "LOG",
        "discovery.settings_schema_loaded",
        "Discovered binary settings schema",
        json!({
            "cliPathArg": cli_path_for_log,
            "count": fields.len(),
            "keys": command_names(&fields, "key"),
            "binary": binary_info,
        }),
    );
    Ok(fields)
}

/// Mine the Claude CLI binary for environment variable names used via process.env.
/// Returns the hardcoded catalog merged with any additional names found in the binary.
#[tauri::command]
pub async fn discover_env_vars(
    app: AppHandle,
    cli_path: Option<String>,
) -> Result<Vec<DiscoveredEnvVar>, String> {
    let cli_path_for_log = cli_path.clone();
    let vars = tokio::task::spawn_blocking(move || discover_env_vars_sync(cli_path.as_deref()))
        .await
        .map_err(|e| e.to_string())??;
    let binary_info = if cfg!(debug_assertions) {
        read_claude_binary(cli_path_for_log.as_deref())
            .ok()
            .map(|binary| {
                json!({
                    "binarySource": binary.source,
                    "binaryPath": binary.path,
                })
            })
            .unwrap_or_else(|| json!({}))
    } else {
        json!({})
    };
    log_discovery(
        &app,
        "LOG",
        "discovery.env_vars_loaded",
        "Discovered environment variables",
        json!({
            "cliPathArg": cli_path_for_log,
            "count": vars.len(),
            "names": vars.iter().map(|var| var.name.clone()).collect::<Vec<_>>(),
            "binary": binary_info,
        }),
    );
    Ok(vars)
}

// [CM-03] Fetch settings schema from schemastore.org (server-side to avoid CORS)
/// Fetch the Claude Code JSON Schema from schemastore.org.
/// Done server-side to avoid CORS restrictions in the WebView.
#[tauri::command]
pub async fn fetch_settings_schema(app: AppHandle) -> Result<String, String> {
    let schema = tokio::task::spawn_blocking(|| {
        let url = "https://json.schemastore.org/claude-code-settings.json";
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| format!("HTTP client error: {}", e))?;
        client
            .get(url)
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.text())
            .map_err(|e| format!("Failed to fetch settings schema: {}", e))
    })
    .await
    .map_err(|e| e.to_string())??;
    log_discovery(
        &app,
        "LOG",
        "discovery.settings_json_schema_loaded",
        "Fetched remote settings schema",
        json!({
            "length": schema.len(),
            "url": "https://json.schemastore.org/claude-code-settings.json",
        }),
    );
    Ok(schema)
}

/// Scan for plugin/custom command files in multiple locations.
#[tauri::command]
pub fn discover_plugin_commands(
    app: AppHandle,
    extra_dirs: Vec<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let (commands, rejections) = discover_plugin_commands_sync(&extra_dirs)?;

    // Surface rejections so silent drops stop being silent. The previous
    // implementation silently discarded any SKILL.md lacking a `name:`
    // frontmatter — this is what hid the user's ~/.claude/skills/{r,b,c,j,rj}
    // skills in the palette.
    if !rejections.is_empty() {
        log_discovery(
            &app,
            "WARN",
            "discovery.plugin_commands_rejected",
            "Some SKILL.md files were rejected during discovery",
            json!({
                "rejections": rejections
                    .iter()
                    .map(|r| json!({ "path": r.path, "reason": r.reason }))
                    .collect::<Vec<_>>(),
            }),
        );
    }

    log_discovery(
        &app,
        "LOG",
        "discovery.plugin_commands_loaded",
        "Discovered plugin and custom slash commands",
        json!({
            "extraDirs": extra_dirs,
            "count": commands.len(),
            "commands": command_names(&commands, "cmd"),
        }),
    );

    Ok(commands)
}

// [RC-02] SessionConfig -> CLI args (--resume, --session-id, --project-dir, etc.)
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
        #[cfg(target_os = "windows")]
        args.push(config.working_dir.replace('/', "\\"));
        #[cfg(not(target_os = "windows"))]
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

    // [RS-05] Skip --session-id when using --resume or --continue
    // Claude CLI rejects the combination unless --fork-session is also specified.
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

/// Scan JSONL conversation history for slash command usage.
/// Walks ~/.claude/projects/*/*.jsonl, caps at 200 most recent files by mtime,
/// and counts `<command-name>X</command-name>` patterns.
#[tauri::command]
pub async fn scan_command_usage(
    app: AppHandle,
) -> Result<std::collections::HashMap<String, u64>, String> {
    let counts = tokio::task::spawn_blocking(scan_command_usage_sync)
        .await
        .map_err(|e| e.to_string())??;
    log_discovery(
        &app,
        "LOG",
        "discovery.command_usage_loaded",
        "Scanned historical slash-command usage",
        json!({
            "uniqueCommands": counts.len(),
            "commands": counts,
        }),
    );
    Ok(counts)
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
        if !path.is_dir() {
            continue;
        }
        if let Ok(dir_entries) = std::fs::read_dir(&path) {
            for file in dir_entries.flatten() {
                let fpath = file.path();
                if fpath.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
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

// [RC-18] Plugin management IPC: list/install/uninstall/enable/disable via run_claude_cli

/// Run `claude plugin list --available --json` and return raw JSON output.
#[tauri::command]
pub async fn plugin_list() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        run_claude_cli(
            &["plugin", "list", "--available", "--json"],
            "claude plugin list",
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Run `claude plugin install <name> --scope <scope>`.
#[tauri::command]
pub async fn plugin_install(name: String, scope: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        run_claude_cli(
            &["plugin", "install", &name, "--scope", &scope],
            "plugin install",
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Run `claude plugin uninstall <name>`.
#[tauri::command]
pub async fn plugin_uninstall(name: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        run_claude_cli(&["plugin", "uninstall", &name], "plugin uninstall")
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Run `claude plugin enable <name>`.
#[tauri::command]
pub async fn plugin_enable(name: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        run_claude_cli(&["plugin", "enable", &name], "plugin enable")
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Run `claude plugin disable <name>`.
#[tauri::command]
pub async fn plugin_disable(name: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        run_claude_cli(&["plugin", "disable", &name], "plugin disable")
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::types::SessionConfig;

    // --- build_claude_args tests ---

    #[test]
    fn build_args_project_dir_preserves_forward_slashes() {
        let config = SessionConfig {
            working_dir: "/home/user/project".into(),
            project_dir: true,
            ..Default::default()
        };
        let args = build_claude_args(config).unwrap();
        let idx = args.iter().position(|a| a == "--project-dir").unwrap();
        let dir_arg = &args[idx + 1];
        #[cfg(not(target_os = "windows"))]
        assert_eq!(
            dir_arg, "/home/user/project",
            "Linux paths must keep forward slashes"
        );
        #[cfg(target_os = "windows")]
        assert_eq!(
            dir_arg, "\\home\\user\\project",
            "Windows should normalize to backslashes"
        );
    }
}

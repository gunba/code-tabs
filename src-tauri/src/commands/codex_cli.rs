//! Codex CLI runtime introspection helpers.
//!
//! Every piece of information about Codex (binary path, version, model
//! catalog, CLI flags, feature flags, MCP servers) is extracted by
//! invoking the Codex binary itself — never from vendored Codex source.
//! This mirrors the philosophy of `src-tauri/src/discovery/mod.rs` for
//! Claude Code: we ask the installed binary, so we adapt to whichever
//! version of Codex the user has without our build needing updates.
//!
//! Subcommands we rely on:
//!   - `codex --version`                      → version string
//!   - `codex debug models`                   → JSON model catalog
//!   - `codex --help`, `codex <sub> --help`   → flag pills
//!   - `codex features list`                  → feature flag catalog
//!   - `codex mcp list --json`                → configured MCP servers

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::discovery::DiscoveredEnvVar;
use crate::observability::record_backend_event;

const MAX_OPTION_DESCRIPTION_CHARS: usize = 200;

// ── Detection ────────────────────────────────────────────────────────

/// Locate the `codex` binary. Mirrors the chain in
/// `commands/cli.rs::detect_claude_cli_details_sync` for shape, adapted
/// to Codex's install layout: env override → PATH lookup → user-local
/// fallbacks.
pub(crate) fn detect_codex_cli_sync() -> Result<String, String> {
    // 1. Env override
    if let Ok(p) = std::env::var("CODEX_CLI_PATH") {
        if !p.is_empty() && std::path::Path::new(&p).exists() {
            return Ok(p);
        }
    }

    // 2. `which codex` (Unix) / `where codex` (Windows)
    #[cfg(unix)]
    let which_cmd = "which";
    #[cfg(windows)]
    let which_cmd = "where";

    let mut cmd = std::process::Command::new(which_cmd);
    cmd.arg("codex");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // [DR-07] CREATE_NO_WINDOW so spawned `where` doesn't pop a console.
        cmd.creation_flags(0x08000000);
    }
    if let Ok(out) = cmd.output() {
        if out.status.success() {
            // [CD-W1] On Windows, `where codex` emits the extensionless npm
            // bash wrapper before `codex.cmd`. CreateProcess refuses the
            // wrapper ("not a valid Win32 application"), so prefer .cmd /
            // .exe / .bat. Helper falls back to first existing line on Unix.
            if let Some(path) = crate::path_utils::pick_runnable_from_which_output(
                &String::from_utf8_lossy(&out.stdout),
            ) {
                return Ok(path);
            }
        }
    }

    // 3. Fallback candidates
    let home = dirs::home_dir().ok_or("no home dir")?;
    #[cfg(target_os = "windows")]
    let candidates: Vec<PathBuf> = vec![
        home.join("AppData/Local/Programs/npm-global/codex.cmd"),
        home.join("AppData/Roaming/npm/codex.cmd"),
        home.join(".npm-global/bin/codex.cmd"),
        home.join(".codex/bin/codex.exe"),
        home.join(".cargo/bin/codex.exe"),
    ];
    #[cfg(not(target_os = "windows"))]
    let candidates: Vec<PathBuf> = vec![
        home.join(".codex/bin/codex"),
        home.join(".local/bin/codex"),
        home.join(".cargo/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
    ];
    for c in candidates {
        if c.exists() {
            return Ok(c.to_string_lossy().to_string());
        }
    }

    Err("Codex CLI not found. Install it: https://github.com/openai/codex".into())
}

#[tauri::command]
pub async fn detect_codex_cli(app: tauri::AppHandle) -> Result<String, String> {
    let path = tauri::async_runtime::spawn_blocking(detect_codex_cli_sync)
        .await
        .map_err(|e| format!("join error: {e}"))??;
    record_backend_event(
        &app,
        "DEBUG",
        "codex",
        None,
        "codex.detect",
        "Resolved Codex CLI",
        serde_json::json!({ "path": &path }),
    );
    Ok(path)
}

fn run_codex(args: &[&str]) -> Result<String, String> {
    let bin = detect_codex_cli_sync()?;
    run_codex_at(std::path::Path::new(&bin), args)
}

fn run_codex_at(bin: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = std::process::Command::new(&bin);
    cmd.args(args);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // [DR-07] CREATE_NO_WINDOW so Codex probes do not pop a console.
        cmd.creation_flags(0x08000000);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("codex {}: {e}", args.join(" ")))?;
    if !out.status.success() {
        return Err(format!(
            "codex {} exit {}: {}",
            args.join(" "),
            out.status,
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

// ── Auth mode ────────────────────────────────────────────────────────

/// Resolve Codex's effective auth mode from `$CODEX_HOME/auth.json`
/// (fallback `~/.codex/auth.json`).
///
/// This mirrors Codex's own `AuthDotJson::resolved_mode`: an explicit
/// `auth_mode` wins; otherwise a stored non-empty `OPENAI_API_KEY` means API
/// key auth; otherwise the file represents ChatGPT auth. Missing or malformed
/// files return `None`.
pub(crate) fn read_codex_auth_mode_sync() -> Option<String> {
    read_codex_auth_mode_at(&crate::commands::data::codex_home_dir()?)
}

fn read_codex_auth_mode_at(codex_home: &Path) -> Option<String> {
    let path = codex_home.join("auth.json");
    let raw = std::fs::read_to_string(&path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    if let Some(mode) = json.get("auth_mode").and_then(|v| v.as_str()) {
        return Some(mode.to_string());
    }
    if json
        .get("OPENAI_API_KEY")
        .and_then(|v| v.as_str())
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
    {
        Some("apikey".into())
    } else {
        Some("chatgpt".into())
    }
}

// ── Version ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn check_codex_cli_version() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<String, String> {
        let raw = run_codex(&["--version"])?;
        Ok(raw.trim().to_string())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
pub async fn get_codex_cli_help() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| run_codex(&["--help"]))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

// ── Models (`codex debug models` → JSON) ────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "snake_case", serialize = "camelCase"))]
pub struct CodexReasoningLevel {
    pub effort: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "snake_case", serialize = "camelCase"))]
pub struct CodexModel {
    pub slug: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub default_reasoning_level: Option<String>,
    #[serde(default)]
    pub supported_reasoning_levels: Vec<CodexReasoningLevel>,
    #[serde(default)]
    pub visibility: Option<String>,
    #[serde(default)]
    pub priority: Option<i64>,
    #[serde(default)]
    pub supported_in_api: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CodexModelsRaw {
    models: Vec<CodexModel>,
}

// [CO-01] discover_codex_models: 'codex debug models' JSON; filters visibility!='list'; drives model picker
pub(crate) fn discover_codex_models_sync() -> Result<Vec<CodexModel>, String> {
    let bin = detect_codex_cli_sync()?;
    discover_codex_models_at_sync(std::path::Path::new(&bin))
}

pub(crate) fn discover_codex_models_at_sync(bin: &Path) -> Result<Vec<CodexModel>, String> {
    let raw = run_codex_at(bin, &["debug", "models"])?;
    let parsed: CodexModelsRaw =
        serde_json::from_str(&raw).map_err(|e| format!("codex debug models: invalid JSON: {e}"))?;
    Ok(parsed
        .models
        .into_iter()
        .filter(|m| m.visibility.as_deref().map(|v| v == "list").unwrap_or(true))
        .collect())
}

#[tauri::command]
pub async fn discover_codex_models() -> Result<Vec<CodexModel>, String> {
    tauri::async_runtime::spawn_blocking(discover_codex_models_sync)
        .await
        .map_err(|e| format!("join error: {e}"))?
}

// ── CLI options (`codex --help` and per-subcommand) ─────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCliOption {
    /// Long flag including leading dashes, e.g. `--cd`.
    pub flag: String,
    /// Short alias if present, e.g. `-C`. Empty when none.
    pub short: String,
    /// One-line description from `--help`.
    pub description: String,
    /// True if the flag takes a value (e.g. `--cd <DIR>`).
    pub takes_value: bool,
}

/// Parse a single `--help` output for option pills. Picks up lines
/// matching `-X, --long <VAL>` or `--long <VAL>` followed by an
/// indented description. Cheap, regex-driven, version-tolerant.
fn parse_help_options(help: &str) -> Vec<CodexCliOption> {
    let re_flag =
        regex::Regex::new(r"(?m)^\s{2,}(?:(-\w),\s+)?(--[\w-]+)(\s+<[^>]+>|\s+\[[^\]]+\])?")
            .expect("flag regex must compile");
    let mut out = Vec::new();
    let mut last_flag_idx: Option<usize> = None;
    for line in help.lines() {
        if let Some(caps) = re_flag.captures(line) {
            let short = caps
                .get(1)
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
            let flag = caps
                .get(2)
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
            let takes_value = caps.get(3).is_some();
            let tail = caps.get(0).map(|m| m.end()).unwrap_or(0);
            let inline_desc = line.get(tail..).unwrap_or("").trim().to_string();
            out.push(CodexCliOption {
                flag,
                short,
                description: inline_desc,
                takes_value,
            });
            last_flag_idx = Some(out.len() - 1);
        } else if let Some(idx) = last_flag_idx {
            // Indented continuation line — append to current option's
            // description if it isn't already complete.
            let trimmed = line.trim();
            if trimmed.is_empty() {
                last_flag_idx = None;
            } else if !line.starts_with(' ') {
                // A non-indented, non-empty line ends the previous
                // flag's continuation (e.g. a section header like
                // "Arguments:").
                last_flag_idx = None;
            } else if !line.starts_with("  -")
                && out[idx].description.len() < MAX_OPTION_DESCRIPTION_CHARS
            {
                if !out[idx].description.is_empty() {
                    out[idx].description.push(' ');
                }
                out[idx].description.push_str(trimmed);
                if out[idx].description.len() > MAX_OPTION_DESCRIPTION_CHARS {
                    let end = out[idx]
                        .description
                        .floor_char_boundary(MAX_OPTION_DESCRIPTION_CHARS);
                    out[idx].description.truncate(end);
                }
            }
        }
    }
    out
}

#[tauri::command]
pub async fn discover_codex_cli_options() -> Result<Vec<CodexCliOption>, String> {
    tauri::async_runtime::spawn_blocking(discover_codex_cli_options_sync)
        .await
        .map_err(|e| format!("join error: {e}"))?
}

// [CO-02] discover_codex_cli_options: 'codex --help' regex parse; picks up long/short flags + continuation lines; max 200 char desc
pub(crate) fn discover_codex_cli_options_sync() -> Result<Vec<CodexCliOption>, String> {
    let bin = detect_codex_cli_sync()?;
    discover_codex_cli_options_at_sync(std::path::Path::new(&bin))
}

pub(crate) fn discover_codex_cli_options_at_sync(
    bin: &Path,
) -> Result<Vec<CodexCliOption>, String> {
    let help = run_codex_at(bin, &["--help"])?;
    Ok(parse_help_options(&help))
}

// ── Features (`codex features list`) ────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexFeature {
    pub name: String,
    pub stage: String,
    pub enabled: bool,
}

/// Parse `codex features list` output. Codex pads columns with at least two
/// spaces: `<name>  <stage>  <true|false>`. Stage itself may contain spaces.
/// Tolerant of header lines and blank lines.
fn parse_features(stdout: &str) -> Vec<CodexFeature> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parts: Vec<&str> = trimmed
            .split("  ")
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect();
        if parts.len() != 3 {
            continue;
        }
        let name = parts[0].to_string();
        let stage = parts[1].to_string();
        let state = parts[2].to_ascii_lowercase();
        let enabled = match state.as_str() {
            "true" => true,
            "false" => false,
            _ => continue,
        };
        out.push(CodexFeature {
            name,
            stage,
            enabled,
        });
    }
    out
}

#[tauri::command]
pub async fn discover_codex_features() -> Result<Vec<CodexFeature>, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<Vec<CodexFeature>, String> {
        let raw = run_codex(&["features", "list"])?;
        Ok(parse_features(&raw))
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

// ── MCP servers (`codex mcp list`) ──────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMcpServer {
    pub name: String,
    #[serde(default)]
    pub transport: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub disabled_reason: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub auth_status: Option<String>,
}

fn parse_mcp_server(item: &serde_json::Value) -> Option<CodexMcpServer> {
    let name = item["name"].as_str()?.to_string();
    let enabled = item["enabled"].as_bool().unwrap_or(true);
    let disabled_reason = item["disabled_reason"].as_str().map(str::to_string);
    let auth_status = item["auth_status"].as_str().map(str::to_string);
    let transport = &item["transport"];
    let transport_type = transport["type"].as_str().unwrap_or("").to_string();
    let command = transport["command"].as_str().map(str::to_string);
    let args = transport["args"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let cwd = transport["cwd"].as_str().map(str::to_string);
    let url = transport["url"].as_str().map(str::to_string);

    Some(CodexMcpServer {
        name,
        transport: transport_type,
        command,
        args,
        url,
        enabled,
        disabled_reason,
        cwd,
        auth_status,
    })
}

/// Parse `codex mcp list --json`.
fn parse_mcp_list(stdout: &str) -> Result<Vec<CodexMcpServer>, String> {
    let v = serde_json::from_str::<serde_json::Value>(stdout)
        .map_err(|e| format!("Invalid codex mcp list --json output: {e}"))?;
    let arr = v
        .as_array()
        .ok_or_else(|| "codex mcp list --json did not return an array".to_string())?;
    Ok(arr.iter().filter_map(parse_mcp_server).collect())
}

#[tauri::command]
pub async fn discover_codex_mcp_servers() -> Result<Vec<CodexMcpServer>, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<Vec<CodexMcpServer>, String> {
        let raw = run_codex(&["mcp", "list", "--json"])?;
        parse_mcp_list(&raw)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

// ── Skills (`SKILL.md` directory scan) ──────────────────────────────

/// Discover Codex skills by scanning known disk locations. Mirrors
/// the Claude skill scanner (`discovery::scan_skill_md`) — same
/// `SKILL.md` + YAML-frontmatter format, just different roots.
///
/// Discovery roots (in priority order):
/// - `~/.agents/skills/<name>/SKILL.md`           (Codex preferred)
/// - `<project>/.agents/skills/<name>/SKILL.md`
/// - `~/.codex/skills/<name>/SKILL.md`            (deprecated, kept for compat)
/// - `<project>/.codex/skills/<name>/SKILL.md`
///
/// Returns `(commands, rejections)` matching the Claude shape so the
/// UI can render both CLIs through the same view.
pub(crate) fn discover_codex_skills_sync(
    extra_dirs: &[String],
) -> Result<
    (
        Vec<serde_json::Value>,
        Vec<crate::discovery::PluginScanRejection>,
    ),
    String,
> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let mut commands = Vec::new();
    let mut rejections = Vec::new();

    fn scan_dir(
        dir: &std::path::Path,
        commands: &mut Vec<serde_json::Value>,
        rejections: &mut Vec<crate::discovery::PluginScanRejection>,
    ) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    scan_dir(&path, commands, rejections);
                } else if path.file_name().and_then(|n| n.to_str()) == Some("SKILL.md") {
                    crate::discovery::scan_skill_md(&path, commands, rejections);
                }
            }
        }
    }

    let mut roots = Vec::new();
    roots.push(home.join(".agents").join("skills"));
    for dir in extra_dirs {
        roots.push(std::path::Path::new(dir).join(".agents").join("skills"));
    }
    roots.push(home.join(".codex").join("skills"));
    for dir in extra_dirs {
        roots.push(std::path::Path::new(dir).join(".codex").join("skills"));
    }

    for root in &roots {
        if root.exists() {
            scan_dir(root, &mut commands, &mut rejections);
        }
    }

    let mut seen = std::collections::HashSet::new();
    commands.retain(|c| {
        let name = c["cmd"].as_str().unwrap_or("").to_string();
        seen.insert(name)
    });

    Ok((commands, rejections))
}

#[tauri::command]
pub async fn discover_codex_skills(
    extra_dirs: Vec<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let (cmds, _rejections) =
        tauri::async_runtime::spawn_blocking(move || discover_codex_skills_sync(&extra_dirs))
            .await
            .map_err(|e| format!("join error: {e}"))??;
    Ok(cmds)
}

// ── Built-in slash commands ────────────────────────────────────────
//
// Codex exposes CLI subcommands through `codex --help`, but not the
// interactive TUI slash-command catalog. We still anchor this list to
// the installed binary: when the native package is available, scan it
// for command-specific strings and include only commands whose probes
// are present. Probes are intentionally conservative; commands without
// stable binary strings remain included so the palette does not go
// blank on stripped builds.

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSlashCommand {
    pub cmd: String,
    pub desc: String,
}

// [CO-03] CODEX_SLASH_COMMANDS: interactive TUI catalog, filtered by installed binary probes when possible.
const CODEX_SLASH_COMMANDS: &[(&str, &str, &[&str])] = &[
    (
        "/model",
        "choose what model and reasoning effort to use",
        &["model/rerouted", "supported_reasoning_levels"],
    ),
    (
        "/fast",
        "toggle Fast mode to enable fastest inference with increased plan usage",
        &["toggle Fast mode", "fast_command_enabled"],
    ),
    (
        "/approvals",
        "choose what Codex is allowed to do",
        &["approvals_reviewer", "allowedApprovalsReviewers"],
    ),
    (
        "/permissions",
        "choose what Codex is allowed to do",
        &["PermissionsRequest", "requestPermissions"],
    ),
    (
        "/setup-default-sandbox",
        "set up elevated agent sandbox",
        &["setup-default-sandbox", "ElevateSandbox"],
    ),
    (
        "/sandbox-add-read-dir",
        "let sandbox read a directory: /sandbox-add-read-dir <absolute_path>",
        &["sandbox-add-read-dir", "SandboxReadRoot"],
    ),
    (
        "/experimental",
        "toggle experimental features",
        &["toggle experimental features", "experimental"],
    ),
    (
        "/memories",
        "configure memory use and generation",
        &["configure memory use", "memories"],
    ),
    (
        "/skills",
        "use skills to improve how Codex performs specific tasks",
        &["skills/changed", "ListSkills"],
    ),
    (
        "/review",
        "review my current changes and find issues",
        &["session_task.review", "enteredReviewMode"],
    ),
    (
        "/rename",
        "rename the current thread",
        &["thread/name/updated", "SetThreadName"],
    ),
    (
        "/new",
        "start a new chat during a conversation",
        &["thread/started"],
    ),
    (
        "/resume",
        "resume a saved chat",
        &["thread/resume", "Resume a previous interactive session"],
    ),
    (
        "/fork",
        "fork the current chat",
        &["Fork a previous interactive session"],
    ),
    (
        "/init",
        "create an AGENTS.md file with instructions for Codex",
        &["Skipping /init", "AGENTS.md"],
    ),
    (
        "/compact",
        "summarize conversation to prevent hitting the context limit",
        &["session_task.compact", "thread/compacted"],
    ),
    (
        "/plan",
        "switch to Plan mode",
        &["turn/plan/updated", "PlanItem"],
    ),
    ("/goal", "set or view the goal for a long-running task", &[]),
    (
        "/collab",
        "change collaboration mode (experimental)",
        &["change collaboration mode", "collaboration_modes_enabled"],
    ),
    (
        "/agent",
        "switch the active agent thread",
        &["switch the active agent thread", "CollabAgent"],
    ),
    (
        "/side",
        "start a side conversation in an ephemeral fork",
        &["side conversation", "Side"],
    ),
    ("/copy", "copy last response as markdown", &["upgradeCopy"]),
    (
        "/diff",
        "show git diff (including untracked files)",
        &["turn/diff/updated", "No diff turn found"],
    ),
    ("/mention", "mention a file", &["fuzzyFileSearch"]),
    (
        "/status",
        "show current session configuration and token usage",
        &["thread/status/changed", "tokenUsage"],
    ),
    (
        "/debug-config",
        "show config layers and requirement sources for debugging",
        &["debug-config", "config layers"],
    ),
    (
        "/title",
        "configure which items appear in the terminal title",
        &["terminal title", "Title"],
    ),
    (
        "/statusline",
        "configure which items appear in the status line",
        &["status_line"],
    ),
    (
        "/theme",
        "choose a syntax highlighting theme",
        &["theme", "show_tooltips"],
    ),
    (
        "/mcp",
        "list configured MCP tools; use /mcp verbose for details",
        &["mcp_servers", "ListMcpServerStatusParams"],
    ),
    (
        "/apps",
        "manage apps",
        &["manage apps", "connectors_enabled"],
    ),
    (
        "/plugins",
        "browse plugins",
        &["browse plugins", "plugins_command_enabled"],
    ),
    (
        "/logout",
        "log out of Codex",
        &["Remove stored authentication credentials"],
    ),
    ("/quit", "exit Codex", &[]),
    ("/exit", "exit Codex", &[]),
    ("/feedback", "send logs to maintainers", &["feedback"]),
    (
        "/ps",
        "list background terminals",
        &["list background terminals", "background terminals"],
    ),
    (
        "/stop",
        "stop all background terminals",
        &["stop all background terminals", "background terminals"],
    ),
    (
        "/clear",
        "clear the terminal and start a new chat",
        &["SessionStart", "clear"],
    ),
    (
        "/personality",
        "choose a communication style for Codex",
        &["Personality set", "supportsPersonality"],
    ),
    (
        "/realtime",
        "toggle realtime voice mode (experimental)",
        &["realtime voice mode", "realtime_conversation_enabled"],
    ),
    (
        "/settings",
        "configure realtime microphone/speaker",
        &["realtime microphone", "audio_device_selection_enabled"],
    ),
    (
        "/subagents",
        "switch the active agent thread",
        &["subagents", "MultiAgents"],
    ),
];

// [CO-04] discover_codex_settings_schema: returns ConfigToml schema with provenance ("binary" or "remote"). Codex 0.125.0 doesn't ship the schema in the runtime binary, so the binary mine returns nothing and the fallback fetches openai/codex rust-v<installed-version>/codex-rs/core/config.schema.json at runtime. No schema is vendored into Code Tabs.
/// Resolve the Codex ConfigToml JSON Schema. Prefers the installed native
/// binary when Codex embeds the schema, otherwise fetches the matching remote
/// release schema at runtime. The command errors if neither source is
/// available; Code Tabs does not ship a fallback schema.
#[tauri::command]
pub async fn discover_codex_settings_schema(
    cli_path: Option<String>,
) -> Result<crate::discovery::codex::CodexSchemaResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let wrapper = resolve_wrapper_for_discovery(cli_path.as_deref())?;
        let version = run_codex_at(&wrapper, &["--version"])
            .ok()
            .map(|raw| raw.trim().to_string());
        let native = resolve_codex_native_binary_from_wrapper(&wrapper);
        crate::discovery::codex::discover_codex_settings_schema_sync(
            native.as_deref(),
            version.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

// [CO-05] discover_codex_env_vars: regex-mine CODEX_* identifiers from native binary, merge with curated catalog (~45 entries with descriptions/categories), filter test-only noise vars
/// Mine `CODEX_*` env vars from the Codex native binary and merge with a
/// curated catalog of non-prefixed vars Codex respects (`OPENAI_API_KEY`,
/// `SSL_CERT_FILE`, …). Curated entries supply the human-facing
/// descriptions; mined-only entries are flagged `documented=false`.
#[tauri::command]
pub async fn discover_codex_env_vars(
    cli_path: Option<String>,
) -> Result<Vec<DiscoveredEnvVar>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let native = resolve_native_for_discovery(cli_path.as_deref())?;
        crate::discovery::codex::discover_codex_env_vars_sync(&native)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Resolve a Codex CLI path to its native binary. If `cli_path` is None,
/// fall back to the auto-detected binary. Returns a meaningful error rather
/// than `Option::None` so the discovery commands can surface the failure
/// (env-var mining always needs a real binary).
fn resolve_native_for_discovery(cli_path: Option<&str>) -> Result<PathBuf, String> {
    let wrapper = resolve_wrapper_for_discovery(cli_path)?;
    resolve_codex_native_binary_from_wrapper(&wrapper).ok_or_else(|| {
        format!(
            "Codex native binary not found from wrapper {} (expected vendor/<triple>/codex/codex)",
            wrapper.display()
        )
    })
}

fn resolve_wrapper_for_discovery(cli_path: Option<&str>) -> Result<PathBuf, String> {
    Ok(match cli_path.filter(|p| !p.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => PathBuf::from(detect_codex_cli_sync()?),
    })
}

#[tauri::command]
pub async fn discover_codex_slash_commands() -> Result<Vec<CodexSlashCommand>, String> {
    tauri::async_runtime::spawn_blocking(discover_codex_slash_commands_sync)
        .await
        .map_err(|e| format!("join error: {e}"))
}

// [CL-01] Filter the vendored CODEX_SLASH_COMMANDS list against the installed
// native binary. The probe-based filter prunes commands that the binary clearly
// doesn't ship; an empty filtered list means we couldn't read the binary, in
// which case we fall back to the full vendored list rather than show nothing.
fn discover_codex_slash_commands_sync() -> Vec<CodexSlashCommand> {
    let filtered = resolve_codex_native_binary_path()
        .and_then(|path| crate::discovery::codex::read_binary_capped(&path).ok())
        .map(|bytes| {
            CODEX_SLASH_COMMANDS
                .iter()
                .filter(|(cmd, _, probes)| {
                    codex_slash_command_visible_on_platform(cmd)
                        && (probes.is_empty()
                            || probes.iter().any(|probe| {
                                memchr::memmem::find(&bytes, probe.as_bytes()).is_some()
                            }))
                })
                .map(|(cmd, desc, _)| CodexSlashCommand {
                    cmd: (*cmd).to_string(),
                    desc: (*desc).to_string(),
                })
                .collect::<Vec<_>>()
        });

    match filtered {
        Some(cmds) if !cmds.is_empty() => cmds,
        _ => CODEX_SLASH_COMMANDS
            .iter()
            .filter(|(cmd, _, _)| codex_slash_command_visible_on_platform(cmd))
            .map(|(cmd, desc, _)| CodexSlashCommand {
                cmd: (*cmd).to_string(),
                desc: (*desc).to_string(),
            })
            .collect(),
    }
}

// [CL-02] Platform gate: /sandbox-add-read-dir Windows-only; expanded catalog 35+ commands
fn codex_slash_command_visible_on_platform(cmd: &str) -> bool {
    match cmd {
        // Codex itself only registers /sandbox-add-read-dir on Windows
        // (codex-rs/tui/src/slash_command.rs:214) — Linux/macOS use the
        // sandbox config directly. Mirror that gate here.
        "/sandbox-add-read-dir" => cfg!(target_os = "windows"),
        _ => true,
    }
}

fn resolve_codex_native_binary_path() -> Option<PathBuf> {
    let bin = PathBuf::from(detect_codex_cli_sync().ok()?);
    resolve_codex_native_binary_from_wrapper(&bin)
}

/// Walk from a Codex wrapper path (the `codex` executable on PATH) to the
/// vendored native ELF/Mach-O/PE binary. Used by discovery (which needs the
/// stripped Rust binary, not the Node wrapper) and by slash-command probing.
pub(crate) fn resolve_codex_native_binary_from_wrapper(wrapper: &Path) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(wrapper).unwrap_or_else(|_| wrapper.to_path_buf());
    if canonical.extension().and_then(|e| e.to_str()) != Some("js") {
        return Some(canonical);
    }

    let (triple, package_name, exe_name) = current_codex_native_target()?;
    let codex_root = canonical.parent()?.parent()?;
    let candidates = [
        codex_root
            .join("node_modules")
            .join("@openai")
            .join(package_name)
            .join("vendor")
            .join(triple)
            .join("codex")
            .join(exe_name),
        codex_root
            .join("vendor")
            .join(triple)
            .join("codex")
            .join(exe_name),
    ];
    candidates.into_iter().find(|path| path.is_file())
}

fn current_codex_native_target() -> Option<(&'static str, &'static str, &'static str)> {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return Some(("x86_64-unknown-linux-musl", "codex-linux-x64", "codex"));
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return Some(("aarch64-unknown-linux-musl", "codex-linux-arm64", "codex"));
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return Some(("x86_64-apple-darwin", "codex-darwin-x64", "codex"));
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Some(("aarch64-apple-darwin", "codex-darwin-arm64", "codex"));
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return Some(("x86_64-pc-windows-msvc", "codex-win32-x64", "codex.exe"));
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        return Some(("aarch64-pc-windows-msvc", "codex-win32-arm64", "codex.exe"));
    }
    #[allow(unreachable_code)]
    None
}

// ── Session title generation (`codex exec` one-shot) ─────────────────
//
// [CO-06] generate_codex_session_title: 'codex exec --model X --ephemeral --output-last-message FILE --color never -c sandbox_mode=read-only -c approval_policy=never' one-shot reusing user's Codex auth; 60s timeout, 64-char output cap, RAII tempfile guard. Provider-symmetric with Claude Code's Haiku CustomTitle — see SL-23 for frontend trigger.
//
// Spawns `codex exec` against a small model to generate a 3-5 word tab
// title from the user's first message. Reuses Codex's own auth (file /
// keyring / env) so the user never re-enters credentials. Provider-
// symmetric with Claude Code's Haiku-driven CustomTitle flow: each tab
// gets renamed by its own provider's small model.

const TITLE_PROMPT_TEMPLATE: &str = "Generate a 3-5 word title in sentence case for a coding session that begins with the user message below. Reply with ONLY the title — no quotes, no trailing punctuation, no preamble.\n\nUser message:\n<<<\n{prompt}\n>>>";

const TITLE_TIMEOUT_SECS: u64 = 60;
const TITLE_MAX_CHARS: usize = 64;
const TITLE_PROMPT_MAX_CHARS: usize = 4_000;

#[tauri::command]
pub async fn generate_codex_session_title(prompt: String, model: String) -> Result<String, String> {
    let prompt = prompt.trim();
    let model = model.trim();
    if prompt.is_empty() {
        return Err("empty prompt".into());
    }
    if model.is_empty() {
        return Err("empty model".into());
    }

    let bin = detect_codex_cli_sync()?;

    // Plain PathBuf + RAII guard instead of `tempfile` (which is a dev-only
    // dependency in this crate). The guard removes the file on drop so we
    // don't leak even on error paths.
    let tmpfile_path = std::env::temp_dir().join(format!(
        "code-tabs-codex-title-{}.txt",
        uuid::Uuid::new_v4()
    ));
    struct TmpFileGuard(PathBuf);
    impl Drop for TmpFileGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _guard = TmpFileGuard(tmpfile_path.clone());

    // Truncate very long prompts so we don't blow the model's input budget
    // on a title call that only needs the first few hundred chars of context.
    let trimmed_prompt: String = if prompt.chars().count() > TITLE_PROMPT_MAX_CHARS {
        prompt
            .chars()
            .take(TITLE_PROMPT_MAX_CHARS)
            .collect::<String>()
    } else {
        prompt.to_string()
    };
    let user_prompt = TITLE_PROMPT_TEMPLATE.replace("{prompt}", &trimmed_prompt);

    // Run from the system temp dir so any stray tool call sees nothing
    // interesting; sandbox_mode=read-only is the actual seatbelt.
    let workdir = std::env::temp_dir();

    let exec = tokio::process::Command::new(&bin)
        .arg("exec")
        .arg("--model")
        .arg(model)
        .arg("--ephemeral")
        .arg("--output-last-message")
        .arg(&tmpfile_path)
        .arg("--color")
        .arg("never")
        .arg("-c")
        .arg("sandbox_mode=read-only")
        // `never` is what Codex recommends for non-interactive runs
        // (`OnFailure` is documented as deprecated in protocol.rs); combined
        // with `sandbox_mode=read-only` any tool write attempt fails inside
        // the sandbox without prompting.
        .arg("-c")
        .arg("approval_policy=never")
        .arg(&user_prompt)
        .current_dir(&workdir)
        .kill_on_drop(true)
        .output();

    let output = match tokio::time::timeout(
        std::time::Duration::from_secs(TITLE_TIMEOUT_SECS),
        exec,
    )
    .await
    {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return Err(format!("codex exec spawn failed: {e}")),
        Err(_) => return Err(format!("codex exec timed out after {TITLE_TIMEOUT_SECS}s")),
    };

    if !output.status.success() {
        return Err(format!(
            "codex exec exit {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let raw = std::fs::read_to_string(&tmpfile_path).map_err(|e| format!("read tempfile: {e}"))?;
    cleanup_title(&raw).ok_or_else(|| "empty title".to_string())
}

/// Clean up the LLM's title output: take the first non-empty line, strip
/// surrounding quotes / trailing punctuation, cap to TITLE_MAX_CHARS.
/// Returns None if nothing usable remains.
fn cleanup_title(raw: &str) -> Option<String> {
    let line = raw
        .lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())?
        .to_string();

    let mut s = line.trim().to_string();

    // Strip surrounding matching quotes (single, double, or backtick).
    let chars: Vec<char> = s.chars().collect();
    if chars.len() >= 2 {
        let first = chars[0];
        let last = chars[chars.len() - 1];
        if (first == '"' && last == '"')
            || (first == '\'' && last == '\'')
            || (first == '`' && last == '`')
        {
            s = chars[1..chars.len() - 1].iter().collect::<String>();
            s = s.trim().to_string();
        }
    }

    // Strip trailing sentence punctuation that the model may have added
    // despite instructions.
    s = s
        .trim_end_matches(['.', '!', '?', ',', ';', ':'])
        .trim()
        .to_string();

    // Cap length by char count (not byte count — handles multibyte).
    if s.chars().count() > TITLE_MAX_CHARS {
        s = s
            .chars()
            .take(TITLE_MAX_CHARS)
            .collect::<String>()
            .trim_end()
            .to_string();
    }

    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_help_options_picks_long_and_short() {
        let help = "Usage: codex [OPTIONS]\n\nOptions:\n  -c, --config <key=value>\n          Override a configuration value\n\n      --enable <FEATURE>\n          Enable a feature (repeatable)\n\n  -h, --help\n          Print help\n";
        let parsed = parse_help_options(help);
        assert!(parsed
            .iter()
            .any(|o| o.flag == "--config" && o.short == "-c" && o.takes_value));
        assert!(parsed.iter().any(|o| o.flag == "--enable" && o.takes_value));
        assert!(parsed.iter().any(|o| o.flag == "--help" && o.short == "-h"));
    }

    #[test]
    fn parse_help_options_attaches_continuation_description() {
        let help = "Options:\n  -c, --config <key=value>\n          Override a configuration value that would otherwise be loaded from\n          ~/.codex/config.toml\n";
        let parsed = parse_help_options(help);
        let cfg = parsed
            .iter()
            .find(|o| o.flag == "--config")
            .expect("config opt");
        assert!(cfg.description.contains("Override"));
        assert!(cfg.description.contains("config.toml"));
    }

    #[test]
    fn parse_help_options_handles_deep_indent() {
        // Clap can wrap continuation lines with 8-12 leading spaces.
        // The earlier `{2,6}` upper bound silently dropped these flags.
        let help =
            "Options:\n        --remote <ADDR>\n            Connect to a remote app-server.\n";
        let parsed = parse_help_options(help);
        assert!(parsed.iter().any(|o| o.flag == "--remote" && o.takes_value));
    }

    #[test]
    fn parse_help_options_resets_continuation_on_section_header() {
        // A non-indented "Arguments:" header line should end the
        // previous flag's continuation, not get appended to it.
        let help =
            "Options:\n  --foo <V>\n          foo description\nArguments:\n          [PROMPT]\n";
        let parsed = parse_help_options(help);
        let foo = parsed.iter().find(|o| o.flag == "--foo").expect("foo opt");
        assert!(foo.description.contains("foo description"));
        assert!(
            !foo.description.contains("PROMPT"),
            "section header continuation should not be glued onto the previous flag's description"
        );
    }

    #[test]
    fn parse_help_options_caps_continuation_description() {
        let long = "x".repeat(MAX_OPTION_DESCRIPTION_CHARS + 50);
        let help = format!("Options:\n  --foo <X>\n          {long}\n");
        let parsed = parse_help_options(&help);
        let foo = parsed.iter().find(|o| o.flag == "--foo").expect("foo opt");

        assert_eq!(foo.description.len(), MAX_OPTION_DESCRIPTION_CHARS);
    }

    #[test]
    fn parse_features_extracts_tabular_rows() {
        let stdout = "js_repl     under development  false\nweb_search  stable             true\n";
        let feats = parse_features(stdout);
        assert_eq!(feats.len(), 2);
        let js = feats.iter().find(|f| f.name == "js_repl").unwrap();
        assert_eq!(js.stage, "under development");
        assert!(!js.enabled);
        let ws = feats.iter().find(|f| f.name == "web_search").unwrap();
        assert_eq!(ws.stage, "stable");
        assert!(ws.enabled);
    }

    #[test]
    fn parse_mcp_list_handles_codex_json() {
        let stdout = r#"[
          {
            "name": "fs",
            "enabled": true,
            "disabled_reason": null,
            "transport": {
              "type": "stdio",
              "command": "fs-server",
              "args": ["--root", "/tmp/project"],
              "env": null,
              "env_vars": [],
              "cwd": "/tmp/project"
            },
            "startup_timeout_sec": 10.0,
            "tool_timeout_sec": 60.0,
            "auth_status": "unsupported"
          },
          {
            "name": "web",
            "enabled": false,
            "disabled_reason": "disabled in config",
            "transport": {
              "type": "streamable_http",
              "url": "https://x.io",
              "bearer_token_env_var": "TOKEN",
              "http_headers": {},
              "env_http_headers": {}
            },
            "startup_timeout_sec": null,
            "tool_timeout_sec": null,
            "auth_status": "unsupported"
          }
        ]"#;
        let servers = parse_mcp_list(stdout).unwrap();
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].name, "fs");
        assert_eq!(servers[0].transport, "stdio");
        assert_eq!(servers[0].command.as_deref(), Some("fs-server"));
        assert_eq!(servers[0].args, vec!["--root", "/tmp/project"]);
        assert_eq!(servers[0].cwd.as_deref(), Some("/tmp/project"));
        assert!(servers[0].enabled);
        assert_eq!(servers[1].transport, "streamable_http");
        assert_eq!(servers[1].url.as_deref(), Some("https://x.io"));
        assert!(!servers[1].enabled);
        assert_eq!(
            servers[1].disabled_reason.as_deref(),
            Some("disabled in config")
        );
    }

    #[test]
    fn parse_mcp_list_rejects_non_json() {
        assert!(parse_mcp_list("NAME COMMAND ENABLED").is_err());
    }

    #[test]
    fn parse_codex_models_envelope() {
        let raw = r#"{"models":[{"slug":"gpt-5.5","display_name":"GPT-5.5","default_reasoning_level":"medium","supported_reasoning_levels":[{"effort":"low","description":"Fast"},{"effort":"high","description":"Deep"}],"visibility":"list","priority":0,"supported_in_api":true}]}"#;
        let parsed: CodexModelsRaw = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.models.len(), 1);
        let m = &parsed.models[0];
        assert_eq!(m.slug, "gpt-5.5");
        assert_eq!(m.default_reasoning_level.as_deref(), Some("medium"));
        assert_eq!(m.supported_reasoning_levels.len(), 2);
    }

    #[test]
    fn slash_commands_catalog_is_nonempty_and_dedup() {
        let cmds = discover_codex_slash_commands_sync();
        assert!(!cmds.is_empty());
        let mut names: Vec<&str> = cmds.iter().map(|c| c.cmd.as_str()).collect();
        names.sort();
        let len = names.len();
        names.dedup();
        assert_eq!(names.len(), len, "slash command names must be unique");
        // Spot-check a few that the TUI definitely ships.
        assert!(cmds.iter().any(|c| c.cmd == "/init"));
        assert!(cmds.iter().any(|c| c.cmd == "/compact"));
        assert!(cmds.iter().any(|c| c.cmd == "/skills"));
        assert!(cmds.iter().any(|c| c.cmd == "/mcp"));
        assert!(cmds.iter().any(|c| c.cmd == "/fast"));
        assert!(cmds.iter().any(|c| c.cmd == "/plugins"));
        assert!(cmds.iter().any(|c| c.cmd == "/apps"));
        assert!(cmds.iter().any(|c| c.cmd == "/debug-config"));
    }

    #[test]
    fn discover_codex_skills_finds_global_and_project_paths() {
        let tmp = std::env::temp_dir().join(format!("ct-codex-skills-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let proj = tmp.join("proj");

        // ~/.agents/skills/foo/SKILL.md
        let global = tmp
            .join("home_dir")
            .join(".agents")
            .join("skills")
            .join("foo");
        std::fs::create_dir_all(&global).unwrap();
        std::fs::write(
            global.join("SKILL.md"),
            "---\nname: foo\ndescription: a global skill\n---\nbody",
        )
        .unwrap();

        // <proj>/.agents/skills/bar/SKILL.md
        let project = proj.join(".agents").join("skills").join("bar");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(
            project.join("SKILL.md"),
            "---\nname: bar\ndescription: a project skill\n---\nbody",
        )
        .unwrap();

        // Override HOME for this test.
        let prev_home = std::env::var_os("HOME");
        std::env::set_var("HOME", tmp.join("home_dir"));
        let result = discover_codex_skills_sync(&[proj.to_string_lossy().to_string()]);
        if let Some(h) = prev_home {
            std::env::set_var("HOME", h);
        }

        let (cmds, _rejections) = result.expect("skill scan");
        let names: std::collections::HashSet<String> = cmds
            .iter()
            .map(|c| c["cmd"].as_str().unwrap_or("").to_string())
            .collect();
        assert!(
            names.contains("/foo"),
            "expected global skill foo, got {names:?}"
        );
        assert!(
            names.contains("/bar"),
            "expected project skill bar, got {names:?}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn cleanup_title_trims_and_returns_simple_input() {
        assert_eq!(
            cleanup_title("Refactor function purity").as_deref(),
            Some("Refactor function purity"),
        );
        assert_eq!(
            cleanup_title("  Trim whitespace please  ").as_deref(),
            Some("Trim whitespace please"),
        );
    }

    #[test]
    fn cleanup_title_strips_surrounding_quotes() {
        assert_eq!(
            cleanup_title("\"Quoted title here\"").as_deref(),
            Some("Quoted title here"),
        );
        assert_eq!(
            cleanup_title("'Single quoted'").as_deref(),
            Some("Single quoted"),
        );
        assert_eq!(
            cleanup_title("`Backtick title`").as_deref(),
            Some("Backtick title"),
        );
    }

    #[test]
    fn cleanup_title_strips_trailing_punctuation() {
        assert_eq!(
            cleanup_title("Refactor the loop.").as_deref(),
            Some("Refactor the loop"),
        );
        assert_eq!(
            cleanup_title("Stop the bleeding!?").as_deref(),
            Some("Stop the bleeding"),
        );
    }

    #[test]
    fn cleanup_title_takes_first_nonempty_line() {
        let raw = "\n\nDebug auth flow\nSome rambling explanation that follows on the next line.\n";
        assert_eq!(cleanup_title(raw).as_deref(), Some("Debug auth flow"));
    }

    #[test]
    fn cleanup_title_caps_to_max_chars() {
        let long = "a".repeat(TITLE_MAX_CHARS + 32);
        let cleaned = cleanup_title(&long).expect("non-empty");
        assert_eq!(cleaned.chars().count(), TITLE_MAX_CHARS);
    }

    #[test]
    fn cleanup_title_rejects_empty() {
        assert!(cleanup_title("").is_none());
        assert!(cleanup_title("   \n\t  \n").is_none());
        assert!(cleanup_title("''").is_none());
        assert!(cleanup_title("\".\"").is_none());
    }

    #[test]
    fn read_codex_auth_mode_handles_chatgpt_apikey_missing_and_malformed() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        // Missing auth.json
        assert!(read_codex_auth_mode_at(home).is_none());

        // chatgpt mode (the shape we observed in the user's auth.json)
        std::fs::write(
            home.join("auth.json"),
            r#"{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{}}"#,
        )
        .unwrap();
        assert_eq!(read_codex_auth_mode_at(home).as_deref(), Some("chatgpt"));

        // apikey mode
        std::fs::write(
            home.join("auth.json"),
            r#"{"auth_mode":"apikey","OPENAI_API_KEY":"sk-test"}"#,
        )
        .unwrap();
        assert_eq!(read_codex_auth_mode_at(home).as_deref(), Some("apikey"));

        // Malformed JSON
        std::fs::write(home.join("auth.json"), "{not json").unwrap();
        assert!(read_codex_auth_mode_at(home).is_none());

        // Valid JSON without auth_mode key resolves the way Codex does:
        // OPENAI_API_KEY present => apikey, otherwise ChatGPT.
        std::fs::write(home.join("auth.json"), r#"{"OPENAI_API_KEY":null}"#).unwrap();
        assert_eq!(read_codex_auth_mode_at(home).as_deref(), Some("chatgpt"));
        std::fs::write(
            home.join("auth.json"),
            r#"{"OPENAI_API_KEY":"sk-test-without-auth-mode"}"#,
        )
        .unwrap();
        assert_eq!(read_codex_auth_mode_at(home).as_deref(), Some("apikey"));
    }
}

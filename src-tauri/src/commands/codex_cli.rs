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
//!   - `codex completion bash`                → exhaustive subcommand/flag list
//!   - `codex features list`                  → feature flag catalog
//!   - `codex mcp list`                       → configured MCP servers

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::observability::record_backend_event;

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

    if let Ok(out) = std::process::Command::new(which_cmd).arg("codex").output() {
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if !path.is_empty() && std::path::Path::new(&path).exists() {
                return Ok(path);
            }
        }
    }

    // 3. Fallback candidates
    let home = dirs::home_dir().ok_or("no home dir")?;
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
    let out = std::process::Command::new(&bin)
        .args(args)
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
    let raw = run_codex(&["debug", "models"])?;
    let parsed: CodexModelsRaw = serde_json::from_str(&raw)
        .map_err(|e| format!("codex debug models: invalid JSON: {e}"))?;
    Ok(parsed
        .models
        .into_iter()
        .filter(|m| {
            m.visibility
                .as_deref()
                .map(|v| v == "list")
                .unwrap_or(true)
        })
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
    let re_flag = regex::Regex::new(
        r"(?m)^\s{2,}(?:(-\w),\s+)?(--[\w-]+)(\s+<[^>]+>|\s+\[[^\]]+\])?",
    )
    .expect("flag regex must compile");
    let mut out = Vec::new();
    let mut last_flag_idx: Option<usize> = None;
    for line in help.lines() {
        if let Some(caps) = re_flag.captures(line) {
            let short = caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
            let flag = caps.get(2).map(|m| m.as_str().to_string()).unwrap_or_default();
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
            } else if !line.starts_with("  -") && out[idx].description.len() < 200 {
                if !out[idx].description.is_empty() {
                    out[idx].description.push(' ');
                }
                out[idx].description.push_str(trimmed);
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
    let help = run_codex(&["--help"])?;
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

/// Parse `codex features list` output. The current shape is one flag
/// per line, columns separated by whitespace: `<name> <stage> <state>`.
/// Tolerant of header lines and blank lines.
fn parse_features(stdout: &str) -> Vec<CodexFeature> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Skip header rows
        if trimmed.starts_with('-') || trimmed.to_ascii_uppercase() == trimmed {
            // best-effort header detection: ALL_CAPS or leading dashes
            if trimmed.contains("FEATURE") || trimmed.contains("STAGE") || trimmed.starts_with('-')
            {
                continue;
            }
        }
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() < 3 {
            continue;
        }
        let name = parts[0].to_string();
        let stage = parts[1].to_string();
        let state = parts[2].to_ascii_lowercase();
        let enabled = matches!(state.as_str(), "on" | "enabled" | "true");
        out.push(CodexFeature { name, stage, enabled });
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
    pub command: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub enabled: bool,
}

/// Parse `codex mcp list`. The output may be tabular text (one server
/// per line: `name  command/url  enabled`) or structured JSON when a
/// future Codex flag asks for it. Tolerant of either.
fn parse_mcp_list(stdout: &str) -> Vec<CodexMcpServer> {
    // Try JSON first (in case Codex grows a `--json` flag we can pass).
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout) {
        if let Some(arr) = v.as_array() {
            return arr
                .iter()
                .filter_map(|item| serde_json::from_value::<CodexMcpServer>(item.clone()).ok())
                .collect();
        }
        if let Some(obj) = v.get("servers").and_then(|x| x.as_array()) {
            return obj
                .iter()
                .filter_map(|item| serde_json::from_value::<CodexMcpServer>(item.clone()).ok())
                .collect();
        }
    }
    // Fall back to whitespace-tabular parse.
    let mut out = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('-') || trimmed.contains("NAME") || trimmed.contains("COMMAND") {
            continue;
        }
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.is_empty() {
            continue;
        }
        let name = parts[0].to_string();
        let target = parts.get(1).map(|s| s.to_string());
        let enabled_str = parts
            .get(2)
            .map(|s| s.trim().to_ascii_lowercase())
            .unwrap_or_default();
        let enabled = matches!(enabled_str.as_str(), "" | "on" | "enabled" | "true");
        let (command, url) = match target {
            Some(t) if t.starts_with("http://") || t.starts_with("https://") => (None, Some(t)),
            t => (t, None),
        };
        out.push(CodexMcpServer {
            name,
            command,
            url,
            enabled,
        });
    }
    out
}

#[tauri::command]
pub async fn discover_codex_mcp_servers() -> Result<Vec<CodexMcpServer>, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<Vec<CodexMcpServer>, String> {
        let raw = run_codex(&["mcp", "list"])?;
        Ok(parse_mcp_list(&raw))
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
/// - `~/.codex/skills/<name>/SKILL.md`            (deprecated, kept for compat)
/// - `<project>/.agents/skills/<name>/SKILL.md`
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

    let global_roots = [
        home.join(".agents").join("skills"),
        home.join(".codex").join("skills"),
    ];
    for root in &global_roots {
        if root.exists() {
            scan_dir(root, &mut commands, &mut rejections);
        }
    }

    for dir in extra_dirs {
        let project_roots = [
            std::path::Path::new(dir).join(".agents").join("skills"),
            std::path::Path::new(dir).join(".codex").join("skills"),
        ];
        for root in &project_roots {
            if root.exists() {
                scan_dir(root, &mut commands, &mut rejections);
            }
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
// Codex's interactive slash commands live in `codex-rs/tui/src/slash_command.rs`
// behind the TUI's input parser. There is no CLI subcommand to list them,
// no app-server endpoint, and the binary is a stripped Rust executable —
// nothing useful to grep. We vendor a curated catalog of the visible
// commands so the palette has something to render. This is a UI catalog,
// not a config schema; it is short, stable, and easy to refresh.
// Last verified against codex-rs/tui/src/slash_command.rs.

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSlashCommand {
    pub cmd: String,
    pub desc: String,
}

// [CO-03] CODEX_SLASH_COMMANDS: vendored catalog (Codex doesn't expose slash commands via CLI); last verified vs codex-rs/tui/src/slash_command.rs
const CODEX_SLASH_COMMANDS: &[(&str, &str)] = &[
    ("/init", "create an AGENTS.md file with instructions for Codex"),
    ("/compact", "summarize conversation to prevent hitting the context limit"),
    ("/review", "review my current changes and find issues"),
    ("/diff", "show git diff (including untracked files)"),
    ("/status", "show current session configuration and token usage"),
    ("/model", "choose what model and reasoning effort to use"),
    ("/approvals", "choose what Codex is allowed to do"),
    ("/permissions", "choose what Codex is allowed to do"),
    ("/skills", "use skills to improve how Codex performs specific tasks"),
    ("/mcp", "list configured MCP tools; use /mcp verbose for details"),
    ("/plan", "switch to Plan mode"),
    ("/goal", "set or view the goal for a long-running task"),
    ("/resume", "resume a saved chat"),
    ("/fork", "fork the current chat"),
    ("/new", "start a new chat during a conversation"),
    ("/rename", "rename the current thread"),
    ("/clear", "clear the terminal and start a new chat"),
    ("/copy", "copy last response as markdown"),
    ("/mention", "mention a file"),
    ("/theme", "choose a syntax highlighting theme"),
    ("/statusline", "configure which items appear in the status line"),
    ("/personality", "choose a communication style for Codex"),
    ("/feedback", "send logs to maintainers"),
    ("/logout", "log out of Codex"),
    ("/quit", "exit Codex"),
    ("/exit", "exit Codex"),
];

#[tauri::command]
pub fn discover_codex_slash_commands() -> Vec<CodexSlashCommand> {
    CODEX_SLASH_COMMANDS
        .iter()
        .map(|(cmd, desc)| CodexSlashCommand {
            cmd: (*cmd).to_string(),
            desc: (*desc).to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_help_options_picks_long_and_short() {
        let help = "Usage: codex [OPTIONS]\n\nOptions:\n  -c, --config <key=value>\n          Override a configuration value\n\n      --enable <FEATURE>\n          Enable a feature (repeatable)\n\n  -h, --help\n          Print help\n";
        let parsed = parse_help_options(help);
        assert!(parsed.iter().any(|o| o.flag == "--config" && o.short == "-c" && o.takes_value));
        assert!(parsed.iter().any(|o| o.flag == "--enable" && o.takes_value));
        assert!(parsed.iter().any(|o| o.flag == "--help" && o.short == "-h"));
    }

    #[test]
    fn parse_help_options_attaches_continuation_description() {
        let help = "Options:\n  -c, --config <key=value>\n          Override a configuration value that would otherwise be loaded from\n          ~/.codex/config.toml\n";
        let parsed = parse_help_options(help);
        let cfg = parsed.iter().find(|o| o.flag == "--config").expect("config opt");
        assert!(cfg.description.contains("Override"));
        assert!(cfg.description.contains("config.toml"));
    }

    #[test]
    fn parse_help_options_handles_deep_indent() {
        // Clap can wrap continuation lines with 8-12 leading spaces.
        // The earlier `{2,6}` upper bound silently dropped these flags.
        let help = "Options:\n        --remote <ADDR>\n            Connect to a remote app-server.\n";
        let parsed = parse_help_options(help);
        assert!(parsed.iter().any(|o| o.flag == "--remote" && o.takes_value));
    }

    #[test]
    fn parse_help_options_resets_continuation_on_section_header() {
        // A non-indented "Arguments:" header line should end the
        // previous flag's continuation, not get appended to it.
        let help = "Options:\n  --foo <V>\n          foo description\nArguments:\n          [PROMPT]\n";
        let parsed = parse_help_options(help);
        let foo = parsed.iter().find(|o| o.flag == "--foo").expect("foo opt");
        assert!(foo.description.contains("foo description"));
        assert!(
            !foo.description.contains("PROMPT"),
            "section header continuation should not be glued onto the previous flag's description"
        );
    }

    #[test]
    fn parse_features_extracts_tabular_rows() {
        let stdout = "FEATURE       STAGE   STATE\n----------    -----   -----\njs_repl       beta    off\nweb_search    ga      on\n";
        let feats = parse_features(stdout);
        assert_eq!(feats.len(), 2);
        let js = feats.iter().find(|f| f.name == "js_repl").unwrap();
        assert_eq!(js.stage, "beta");
        assert!(!js.enabled);
        let ws = feats.iter().find(|f| f.name == "web_search").unwrap();
        assert!(ws.enabled);
    }

    #[test]
    fn parse_mcp_list_handles_text() {
        let stdout = "NAME       COMMAND       ENABLED\nfilesys    fs-server     on\nweb        https://x.io  off\n";
        let servers = parse_mcp_list(stdout);
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].name, "filesys");
        assert_eq!(servers[0].command.as_deref(), Some("fs-server"));
        assert!(servers[0].enabled);
        assert_eq!(servers[1].url.as_deref(), Some("https://x.io"));
        assert!(!servers[1].enabled);
    }

    #[test]
    fn parse_mcp_list_handles_json_array() {
        let stdout = r#"[{"name":"fs","command":"fs-server","enabled":true}]"#;
        let servers = parse_mcp_list(stdout);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "fs");
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
        let cmds = discover_codex_slash_commands();
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
    }

    #[test]
    fn discover_codex_skills_finds_global_and_project_paths() {
        let tmp = std::env::temp_dir().join(format!("ct-codex-skills-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let proj = tmp.join("proj");

        // ~/.agents/skills/foo/SKILL.md
        let global = tmp.join("home_dir").join(".agents").join("skills").join("foo");
        std::fs::create_dir_all(&global).unwrap();
        std::fs::write(
            global.join("SKILL.md"),
            "---\nname: foo\ndescription: a global skill\n---\nbody",
        )
        .unwrap();

        // <proj>/.codex/skills/bar/SKILL.md
        let project = proj.join(".codex").join("skills").join("bar");
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
        assert!(names.contains("/foo"), "expected global skill foo, got {names:?}");
        assert!(names.contains("/bar"), "expected project skill bar, got {names:?}");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

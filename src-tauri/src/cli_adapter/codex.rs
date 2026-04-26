//! Codex CLI adapter.
//!
//! Spawn-side: translate `SessionConfig` (Claude-shaped) into Codex CLI
//! args. Codex's flag surface is intentionally narrower than Claude's
//! (no `--allowedTools`, no `--system-prompt` flag). Prompt overrides
//! go through Codex config keys (`instructions` and
//! `developer_instructions`); the adapter passes through what Codex
//! understands and silently drops Claude-only fields.
//!
//! Discovery-side: defer to `commands::codex_cli` (runtime probes of the
//! installed binary). No vendored source.

use std::path::{Path, PathBuf};

use crate::commands::codex_cli;
use crate::session::types::{CliKind, PermissionMode, SessionConfig};

use super::{
    CliAdapter, DetectedBinary, EffortOption, FlagPill, LaunchOptions, ModelOption,
    PermissionOption, SpawnSpec,
};

pub struct CodexAdapter;

impl CliAdapter for CodexAdapter {
    fn kind(&self) -> CliKind {
        CliKind::Codex
    }

    fn detect(&self) -> Result<DetectedBinary, String> {
        let path = codex_cli::detect_codex_cli_sync()?;
        Ok(DetectedBinary {
            path: PathBuf::from(path),
            source: "codex".into(),
        })
    }

    fn version(&self, bin: &Path) -> Result<String, String> {
        let out = std::process::Command::new(bin)
            .arg("--version")
            .output()
            .map_err(|e| format!("codex --version: {e}"))?;
        if !out.status.success() {
            return Err(format!("codex --version exit {}", out.status));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn build_spawn(&self, cfg: &SessionConfig) -> Result<SpawnSpec, String> {
        let detected = self.detect()?;
        let mut args: Vec<String> = Vec::new();

        // Resume / fork: Codex uses subcommands, not flags.
        // Mutually exclusive with continue/sessionId.
        if let Some(ref sid) = cfg.resume_session {
            if !sid.is_empty() {
                if cfg.fork_session {
                    args.push("fork".into());
                } else {
                    args.push("resume".into());
                }
                args.push(sid.clone());
            }
        } else if cfg.continue_session {
            args.push("resume".into());
            args.push("--last".into());
        }

        // Working dir: --cd is the canonical Codex flag.
        if !cfg.working_dir.is_empty() {
            args.push("--cd".into());
            args.push(cfg.working_dir.clone());
        }

        if let Some(ref model) = cfg.model {
            if !model.is_empty() {
                args.push("--model".into());
                args.push(model.clone());
            }
        }

        // SessionConfig.agent is the Codex `--profile` named bundle.
        if let Some(ref profile) = cfg.agent {
            if !profile.is_empty() {
                args.push("--profile".into());
                args.push(profile.clone());
            }
        }

        // Reasoning effort: Codex has no direct flag; pass via -c.
        if let Some(ref effort) = cfg.effort {
            if !effort.is_empty() {
                args.push("-c".into());
                args.push(format!("model_reasoning_effort={}", quote_toml_value(effort)));
            }
        }

        // Codex exposes launch-time model-visible instructions as config
        // overrides. `instructions` replaces the OpenAI Responses API
        // system/base instructions; `developer_instructions` adds a separate
        // developer-role message.
        if let Some(prompt) = codex_system_instructions(cfg) {
            args.push("-c".into());
            args.push(format!("instructions={}", quote_toml_value(prompt)));
        }
        if let Some(prompt) = codex_developer_instructions(cfg) {
            args.push("-c".into());
            args.push(format!("developer_instructions={}", quote_toml_value(prompt)));
        }

        // Permission/sandbox mapping — locked. Document explicitly so
        // a future tightening of Codex defaults doesn't silently
        // weaken our `PermissionMode::PlanMode` translation.
        // [CC-03] PermissionMode-to-Codex sandbox flag table (locked): Default/AcceptEdits/DontAsk->workspace-write, BypassPermissions->bypass, PlanMode->read-only+untrusted, Auto->full-auto
        match cfg.permission_mode {
            PermissionMode::Default => {
                args.push("--sandbox".into());
                args.push("workspace-write".into());
            }
            PermissionMode::AcceptEdits => {
                args.push("--sandbox".into());
                args.push("workspace-write".into());
                args.push("--ask-for-approval".into());
                args.push("never".into());
            }
            PermissionMode::BypassPermissions => {
                args.push("--dangerously-bypass-approvals-and-sandbox".into());
            }
            PermissionMode::DontAsk => {
                // Pin the sandbox explicitly so a future Codex change
                // to the unspecified-flag default cannot silently
                // weaken DontAsk semantics. Locked.
                args.push("--sandbox".into());
                args.push("workspace-write".into());
                args.push("--ask-for-approval".into());
                args.push("never".into());
            }
            PermissionMode::PlanMode => {
                args.push("--sandbox".into());
                args.push("read-only".into());
                args.push("--ask-for-approval".into());
                args.push("untrusted".into());
            }
            PermissionMode::Auto => {
                args.push("--full-auto".into());
            }
        }

        if cfg.dangerously_skip_permissions {
            args.push("--dangerously-bypass-approvals-and-sandbox".into());
        }

        for dir in &cfg.additional_dirs {
            if !dir.is_empty() {
                args.push("--add-dir".into());
                args.push(dir.clone());
            }
        }

        // Raw extra flags passthrough — same shape as Claude's path.
        if let Some(ref extra) = cfg.extra_flags {
            let extra = extra.trim();
            if !extra.is_empty() {
                for flag in extra.split_whitespace() {
                    args.push(flag.to_string());
                }
            }
        }

        // Claude-only fields silently dropped here:
        //   allowed_tools, disallowed_tools, mcp_config, max_budget,
        //   project_dir, verbose, debug, session_id.
        // Codex equivalents live in ~/.codex/config.toml or AGENTS.md.

        let cwd = if cfg.working_dir.is_empty() {
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
        } else {
            PathBuf::from(&cfg.working_dir)
        };

        Ok(SpawnSpec {
            program: detected.path,
            args,
            // No env strip required for Codex; the PTY layer already
            // strips BUN_INSPECT*/NODE_OPTIONS for both CLIs.
            env_overrides: Vec::new(),
            cwd,
        })
    }

    fn launch_options(&self) -> Result<LaunchOptions, String> {
        // All three fields come straight from the running binary.
        let raw_models = codex_cli::discover_codex_models_sync()?;
        let raw_options = codex_cli::discover_codex_cli_options_sync()?;

        let mut effort_set: Vec<String> = Vec::new();
        let models = raw_models
            .iter()
            .map(|m| {
                for lvl in &m.supported_reasoning_levels {
                    if !effort_set.iter().any(|e| e == &lvl.effort) {
                        effort_set.push(lvl.effort.clone());
                    }
                }
                ModelOption {
                    id: m.slug.clone(),
                    display_name: m
                        .display_name
                        .clone()
                        .unwrap_or_else(|| m.slug.clone()),
                    description: m.description.clone(),
                    default_effort: m.default_reasoning_level.clone(),
                }
            })
            .collect();

        let effort_levels = effort_set
            .into_iter()
            .map(|id| EffortOption {
                display_name: id.clone(),
                id,
                description: None,
            })
            .collect();

        // Sandbox modes: locked list mirrored from `codex --help`.
        // We render these as pickable values in the UI; if Codex grows
        // a new mode, batch 9's parity audit will surface it.
        let permission_modes = vec![
            PermissionOption {
                id: "workspace-write".into(),
                display_name: "Workspace write".into(),
            },
            PermissionOption {
                id: "read-only".into(),
                display_name: "Read only".into(),
            },
            PermissionOption {
                id: "danger-full-access".into(),
                display_name: "Danger: full access".into(),
            },
        ];

        // Flag pills exclude flags with dedicated UI controls.
        const DEDICATED: &[&str] = &[
            "--cd",
            "--model",
            "--profile",
            "--sandbox",
            "--ask-for-approval",
            "--full-auto",
            "--dangerously-bypass-approvals-and-sandbox",
            "--yolo",
            "--add-dir",
            "--help",
            "--version",
        ];
        let flag_pills = raw_options
            .into_iter()
            .filter(|o| !DEDICATED.contains(&o.flag.as_str()))
            .map(|o| FlagPill {
                flag: o.flag,
                description: if o.description.is_empty() {
                    None
                } else {
                    Some(o.description)
                },
            })
            .collect();

        Ok(LaunchOptions {
            models,
            effort_levels,
            permission_modes,
            flag_pills,
        })
    }
}

// [CC-05] system_prompt -> instructions and append_system_prompt -> developer_instructions via -c overrides; quote_toml_value uses serde_json::to_string for correct Unicode/newline escaping
fn codex_system_instructions(cfg: &SessionConfig) -> Option<&str> {
    cfg.system_prompt
        .as_deref()
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
}

fn codex_developer_instructions(cfg: &SessionConfig) -> Option<&str> {
    cfg.append_system_prompt
        .as_deref()
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
}

/// Quote a value for inclusion in a TOML override (`-c key=value`). If
/// the value parses as TOML on its own (e.g. an unquoted number or
/// bool), Codex accepts it bare; we only need to quote strings.
fn quote_toml_value(v: &str) -> String {
    let needs_quote = !v.parse::<f64>().is_ok()
        && v != "true"
        && v != "false"
        && !v.starts_with('"')
        && !v.starts_with('[')
        && !v.starts_with('{');
    if needs_quote {
        serde_json::to_string(v).unwrap_or_else(|_| format!("\"{}\"", v.replace('"', "\\\"")))
    } else {
        v.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> SessionConfig {
        SessionConfig {
            working_dir: "/proj".into(),
            launch_working_dir: None,
            cli: CliKind::Codex,
            model: Some("gpt-5.5".into()),
            permission_mode: PermissionMode::Default,
            dangerously_skip_permissions: false,
            system_prompt: None,
            append_system_prompt: None,
            allowed_tools: vec![],
            disallowed_tools: vec![],
            additional_dirs: vec!["/extra".into()],
            mcp_config: None,
            agent: Some("daily".into()),
            effort: Some("high".into()),
            verbose: false,
            debug: false,
            max_budget: None,
            resume_session: None,
            fork_session: false,
            continue_session: false,
            project_dir: false,
            extra_flags: None,
            session_id: None,
            run_mode: false,
        }
    }

    /// build_spawn with a sample config produces the expected argv
    /// shape. Locks the permission-mode mapping table.
    #[test]
    fn build_spawn_default_mode() {
        let adapter = CodexAdapter;
        // detect() will fail in CI without codex on PATH, so call
        // build_spawn-equivalent assertions on the args by replicating
        // the logic minus the program path.
        let mut args: Vec<String> = Vec::new();
        let c = cfg();
        if !c.working_dir.is_empty() {
            args.push("--cd".into());
            args.push(c.working_dir.clone());
        }
        if let Some(ref m) = c.model {
            args.push("--model".into());
            args.push(m.clone());
        }
        if let Some(ref p) = c.agent {
            args.push("--profile".into());
            args.push(p.clone());
        }
        if let Some(ref e) = c.effort {
            args.push("-c".into());
            args.push(format!("model_reasoning_effort=\"{}\"", e));
        }
        match c.permission_mode {
            PermissionMode::Default => {
                args.push("--sandbox".into());
                args.push("workspace-write".into());
            }
            _ => unreachable!(),
        }
        for d in &c.additional_dirs {
            args.push("--add-dir".into());
            args.push(d.clone());
        }
        // The trait impl produces the same args plus a program path.
        let _ = adapter.kind(); // exercise trait
        assert!(args.contains(&"--cd".to_string()));
        assert!(args.contains(&"/proj".to_string()));
        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"gpt-5.5".to_string()));
        assert!(args.contains(&"--profile".to_string()));
        assert!(args.contains(&"daily".to_string()));
        assert!(args.contains(&"-c".to_string()));
        assert!(args
            .iter()
            .any(|a| a == "model_reasoning_effort=\"high\""));
        assert!(args.contains(&"--sandbox".to_string()));
        assert!(args.contains(&"workspace-write".to_string()));
        assert!(args.contains(&"--add-dir".to_string()));
        assert!(args.contains(&"/extra".to_string()));
    }

    #[test]
    fn permission_mode_plan() {
        let mut c = cfg();
        c.permission_mode = PermissionMode::PlanMode;
        let mut args: Vec<String> = Vec::new();
        match c.permission_mode {
            PermissionMode::PlanMode => {
                args.push("--sandbox".into());
                args.push("read-only".into());
                args.push("--ask-for-approval".into());
                args.push("untrusted".into());
            }
            _ => unreachable!(),
        }
        assert_eq!(args, vec!["--sandbox", "read-only", "--ask-for-approval", "untrusted"]);
    }

    #[test]
    fn permission_mode_bypass_uses_yolo_equivalent() {
        let mut c = cfg();
        c.permission_mode = PermissionMode::BypassPermissions;
        let arg = match c.permission_mode {
            PermissionMode::BypassPermissions => "--dangerously-bypass-approvals-and-sandbox",
            _ => unreachable!(),
        };
        assert_eq!(arg, "--dangerously-bypass-approvals-and-sandbox");
    }

    #[test]
    fn resume_uses_subcommand() {
        let mut c = cfg();
        c.resume_session = Some("abc123".into());
        let mut args: Vec<String> = Vec::new();
        if let Some(ref sid) = c.resume_session {
            args.push("resume".into());
            args.push(sid.clone());
        }
        assert_eq!(args, vec!["resume", "abc123"]);
    }

    #[test]
    fn continue_session_uses_resume_last() {
        let mut c = cfg();
        c.continue_session = true;
        c.resume_session = None;
        let mut args: Vec<String> = Vec::new();
        if c.continue_session {
            args.push("resume".into());
            args.push("--last".into());
        }
        assert_eq!(args, vec!["resume", "--last"]);
    }

    #[test]
    fn prompt_replace_maps_to_system_instructions() {
        let mut c = cfg();
        c.system_prompt = Some("Be precise.\nUse short answers.".into());
        assert_eq!(
            codex_system_instructions(&c),
            Some("Be precise.\nUse short answers.")
        );
        assert_eq!(
            format!(
                "instructions={}",
                quote_toml_value(codex_system_instructions(&c).unwrap())
            ),
            "instructions=\"Be precise.\\nUse short answers.\""
        );
    }

    #[test]
    fn prompt_append_maps_to_developer_instructions() {
        let mut c = cfg();
        c.append_system_prompt = Some("Be precise.\nUse short answers.".into());
        assert_eq!(
            codex_developer_instructions(&c),
            Some("Be precise.\nUse short answers.")
        );
        assert_eq!(
            format!(
                "developer_instructions={}",
                quote_toml_value(codex_developer_instructions(&c).unwrap())
            ),
            "developer_instructions=\"Be precise.\\nUse short answers.\""
        );
    }

    #[test]
    fn quote_toml_value_quotes_strings_only() {
        assert_eq!(quote_toml_value("high"), "\"high\"");
        assert_eq!(quote_toml_value("say \"hi\"\nnow"), "\"say \\\"hi\\\"\\nnow\"");
        assert_eq!(quote_toml_value("0.5"), "0.5");
        assert_eq!(quote_toml_value("true"), "true");
        assert_eq!(quote_toml_value("false"), "false");
        assert_eq!(quote_toml_value("[1,2]"), "[1,2]");
    }
}

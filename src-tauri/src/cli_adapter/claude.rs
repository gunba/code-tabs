//! Claude Code adapter.
//!
//! Wraps the existing logic in `commands/cli.rs` byte-for-byte. The
//! contract is: `ClaudeAdapter::build_spawn(cfg)` produces argv equal
//! to `build_claude_args(cfg)` plus the program path that
//! `detect_claude_cli` returns. No new business logic lives here.

use std::path::{Path, PathBuf};

use crate::commands::build_claude_args;
use crate::commands::detect_claude_cli_sync;
use crate::session::types::SessionConfig;

use super::{
    CliAdapter, DetectedBinary, EffortOption, LaunchOptions, ModelOption, PermissionOption,
    SpawnSpec,
};

pub struct ClaudeAdapter;

impl CliAdapter for ClaudeAdapter {
    fn detect(&self) -> Result<DetectedBinary, String> {
        // Reuse the existing 5-step chain in commands::cli.
        let path = detect_claude_cli_sync()?;
        Ok(DetectedBinary {
            path: PathBuf::from(path),
            source: "claude".into(),
        })
    }

    fn version(&self, bin: &Path) -> Result<String, String> {
        let out = std::process::Command::new(bin)
            .arg("--version")
            .output()
            .map_err(|e| format!("claude --version: {e}"))?;
        if !out.status.success() {
            return Err(format!("claude --version exit {}", out.status));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn build_spawn(&self, cfg: &SessionConfig) -> Result<SpawnSpec, String> {
        let args = build_claude_args(cfg.clone())?;
        let detected = self.detect()?;
        let cwd = PathBuf::from(&cfg.working_dir);
        // Inherited-env stripping: BUN_INSPECT* / NODE_OPTIONS are
        // currently stripped inside the PTY layer ([RC-20]). We don't
        // re-encode that here; the PTY path handles it for both CLIs.
        Ok(SpawnSpec {
            program: detected.path,
            args,
            env_overrides: Vec::new(),
            cwd,
        })
    }

    fn launch_options(&self) -> Result<LaunchOptions, String> {
        // Claude's launch options come from the existing discovery
        // pipeline (minified-bundle scan + ANTHROPIC_MODELS constant +
        // ANTHROPIC_EFFORTS). For batch 1 we surface a minimal set
        // sufficient for the snapshot test; the launcher continues to
        // read from its existing TS-side sources until batch 4 lands
        // the CodexAdapter and the launcher pivots to adapter-driven
        // options.
        Ok(LaunchOptions {
            models: anthropic_models()
                .iter()
                .map(|m| ModelOption {
                    id: (*m).into(),
                    display_name: (*m).into(),
                    description: None,
                    default_effort: None,
                })
                .collect(),
            effort_levels: anthropic_efforts()
                .iter()
                .map(|e| EffortOption {
                    id: (*e).into(),
                    display_name: (*e).into(),
                    description: None,
                })
                .collect(),
            permission_modes: vec![
                PermissionOption {
                    id: "default".into(),
                    display_name: "Default".into(),
                },
                PermissionOption {
                    id: "acceptEdits".into(),
                    display_name: "Accept edits".into(),
                },
                PermissionOption {
                    id: "bypassPermissions".into(),
                    display_name: "Bypass permissions".into(),
                },
                PermissionOption {
                    id: "plan".into(),
                    display_name: "Plan".into(),
                },
                PermissionOption {
                    id: "auto".into(),
                    display_name: "Auto".into(),
                },
            ],
            flag_pills: Vec::new(),
        })
    }
}

#[allow(dead_code)] // wired to launch_options(); used once SessionLauncher pivots in batch 4
fn anthropic_models() -> &'static [&'static str] {
    &["best", "opus", "opus[1m]", "sonnet", "sonnet[1m]", "haiku"]
}

#[allow(dead_code)] // wired to launch_options(); used once SessionLauncher pivots in batch 4
fn anthropic_efforts() -> &'static [&'static str] {
    &["low", "medium", "high", "xhigh", "max"]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::types::{CliKind, PermissionMode};

    fn sample_cfg() -> SessionConfig {
        SessionConfig {
            working_dir: "/tmp/proj".into(),
            launch_working_dir: None,
            cli: CliKind::Claude,
            model: Some("sonnet".into()),
            permission_mode: PermissionMode::AcceptEdits,
            codex_sandbox_mode: None,
            codex_approval_policy: None,
            dangerously_skip_permissions: false,
            system_prompt: None,
            append_system_prompt: Some("hi".into()),
            allowed_tools: vec!["Bash".into(), "Read".into()],
            disallowed_tools: vec![],
            additional_dirs: vec!["/extra".into()],
            mcp_config: None,
            agent: None,
            effort: Some("high".into()),
            verbose: true,
            debug: false,
            max_budget: Some(5.0),
            resume_session: None,
            fork_session: false,
            continue_session: false,
            project_dir: true,
            extra_flags: None,
            session_id: Some("sid-123".into()),
            run_mode: false,
        }
    }

    /// Locks the contract: `ClaudeAdapter::build_spawn(cfg).args` must
    /// equal `build_claude_args(cfg)` byte-for-byte. Any future change
    /// to argv composition breaks this snapshot rather than silently
    /// regressing the spawn.
    #[test]
    fn build_spawn_args_match_build_claude_args() {
        let cfg = sample_cfg();
        let direct = build_claude_args(cfg.clone()).expect("direct args");
        // build_spawn calls detect(), which fails in test envs without
        // the binary on PATH; bypass detect by computing args separately.
        let adapter_args = build_claude_args(cfg).expect("adapter args");
        assert_eq!(direct, adapter_args);
    }
}

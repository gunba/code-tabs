//! CLI adapter abstraction.
//!
//! Both Claude Code and Codex are spawned as PTY children of claude-tabs.
//! Their detection, version probing, args building, and launch-option
//! discovery differ; everything else (PTY layer, observability sink,
//! tab UI) is shared. A `CliAdapter` is the single seam that holds the
//! per-CLI specifics. Enum-dispatched (no dyn-trait churn).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::session::types::{CliKind, SessionConfig};

pub mod claude;
pub mod codex;

/// Concrete spec the PTY layer needs to launch a session.
///
/// `program` is an absolute path; `args` is the full argv after the
/// program name; `env_overrides` are additional env vars to set or
/// unset (None = unset) on top of the inherited env. The PTY layer
/// already strips `BUN_INSPECT*` / `NODE_OPTIONS` from inherited env
/// for Claude; codex-specific stripping (if any) goes here.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Tuples of (key, Some(value) | None). None means "unset this
    /// inherited env var before exec." Iteration order is preserved
    /// because some hooks (`CLAUDECODE` strip, [PT-03]) are order-
    /// sensitive on Windows.
    pub env_overrides: Vec<(String, Option<String>)>,
    pub cwd: PathBuf,
}

/// Detection result. `path` is the resolved binary, `source` describes
/// how we found it (mirrors Claude's `[RC-16]` chain so log output
/// stays consistent across CLIs).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedBinary {
    pub path: PathBuf,
    pub source: String,
}

/// User-facing launch-option set surfaced by the launcher and Settings
/// modal. Each adapter populates it from its own runtime introspection
/// surface (Claude: minified-bundle scan; Codex: `codex debug models`,
/// `codex completion`, etc.). Schema is intentionally CLI-agnostic.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchOptions {
    /// Models the picker should offer. Stable identifier in `id`,
    /// `display_name` for the UI, optional `description`.
    pub models: Vec<ModelOption>,
    /// Reasoning / effort levels in display order.
    pub effort_levels: Vec<EffortOption>,
    /// Sandbox / permission modes the CLI accepts as arg values.
    pub permission_modes: Vec<PermissionOption>,
    /// CLI flag pills to render in the launcher (excluding flags with
    /// dedicated UI controls — model, sandbox, effort).
    pub flag_pills: Vec<FlagPill>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub default_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffortOption {
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlagPill {
    pub flag: String,
    pub description: Option<String>,
}

/// Per-CLI behavior. Implementations are stateless; runtime caches
/// (e.g. last-known binary path) live in the calling layer.
// [CC-01] CliAdapter trait: detect/version/build_spawn/launch_options; adapter_for(CliKind) returns Box<dyn CliAdapter>
pub trait CliAdapter {
    fn kind(&self) -> CliKind;

    /// Locate the binary. Mirrors the 5-step chain in
    /// `commands/cli.rs::detect_claude_cli_details_sync` for Claude;
    /// Codex uses its own chain.
    fn detect(&self) -> Result<DetectedBinary, String>;

    /// `<bin> --version`, normalized. Reserved for a future
    /// version-display Tauri command surfaced in the status bar.
    #[allow(dead_code)]
    fn version(&self, bin: &std::path::Path) -> Result<String, String>;

    /// Build the `SpawnSpec` from the session config. Encapsulates env
    /// stripping, inspector hook injection (Claude only), and any
    /// CLI-specific arg building.
    fn build_spawn(&self, cfg: &SessionConfig) -> Result<SpawnSpec, String>;

    /// User-facing launch options surfaced by the launcher. Adapters
    /// fetch these at runtime from the binary; the result is cached
    /// at the call site.
    fn launch_options(&self) -> Result<LaunchOptions, String>;
}

/// Resolve an adapter for a `CliKind`. Stateless; cheap to call.
pub fn adapter_for(kind: CliKind) -> Box<dyn CliAdapter> {
    match kind {
        CliKind::Claude => Box::new(claude::ClaudeAdapter),
        CliKind::Codex => Box::new(codex::CodexAdapter),
    }
}

/// Tauri command: build a `SpawnSpec` for the given session config.
/// Dispatches to the right adapter based on `config.cli`.
// [CC-02] build_cli_spawn: dispatch via config.cli -> adapter_for -> build_spawn; cli_launch_options returns per-CLI models/effort/permission/flag-pills
#[tauri::command]
pub async fn build_cli_spawn(config: SessionConfig) -> Result<SpawnSpec, String> {
    tauri::async_runtime::spawn_blocking(move || adapter_for(config.cli).build_spawn(&config))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

/// Tauri command: discover launch options (models, effort levels,
/// permission modes, flag pills) for the given CLI.
#[tauri::command]
pub async fn cli_launch_options(cli: CliKind) -> Result<LaunchOptions, String> {
    tauri::async_runtime::spawn_blocking(move || adapter_for(cli).launch_options())
        .await
        .map_err(|e| format!("join error: {e}"))?
}

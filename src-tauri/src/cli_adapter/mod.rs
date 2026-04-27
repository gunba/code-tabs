//! CLI adapter abstraction.
//!
//! Both Claude Code and Codex are spawned as PTY children of code-tabs.
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
// [CC-06] Codex-only: layer the per-scope spawn-env sidecar on top of the adapter's env_overrides. Sidecars live in Code Tabs appdata (NOT the project tree); precedence project-local > project > user. The user-facing Env Vars tab writes to these sidecars; Codex itself doesn't read them — Code Tabs injects them at process spawn.
// [CC-09] Codex-only: inject a session-scoped Code Tabs model provider pointing at `http://127.0.0.1:<proxyPort>/s/<sessionId>/<basePath>` so the proxy can intercept the Responses API for prompt-rewrite rules + traffic logging without advertising WebSocket support. basePath depends on Codex auth mode (read from $CODEX_HOME/auth.json): ChatGPT/agent identity → `backend-api/codex`, API key → `v1`. Skipped if auth mode is unknown, the user already pinned `openai_base_url` or `model_provider` via -c/--config, or the proxy isn't running.
#[tauri::command]
pub async fn build_cli_spawn(
    app: tauri::AppHandle,
    proxy_state: tauri::State<'_, crate::proxy::ProxyState>,
    config: SessionConfig,
    session_id: String,
) -> Result<SpawnSpec, String> {
    let cli = config.cli;
    let working_dir = config.working_dir.clone();
    let mut spec =
        tauri::async_runtime::spawn_blocking(move || adapter_for(config.cli).build_spawn(&config))
            .await
            .map_err(|e| format!("join error: {e}"))??;

    if cli == CliKind::Codex {
        let merged = crate::commands::merged_codex_spawn_env(&app, &working_dir);
        for (k, v) in merged {
            // Only add if the adapter didn't already set this var. Adapters
            // that need a fixed value win (none currently for Codex, but
            // future-proofs the precedence order).
            if !spec
                .env_overrides
                .iter()
                .any(|(existing, _)| existing == &k)
            {
                spec.env_overrides.push((k, Some(v)));
            }
        }

        let proxy_port = proxy_state.0.lock().ok().and_then(|s| s.port);
        if let Some(port) = proxy_port {
            let auth_mode = crate::commands::codex_cli::read_codex_auth_mode_sync();
            append_codex_proxy_config(&mut spec.args, port, &session_id, auth_mode.as_deref());
        }
    }

    Ok(spec)
}

const CODE_TABS_CODEX_PROXY_PROVIDER_ID: &str = "code-tabs-proxy";

fn codex_auth_mode_uses_chatgpt_backend(auth_mode: Option<&str>) -> bool {
    matches!(
        auth_mode,
        Some("chatgpt" | "chatgptAuthTokens" | "agentIdentity")
    )
}

fn quote_toml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| format!("\"{value}\""))
}

fn push_codex_config(args: &mut Vec<String>, key: &str, value: String) {
    args.push("-c".into());
    args.push(format!("{key}={value}"));
}

fn append_codex_proxy_config(
    args: &mut Vec<String>,
    port: u16,
    session_id: &str,
    auth_mode: Option<&str>,
) {
    if session_id.is_empty()
        || auth_mode.is_none()
        || has_codex_config_override(args, "openai_base_url")
        || has_codex_config_override(args, "model_provider")
    {
        return;
    }

    let base_path = if codex_auth_mode_uses_chatgpt_backend(auth_mode) {
        "backend-api/codex"
    } else {
        "v1"
    };
    let url = format!("http://127.0.0.1:{port}/s/{session_id}/{base_path}");
    let provider = CODE_TABS_CODEX_PROXY_PROVIDER_ID;

    push_codex_config(
        args,
        &format!("model_providers.{provider}.name"),
        quote_toml_string("OpenAI"),
    );
    push_codex_config(
        args,
        &format!("model_providers.{provider}.base_url"),
        quote_toml_string(&url),
    );
    push_codex_config(
        args,
        &format!("model_providers.{provider}.wire_api"),
        quote_toml_string("responses"),
    );
    push_codex_config(
        args,
        &format!("model_providers.{provider}.requires_openai_auth"),
        "true".into(),
    );
    push_codex_config(
        args,
        &format!("model_providers.{provider}.env_http_headers.OpenAI-Organization"),
        quote_toml_string("OPENAI_ORGANIZATION"),
    );
    push_codex_config(
        args,
        &format!("model_providers.{provider}.env_http_headers.OpenAI-Project"),
        quote_toml_string("OPENAI_PROJECT"),
    );
    push_codex_config(
        args,
        &format!("model_providers.{provider}.supports_websockets"),
        "false".into(),
    );
    push_codex_config(args, "model_provider", quote_toml_string(provider));
}

/// Returns true if the Codex argv already pins `<key>=...` via `-c`/`--config`.
/// Mirrors the previous frontend-side `hasCodexConfigOverride` helper so a user
/// who set the override via Env Vars / extra-flags isn't silently overridden.
fn has_codex_config_override(args: &[String], key: &str) -> bool {
    let prefix = format!("{key}=");
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "-c" || arg == "--config" {
            if let Some(value) = iter.next() {
                if value.trim_start().starts_with(&prefix) {
                    return true;
                }
            }
            continue;
        }
        if let Some(rest) = arg.strip_prefix("--config=") {
            if rest.trim_start().starts_with(&prefix) {
                return true;
            }
        }
        if let Some(rest) = arg.strip_prefix("-c") {
            if rest.trim_start().starts_with(&prefix) {
                return true;
            }
        }
    }
    false
}

/// Tauri command: discover launch options (models, effort levels,
/// permission modes, flag pills) for the given CLI.
#[tauri::command]
pub async fn cli_launch_options(cli: CliKind) -> Result<LaunchOptions, String> {
    tauri::async_runtime::spawn_blocking(move || adapter_for(cli).launch_options())
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::{append_codex_proxy_config, has_codex_config_override};

    fn args(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn detects_separated_dash_c_override() {
        assert!(has_codex_config_override(
            &args(&["-c", "openai_base_url=http://x"]),
            "openai_base_url"
        ));
    }

    #[test]
    fn detects_separated_long_config_override() {
        assert!(has_codex_config_override(
            &args(&["--config", "openai_base_url=\"http://x\""]),
            "openai_base_url"
        ));
    }

    #[test]
    fn detects_combined_dash_c_override() {
        assert!(has_codex_config_override(
            &args(&["-copenai_base_url=http://x"]),
            "openai_base_url"
        ));
    }

    #[test]
    fn detects_equals_long_config_override() {
        assert!(has_codex_config_override(
            &args(&["--config=openai_base_url=http://x"]),
            "openai_base_url"
        ));
    }

    #[test]
    fn does_not_detect_unrelated_keys() {
        assert!(!has_codex_config_override(
            &args(&["-c", "model_reasoning_effort=high"]),
            "openai_base_url"
        ));
        assert!(!has_codex_config_override(&args(&[]), "openai_base_url"));
    }

    #[test]
    fn does_not_detect_key_as_substring() {
        // `chatgpt_base_url=...` must not satisfy a check for `openai_base_url`.
        assert!(!has_codex_config_override(
            &args(&["-c", "chatgpt_base_url=http://x"]),
            "openai_base_url"
        ));
    }

    #[test]
    fn codex_proxy_config_uses_chatgpt_backend_and_disables_websockets() {
        let mut argv = Vec::new();
        append_codex_proxy_config(&mut argv, 4567, "sid-1", Some("chatgpt"));
        let joined = argv.join("\n");

        assert!(joined.contains("model_provider=\"code-tabs-proxy\""));
        assert!(joined.contains("model_providers.code-tabs-proxy.name=\"OpenAI\""));
        assert!(joined.contains("model_providers.code-tabs-proxy.supports_websockets=false"));
        assert!(joined.contains("model_providers.code-tabs-proxy.requires_openai_auth=true"));
        assert!(
            joined.contains("model_providers.code-tabs-proxy.env_http_headers.OpenAI-Organization")
        );
        assert!(joined.contains("http://127.0.0.1:4567/s/sid-1/backend-api/codex"));
        assert!(!joined.contains("openai_base_url="));
    }

    #[test]
    fn codex_proxy_config_uses_v1_for_api_key_auth() {
        let mut argv = Vec::new();
        append_codex_proxy_config(&mut argv, 4567, "sid-1", Some("apikey"));
        let joined = argv.join("\n");

        assert!(joined.contains("http://127.0.0.1:4567/s/sid-1/v1"));
    }

    #[test]
    fn codex_proxy_config_skips_when_auth_mode_is_unknown() {
        let mut argv = Vec::new();
        append_codex_proxy_config(&mut argv, 4567, "sid-1", None);

        assert!(argv.is_empty());
    }

    #[test]
    fn codex_proxy_config_respects_user_provider_overrides() {
        let mut argv = args(&["-c", "model_provider=\"custom\""]);
        append_codex_proxy_config(&mut argv, 4567, "sid-1", Some("chatgpt"));

        assert_eq!(argv, args(&["-c", "model_provider=\"custom\""]));
    }

    #[test]
    fn codex_proxy_config_respects_user_base_url_overrides() {
        let mut argv = args(&["--config=openai_base_url=http://x"]);
        append_codex_proxy_config(&mut argv, 4567, "sid-1", Some("chatgpt"));

        assert_eq!(argv, args(&["--config=openai_base_url=http://x"]));
    }
}

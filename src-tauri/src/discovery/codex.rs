//! Codex CLI discovery primitives.
//!
//! ## Schema
//!
//! Codex's full configuration schema is a JSON Schema (Draft-07) generated
//! from Rust by `schemars` at *build* time (via the `codex-write-config-schema`
//! binary) and committed to the openai/codex repo as
//! `codex-rs/core/config.schema.json`. It is **not** embedded in the runtime
//! binary today — only event/protocol schemas are. We therefore fetch the
//! schema at runtime from the matching Codex release tag instead of shipping a
//! stale copy inside Code Tabs.
//!
//! Future-proofing: `discover_codex_settings_schema_sync` first attempts to
//! mine the schema from the installed binary (matches the four distinctive
//! ConfigToml top-level keys); if that fails it downloads the remote schema for
//! the installed Codex CLI version.
//! When/if Codex starts shipping the schema in the runtime binary, the
//! frontend automatically picks up the live version with no code change.
//!
//! ## Env vars
//!
//! Mined directly from the installed binary's `.rodata` (`CODEX_*` literals
//! Codex reads at startup) and merged with a curated catalog of non-prefixed
//! vars Codex respects (`OPENAI_API_KEY`, `SSL_CERT_FILE`, …). Curated
//! entries supply human-facing descriptions; mined-only entries surface as
//! `documented = false`.
//!
//! ## Public surface
//!
//!   * `discover_codex_settings_schema_sync(Option<&Path>, Option<&str>)` →
//!     ConfigToml schema (binary-mined when present, remote otherwise).
//!   * `discover_codex_env_vars_sync(&Path)` → curated + mined env vars.
//!   * `codex_env_var_catalog()` → curated table alone (tests, fallback).

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use semver::Version;
use serde_json::Value;

use super::DiscoveredEnvVar;

/// Result envelope for `discover_codex_settings_schema_sync`. Tells the UI
/// where the schema came from so logs can distinguish "remote release schema"
/// from "from installed binary".
#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodexSchemaResult {
    pub schema: serde_json::Value,
    /// `"binary"` when extracted from the user's installed Codex; `"remote"`
    /// when fetched from openai/codex at runtime.
    pub source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// Why binary mining didn't yield a schema. Used internally; the public
/// API reports this alongside the remote fetch error when both sources fail.
#[derive(Debug)]
pub(crate) enum BinaryMineError {
    NoBinary,
    IoError(String),
    NoMatches,
}

impl std::fmt::Display for BinaryMineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BinaryMineError::NoBinary => write!(f, "no native binary"),
            BinaryMineError::IoError(e) => write!(f, "io error: {}", e),
            BinaryMineError::NoMatches => write!(f, "no ConfigToml signature found"),
        }
    }
}

const MAX_BINARY_BYTES: u64 = 500 * 1024 * 1024;
const CODEX_CONFIG_SCHEMA_REL_PATH: &str = "codex-rs/core/config.schema.json";
const CODEX_CONFIG_SCHEMA_MAIN_URL: &str =
    "https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/config.schema.json";
const REMOTE_SCHEMA_TIMEOUT: Duration = Duration::from_secs(10);

/// The probe we look for in the binary. `schemars` emits this exact prefix
/// for every Draft-07 schema. As of Codex 0.125.0 the binary contains
/// hook-event schemas (~12 occurrences) but **not** the ConfigToml schema
/// — that's only generated at build time and committed to the openai/codex
/// repo. We still scan in case a future Codex release embeds it.
const SCHEMA_PROBE: &[u8] = b"\"$schema\": \"http://json-schema.org/draft-07/schema#\"";

/// Distinctive ConfigToml top-level keys. All four must appear in the
/// schema's `properties` for it to be the real ConfigToml schema (and not
/// a sub-type schema like `ProfileToml` or `McpServerConfig`).
const CONFIG_TOML_SIGNATURE: &[&str] = &[
    "model_providers",
    "mcp_servers",
    "profiles",
    "shell_environment_policy",
];

#[derive(Debug, Clone)]
struct RemoteCodexSchema {
    schema: Value,
    url: String,
}

/// Read a binary file into memory with a hard cap. Codex's native binary is
/// ~196 MiB on Linux; the cap protects against an unexpectedly huge file
/// (corrupt download, wrong binary picked) or a runaway memory allocation.
pub(crate) fn read_binary_capped(path: &Path) -> Result<Vec<u8>, BinaryMineError> {
    let metadata = std::fs::metadata(path)
        .map_err(|e| BinaryMineError::IoError(format!("metadata({}): {}", path.display(), e)))?;
    if metadata.len() > MAX_BINARY_BYTES {
        return Err(BinaryMineError::IoError(format!(
            "Codex binary at {} is {} bytes; cap is {}",
            path.display(),
            metadata.len(),
            MAX_BINARY_BYTES
        )));
    }
    std::fs::read(path)
        .map_err(|e| BinaryMineError::IoError(format!("read({}): {}", path.display(), e)))
}

// [CY-01] discover_codex_settings_schema_sync: binary-mine attempt (memchr Draft-07 probe + 4-key ConfigToml signature) -> runtime remote fetch from openai/codex rust-v<installed-version>/codex-rs/core/config.schema.json, with main as a last remote candidate. No vendored schema is compiled into Code Tabs.
/// Resolve the Codex ConfigToml JSON Schema. Tries binary mining first
/// (future-proof: works automatically when/if Codex starts embedding the
/// schema in the runtime binary); falls back to a runtime HTTP fetch for the
/// installed Codex CLI version. No schema is bundled into Code Tabs.
pub fn discover_codex_settings_schema_sync(
    native_binary_path: Option<&Path>,
    codex_cli_version: Option<&str>,
) -> Result<CodexSchemaResult, String> {
    discover_codex_settings_schema_with_fetcher(
        native_binary_path,
        codex_cli_version,
        fetch_codex_settings_schema_for_version,
    )
}

fn discover_codex_settings_schema_with_fetcher<F>(
    native_binary_path: Option<&Path>,
    codex_cli_version: Option<&str>,
    fetcher: F,
) -> Result<CodexSchemaResult, String>
where
    F: FnOnce(&str) -> Result<RemoteCodexSchema, String>,
{
    let binary_error = match native_binary_path {
        Some(path) => match mine_schema_from_binary(path) {
            Ok(schema) => {
                return Ok(CodexSchemaResult {
                    schema,
                    source: "binary",
                    version: codex_cli_version.and_then(normalize_codex_cli_version),
                    url: None,
                });
            }
            Err(err) => err.to_string(),
        },
        None => BinaryMineError::NoBinary.to_string(),
    };

    let Some(raw_version) = codex_cli_version else {
        return Err(format!(
            "Codex settings schema unavailable: binary source failed ({binary_error}); remote source requires Codex CLI version"
        ));
    };
    let Some(version) = normalize_codex_cli_version(raw_version) else {
        return Err(format!(
            "Codex settings schema unavailable: binary source failed ({binary_error}); could not parse Codex CLI version from {raw_version:?}"
        ));
    };

    match fetcher(&version) {
        Ok(remote) => Ok(CodexSchemaResult {
            schema: remote.schema,
            source: "remote",
            version: Some(version),
            url: Some(remote.url),
        }),
        Err(remote_error) => Err(format!(
            "Codex settings schema unavailable: binary source failed ({binary_error}); remote source failed ({remote_error})"
        )),
    }
}

fn normalize_codex_cli_version(raw: &str) -> Option<String> {
    raw.split(|c: char| c.is_whitespace() || matches!(c, ',' | '(' | ')' | ':'))
        .find_map(|token| {
            let token = token.trim().trim_start_matches('v');
            if token.is_empty() {
                return None;
            }
            Version::parse(token)
                .ok()
                .map(|version| version.to_string())
        })
}

fn codex_schema_urls_for_version(version: &str) -> Result<Vec<String>, String> {
    let normalized = normalize_codex_cli_version(version)
        .ok_or_else(|| format!("could not parse Codex CLI version from {version:?}"))?;
    let mut urls = vec![
        format!(
            "https://raw.githubusercontent.com/openai/codex/rust-v{normalized}/{CODEX_CONFIG_SCHEMA_REL_PATH}"
        ),
        format!(
            "https://raw.githubusercontent.com/openai/codex/v{normalized}/{CODEX_CONFIG_SCHEMA_REL_PATH}"
        ),
        format!(
            "https://raw.githubusercontent.com/openai/codex/{normalized}/{CODEX_CONFIG_SCHEMA_REL_PATH}"
        ),
        CODEX_CONFIG_SCHEMA_MAIN_URL.to_string(),
    ];
    urls.dedup();
    Ok(urls)
}

fn fetch_codex_settings_schema_for_version(version: &str) -> Result<RemoteCodexSchema, String> {
    let urls = codex_schema_urls_for_version(version)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(REMOTE_SCHEMA_TIMEOUT)
        .user_agent("code-tabs")
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let mut errors = Vec::new();
    for url in urls {
        let response = match client.get(&url).send() {
            Ok(response) => response,
            Err(err) => {
                errors.push(format!("{url}: {err}"));
                continue;
            }
        };
        let status = response.status();
        if !status.is_success() {
            errors.push(format!("{url}: HTTP {status}"));
            continue;
        }
        let text = match response.text() {
            Ok(text) => text,
            Err(err) => {
                errors.push(format!("{url}: response body error: {err}"));
                continue;
            }
        };
        let schema: Value = match serde_json::from_str(&text) {
            Ok(schema) => schema,
            Err(err) => {
                errors.push(format!("{url}: invalid JSON: {err}"));
                continue;
            }
        };
        if let Err(err) = validate_config_toml_schema(&schema) {
            errors.push(format!("{url}: {err}"));
            continue;
        }
        return Ok(RemoteCodexSchema { schema, url });
    }

    Err(format!(
        "tried {} URL(s): {}",
        errors.len(),
        errors.join("; ")
    ))
}

fn validate_config_toml_schema(schema: &Value) -> Result<(), String> {
    let Some(props) = schema.get("properties").and_then(|p| p.as_object()) else {
        return Err("schema missing top-level properties".into());
    };
    let missing: Vec<&str> = CONFIG_TOML_SIGNATURE
        .iter()
        .copied()
        .filter(|key| !props.contains_key(*key))
        .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "schema missing ConfigToml signature keys: {}",
            missing.join(", ")
        ))
    }
}

/// Best-effort binary mine. See module docs for why this currently fails on
/// Codex 0.125.0 (the ConfigToml schema isn't shipped in the runtime
/// binary).
fn mine_schema_from_binary(native_binary_path: &Path) -> Result<Value, BinaryMineError> {
    if !native_binary_path.is_file() {
        return Err(BinaryMineError::NoBinary);
    }

    let bytes = read_binary_capped(native_binary_path)?;
    let mut best: Option<(usize, Value)> = None;

    let mut probe_hits = 0usize;
    for hit in memchr::memmem::find_iter(&bytes, SCHEMA_PROBE) {
        probe_hits += 1;
        // The opening `{` is within ~16 bytes of the marker since `"$schema"`
        // is the first key. 256 is a safety margin (allows for whitespace
        // padding from `serde_json::to_string_pretty`). If Codex starts
        // embedding schemas with a long prefix before "$schema", this miner
        // should grow the window or switch to a forward JSON object scanner.
        let lookback = hit.saturating_sub(256);
        for try_start in (lookback..hit).rev() {
            if bytes[try_start] != b'{' {
                continue;
            }
            // Streaming parse — stops cleanly at the first complete value.
            let mut stream =
                serde_json::Deserializer::from_slice(&bytes[try_start..]).into_iter::<Value>();
            let parsed = match stream.next() {
                Some(Ok(v)) => v,
                _ => continue, // not a valid JSON object here, walk back further
            };

            if validate_config_toml_schema(&parsed).is_err() {
                continue;
            }

            let size = serde_json::to_string(&parsed).map(|s| s.len()).unwrap_or(0);
            match &best {
                None => best = Some((size, parsed)),
                Some((bs, _)) if size > *bs => best = Some((size, parsed)),
                _ => {}
            }
            break; // found the value at this hit, no need to walk back further
        }
    }

    best.map(|(_, v)| v).ok_or_else(|| {
        log::debug!(
            "Codex settings schema binary mine found no ConfigToml matches after {probe_hits} probe hit(s)"
        );
        BinaryMineError::NoMatches
    })
}

// [CY-02] discover_codex_env_vars_sync: mine_codex_env_var_names walks raw bytes (no UTF-8 decode of ~196 MiB binary) using memchr on b"CODEX_"; merge with codex_env_var_catalog (~45 curated entries with categories/descriptions); is_noise_env_var filters Codex internals (test/dev overrides). Sort documented-first then category, then name.
/// Mine `CODEX_*` and curated env vars from the Codex native binary.
/// Mined names are merged with the curated catalog: known-noise vars
/// (e.g. `CODEX_RS_SSE_FIXTURE` test-only) are filtered out, and curated
/// descriptions take precedence over generic "documented = false" entries.
pub fn discover_codex_env_vars_sync(
    native_binary_path: &Path,
) -> Result<Vec<DiscoveredEnvVar>, String> {
    if !native_binary_path.is_file() {
        return Err(format!(
            "Codex native binary not found at {}",
            native_binary_path.display()
        ));
    }
    let bytes = std::fs::read(native_binary_path)
        .map_err(|e| format!("read({}): {}", native_binary_path.display(), e))?;
    let mined = mine_codex_env_var_names(&bytes);

    let curated = codex_env_var_catalog();
    let curated_names: BTreeMap<String, DiscoveredEnvVar> =
        curated.into_iter().map(|v| (v.name.clone(), v)).collect();

    let mut out: BTreeMap<String, DiscoveredEnvVar> = curated_names;
    for name in mined {
        if is_noise_env_var(&name) {
            continue;
        }
        out.entry(name.clone()).or_insert_with(|| DiscoveredEnvVar {
            name: name.clone(),
            description: String::new(),
            category: "advanced".into(),
            documented: false,
        });
    }

    let mut result: Vec<DiscoveredEnvVar> = out.into_values().collect();
    // Sort: documented first (curated catalog), then by category, then by name.
    result.sort_by(|a, b| {
        b.documented
            .cmp(&a.documented)
            .then_with(|| a.category.cmp(&b.category))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(result)
}

/// Walk the binary as raw bytes and pull out ASCII identifiers matching
/// `CODEX_[A-Z][A-Z0-9_]{2,80}`. Doesn't depend on the `regex` crate
/// because the pattern is dead simple and we don't want to allocate a
/// 196 MiB UTF-8 string just to run a regex on it.
fn mine_codex_env_var_names(bytes: &[u8]) -> Vec<String> {
    const PREFIX: &[u8] = b"CODEX_";
    let mut seen = std::collections::BTreeSet::new();
    for hit in memchr::memmem::find_iter(bytes, PREFIX) {
        // Reject if the byte before is part of the same identifier (means we
        // matched mid-string, e.g. `XCODEX_FOO`). The first hit at offset 0
        // has nothing before it and is always valid.
        if hit > 0 {
            let prev = bytes[hit - 1];
            if prev.is_ascii_alphanumeric() || prev == b'_' {
                continue;
            }
        }
        // First byte after PREFIX must be uppercase ASCII letter.
        let after = hit + PREFIX.len();
        if after >= bytes.len() {
            continue;
        }
        if !bytes[after].is_ascii_uppercase() {
            continue;
        }
        // Walk forward collecting [A-Z0-9_], cap at 80 bytes after the prefix
        // to prevent run-on into unrelated interned strings.
        let mut end = after + 1;
        let cap = (after + 80).min(bytes.len());
        while end < cap {
            let b = bytes[end];
            if b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_' {
                end += 1;
            } else {
                break;
            }
        }
        // Need at least 3 chars after PREFIX to be a real env var name.
        if end - after < 3 {
            continue;
        }
        // Safe: we only accepted ASCII bytes between hit and end.
        let name = std::str::from_utf8(&bytes[hit..end]).unwrap().to_string();
        seen.insert(name);
    }
    seen.into_iter().collect()
}

/// Test-only and internal-tooling env vars we don't want to surface in the
/// user-facing reference panel.
fn is_noise_env_var(name: &str) -> bool {
    matches!(
        name,
        "CODEX_RS_SSE_FIXTURE"
            | "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"
            | "CODEX_REFRESH_TOKEN_URL_OVERRIDE"
            | "CODEX_REVOKE_TOKEN_URL_OVERRIDE"
            | "CODEX_SNAPSHOT_OVERRIDE"
            | "CODEX_SNAPSHOT_PROXY_ENV_SET"
            | "CODEX_SNAPSHOT_PROXY_OVERRIDE"
            | "CODEX_STARTING_DIFF"
            | "CODEX_OPEN_BRACE__"
            | "CODEX_CLOSE_BRACE__"
    )
}

/// Curated catalog of env vars Codex respects. Sourced from a manual
/// audit of `codex-rs/` (Apr 2026) plus the docs at
/// `codex-rs/docs/config.md`. Add to this when Codex grows new vars.
pub fn codex_env_var_catalog() -> Vec<DiscoveredEnvVar> {
    let entries: &[(&str, &str, &str)] = &[
        // ---- auth ----
        ("OPENAI_API_KEY", "auth", "OpenAI API key. Codex reads this on startup if no stored credentials are available."),
        ("CODEX_API_KEY", "auth", "Codex-specific API key (overrides OPENAI_API_KEY when set)."),
        ("OPENAI_BASE_URL", "auth", "Override the OpenAI API base URL (e.g. for a corporate proxy)."),
        ("CODEX_GITHUB_PERSONAL_ACCESS_TOKEN", "auth", "GitHub PAT for Codex Cloud / repo-write tools that require GitHub auth."),
        ("CODEX_CONNECTORS_TOKEN", "auth", "Auth token for connecting to MCP connectors hosted by Codex."),

        // ---- runtime / paths ----
        ("CODEX_HOME", "runtime", "Override the Codex home directory (default ~/.codex). Must point to an existing directory."),
        ("CODEX_SQLITE_HOME", "runtime", "Directory for the Codex SQLite state DB. Defaults to CODEX_HOME or a temp dir for WorkspaceWrite sessions."),
        ("CODEX_THREAD_ID", "runtime", "Thread identifier injected into the spawned shell environment so tool subprocesses know which Codex thread they belong to."),
        ("CODEX_JS_REPL_NODE_PATH", "runtime", "Override the Node binary used by the JavaScript REPL tool."),
        ("CODEX_JS_REPL_NODE_MODULE_DIRS", "runtime", "Colon-separated list of directories where the JS REPL searches for Node modules."),
        ("CODEX_JS_TMP_DIR", "runtime", "Override the temp directory used for JS REPL scratch files."),

        // ---- sandbox ----
        ("CODEX_SANDBOX", "sandbox", "Sandbox mode override for the current invocation (e.g. \"seatbelt\" on macOS, \"workspace-write\")."),
        ("CODEX_SANDBOX_NETWORK_DISABLED", "sandbox", "Set to \"1\" to disable outbound network access from sandboxed shell tools."),
        ("CODEX_ESCALATE_SOCKET", "sandbox", "Path to the Unix socket the Codex shell-escalation helper listens on (Linux only)."),

        // ---- network / proxy ----
        ("CODEX_CA_CERTIFICATE", "network", "Path to a PEM bundle used as the trusted CA for outbound HTTPS and websocket connections. Falls back to SSL_CERT_FILE."),
        ("SSL_CERT_FILE", "network", "Standard fallback CA bundle path. Used if CODEX_CA_CERTIFICATE is unset."),
        ("CODEX_NETWORK_PROXY_ACTIVE", "network", "Set to \"1\" when Codex's outbound proxy is active. Codex inspects this when reasoning about network policy violations."),
        ("CODEX_NETWORK_ALLOW_LOCAL_BINDING", "network", "Set to \"1\" to permit binding to localhost from within the sandbox."),
        ("CODEX_NETWORK_POLICY_VIOLATION", "network", "Diagnostic env var Codex sets when a network policy violation is detected by the proxy."),
        ("HTTP_PROXY", "network", "Standard HTTP proxy URL. Honoured by Codex's HTTP client (reqwest)."),
        ("HTTPS_PROXY", "network", "Standard HTTPS proxy URL."),
        ("NO_PROXY", "network", "Comma-separated list of hostnames/CIDRs to bypass HTTP_PROXY/HTTPS_PROXY for."),
        ("NO_BROWSER", "network", "Disable Codex's automatic browser open during login flows."),

        // ---- exec / app server ----
        ("CODEX_EXEC_SERVER_URL", "exec", "URL of a remote Codex exec-server (experimental — used by `codex exec-server` clients)."),
        ("CODEX_APP_SERVER_URL", "exec", "URL of a remote Codex app-server endpoint (experimental)."),
        ("CODEX_APP_SERVER_LOGIN_ISSUER", "exec", "OAuth issuer override for the app-server login flow."),
        ("CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG", "exec", "Set to \"1\" to disable Codex app-server's managed config layer."),
        ("CODEX_APP_SERVER_MANAGED_CONFIG_PATH", "exec", "Filesystem path to a managed config TOML for the Codex app-server."),

        // ---- cloud tasks ----
        ("CODEX_CLOUD_TASKS_BASE_URL", "exec", "Base URL for the Codex Cloud tasks API."),
        ("CODEX_CLOUD_TASKS_FORCE_INTERNAL", "exec", "Force the Codex Cloud client to use internal endpoints (engineering-only)."),

        // ---- TUI / debug ----
        ("CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT", "debug", "Set to \"1\" to disable Codex TUI's keyboard enhancement mode (workaround for terminals that misreport support)."),
        ("CODEX_APPLY_GIT_CFG", "debug", "Set to \"1\" to let Codex apply git config tweaks during install."),
        ("CODEX_MANAGED_BY_NPM", "debug", "Set automatically by the npm wrapper to mark Codex as managed by npm."),
        ("CODEX_MANAGED_BY_BUN", "debug", "Set automatically by the bun wrapper to mark Codex as managed by bun."),
        ("CODEX_OSS_PORT", "debug", "Port for the optional OSS local model server."),
        ("CODEX_OSS_BASE_URL", "debug", "Base URL for the optional OSS local model server."),
        ("CODEX_ROLLOUT_TRACE_ROOT", "debug", "Feature rollout trace ID. Set automatically when Codex is run inside a traced rollout."),
        ("CODEX_ARC_MONITOR_TOKEN", "debug", "Auth token for the ARC monitor (engineering observability)."),
        ("CODEX_ARC_MONITOR_ENDPOINT", "debug", "Endpoint URL for the ARC monitor."),
    ];

    entries
        .iter()
        .map(|(name, category, description)| DiscoveredEnvVar {
            name: (*name).into(),
            description: (*description).into(),
            category: (*category).into(),
            documented: true,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn minimal_config_schema() -> Value {
        json!({
            "$schema": "http://json-schema.org/draft-07/schema#",
            "title": "ConfigToml",
            "properties": {
                "model": { "type": "string" },
                "model_providers": { "type": "object" },
                "mcp_servers": { "type": "object" },
                "profiles": { "type": "object" },
                "shell_environment_policy": { "type": "object" },
            }
        })
    }

    #[test]
    fn signature_constants_match_codex_config() {
        for key in CONFIG_TOML_SIGNATURE {
            assert!(
                key.starts_with(|c: char| c.is_ascii_lowercase() || c == '_'),
                "signature key looks unusual: {}",
                key
            );
        }
    }

    #[test]
    fn codex_schema_urls_prefer_matching_rust_tag() {
        let urls = codex_schema_urls_for_version("codex-cli 0.125.0").unwrap();
        assert_eq!(
            urls.first().map(String::as_str),
            Some(
                "https://raw.githubusercontent.com/openai/codex/rust-v0.125.0/codex-rs/core/config.schema.json"
            )
        );
        assert!(urls.iter().any(|url| url == CODEX_CONFIG_SCHEMA_MAIN_URL));
    }

    #[test]
    fn binary_mine_extracts_when_schema_embedded() {
        // Synthetic binary containing the full ConfigToml schema as a static
        // string. Verifies the extraction algorithm works when (some future)
        // Codex actually embeds the schema in its runtime binary.
        let real = r#"{"$schema": "http://json-schema.org/draft-07/schema#","title":"ConfigToml","properties":{"model":{"type":"string"},"model_providers":{"type":"object"},"mcp_servers":{"type":"object"},"profiles":{"type":"object"},"shell_environment_policy":{"type":"object"}}}"#;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"\0\0prefix junk\0\0");
        bytes.extend_from_slice(real.as_bytes());
        bytes.extend_from_slice(b"\0\0trailer junk\0\0");

        let tmp = std::env::temp_dir().join("codex_discovery_binary_mine.bin");
        std::fs::write(&tmp, &bytes).unwrap();

        let result = discover_codex_settings_schema_sync(Some(&tmp), Some("codex-cli 0.125.0"))
            .expect("embedded schema should resolve");
        assert_eq!(result.source, "binary");
        assert_eq!(
            result.schema.get("title").and_then(|v| v.as_str()),
            Some("ConfigToml")
        );
        let _ = std::fs::remove_file(tmp);
    }

    #[test]
    fn fetches_remote_when_binary_lacks_signature() {
        // Decoy schema only — no ConfigToml signature → should fetch remotely.
        let only_decoy = r#"{"$schema": "http://json-schema.org/draft-07/schema#","title":"ProfileToml","properties":{"model":{"type":"string"}}}"#;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"\0\0junk\0\0");
        bytes.extend_from_slice(only_decoy.as_bytes());
        bytes.extend_from_slice(b"\0\0junk\0\0");

        let tmp = std::env::temp_dir().join("codex_discovery_fallback.bin");
        std::fs::write(&tmp, &bytes).unwrap();

        let result = discover_codex_settings_schema_with_fetcher(
            Some(&tmp),
            Some("codex-cli 0.125.0"),
            |version| {
                assert_eq!(version, "0.125.0");
                Ok(RemoteCodexSchema {
                    schema: minimal_config_schema(),
                    url: "https://example.invalid/config.schema.json".into(),
                })
            },
        )
        .expect("remote schema should resolve");
        assert_eq!(result.source, "remote");
        assert_eq!(result.version.as_deref(), Some("0.125.0"));
        assert_eq!(
            result.url.as_deref(),
            Some("https://example.invalid/config.schema.json")
        );
        assert!(result.schema.get("properties").is_some());
        let _ = std::fs::remove_file(tmp);
    }

    #[test]
    fn errors_when_binary_missing_and_version_missing() {
        let err = discover_codex_settings_schema_sync(
            Some(Path::new("/nonexistent/codex/binary/path/codex")),
            None,
        )
        .expect_err("missing binary and version should fail");
        assert!(err.contains("remote source requires Codex CLI version"));
    }

    #[test]
    fn mines_codex_env_var_names_skips_run_on() {
        let bytes = b"\0CODEX_HOME\0junkXCODEX_FOO_BAR\0CODEX_SANDBOX\0CODEX_OK_THING_1\0";
        let mined = mine_codex_env_var_names(bytes);
        // Should pick up the three boundary-clean names and reject the
        // run-on `XCODEX_FOO_BAR` (preceded by alphanumeric).
        assert!(mined.contains(&"CODEX_HOME".to_string()));
        assert!(mined.contains(&"CODEX_SANDBOX".to_string()));
        assert!(mined.contains(&"CODEX_OK_THING_1".to_string()));
        assert!(!mined.iter().any(|n| n.contains("XCODEX")));
    }

    #[test]
    fn mines_long_codex_env_var_names() {
        let name = "CODEX_NETWORK_ALLOW_LOCAL_BINDING_FOR_OFFLINE_WORKFLOW";
        let bytes = format!("\0{name}\0");
        let mined = mine_codex_env_var_names(bytes.as_bytes());
        assert!(mined.contains(&name.to_string()));
    }

    #[test]
    fn discover_env_vars_merges_curated_and_mined() {
        // Only mined names: `CODEX_HOME` (curated) + `CODEX_FUTURE_VAR` (new).
        let bytes = b"\0CODEX_HOME\0\0CODEX_FUTURE_VAR\0";
        let tmp = std::env::temp_dir().join("codex_discovery_merge.bin");
        std::fs::write(&tmp, bytes).unwrap();

        let merged = discover_codex_env_vars_sync(&tmp).expect("merge succeeded");
        let names: Vec<&str> = merged.iter().map(|v| v.name.as_str()).collect();

        // Curated entry should still be there, with curated description.
        let home = merged.iter().find(|v| v.name == "CODEX_HOME").unwrap();
        assert!(home.documented);
        assert!(home.description.contains("home directory"));

        // Mined-only entry should be present, marked undocumented.
        let future = merged
            .iter()
            .find(|v| v.name == "CODEX_FUTURE_VAR")
            .unwrap();
        assert!(!future.documented);

        // Sort order: documented first.
        let first_undoc = names
            .iter()
            .position(|n| merged.iter().any(|v| v.name == *n && !v.documented));
        let last_doc = names
            .iter()
            .rposition(|n| merged.iter().any(|v| v.name == *n && v.documented));
        if let (Some(fu), Some(ld)) = (first_undoc, last_doc) {
            assert!(ld < fu, "documented should sort before undocumented");
        }

        let _ = std::fs::remove_file(tmp);
    }
}

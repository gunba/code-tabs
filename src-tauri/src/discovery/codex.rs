//! Codex CLI discovery primitives.
//!
//! ## Schema
//!
//! Codex's full configuration schema is a JSON Schema (Draft-07) generated
//! from Rust by `schemars` at *build* time (via the `codex-write-config-schema`
//! binary) and committed to the openai/codex repo as
//! `codex-rs/core/config.schema.json`. It is **not** embedded in the runtime
//! binary — only event/protocol schemas are. We therefore vendor a copy at
//! `src-tauri/src/discovery/codex_schema.json` (loaded via `include_str!`)
//! and refresh it via `npm run discover:fetch-codex-schema` (Phase 6).
//!
//! Future-proofing: `discover_codex_settings_schema_sync` first attempts to
//! mine the schema from the installed binary (matches the four distinctive
//! ConfigToml top-level keys); if that fails it returns the bundled copy.
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
//!   * `discover_codex_settings_schema_sync(&Path)` → ConfigToml schema
//!     (binary-mined when present, bundled otherwise).
//!   * `discover_codex_env_vars_sync(&Path)` → curated + mined env vars.
//!   * `codex_env_var_catalog()` → curated table alone (tests, fallback).
//!   * `vendored_codex_settings_schema()` → bundled copy (tests, refresh).
//!   * `cache_key_for_binary(&Path)` → stable hash over first+last 4 KiB.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::DiscoveredEnvVar;

/// Result envelope for `discover_codex_settings_schema_sync`. Tells the UI
/// where the schema came from so the Settings header can show "bundled
/// (vN)" vs "from installed binary".
#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodexSchemaResult {
    pub schema: serde_json::Value,
    /// `"binary"` when extracted from the user's installed Codex; `"bundled"`
    /// when sourced from the vendored copy compiled into Code Tabs.
    pub source: &'static str,
}

/// Why binary mining didn't yield a schema. Used internally; the public
/// API always returns at least the bundled schema, so this never reaches
/// the frontend.
#[derive(Debug)]
enum BinaryMineError {
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

/// The bundled ConfigToml schema (Draft-07). Always succeeds. Refresh with
/// `npm run discover:fetch-codex-schema` (Phase 6).
pub fn vendored_codex_settings_schema() -> serde_json::Value {
    serde_json::from_str(include_str!("codex_schema.json"))
        .expect("vendored codex_schema.json must be valid JSON")
}

const MAX_BINARY_BYTES: u64 = 500 * 1024 * 1024;

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

/// Read a binary file into memory with a hard cap. Codex's native binary is
/// ~196 MiB on Linux; the cap protects against an unexpectedly huge file
/// (corrupt download, wrong binary picked) or a runaway memory allocation.
fn read_binary_capped(path: &Path) -> Result<Vec<u8>, BinaryMineError> {
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

/// Resolve the Codex ConfigToml JSON Schema. Tries binary mining first
/// (future-proof: works automatically when/if Codex starts embedding the
/// schema in the runtime binary); falls back to the bundled vendored copy.
/// The result envelope reports which source actually fired.
pub fn discover_codex_settings_schema_sync(native_binary_path: &Path) -> CodexSchemaResult {
    match mine_schema_from_binary(native_binary_path) {
        Ok(schema) => CodexSchemaResult {
            schema,
            source: "binary",
        },
        Err(_) => CodexSchemaResult {
            schema: vendored_codex_settings_schema(),
            source: "bundled",
        },
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

    for hit in memchr::memmem::find_iter(&bytes, SCHEMA_PROBE) {
        // The opening `{` is within ~16 bytes of the marker since `"$schema"`
        // is the first key. 256 is a safety margin (allows for whitespace
        // padding from `serde_json::to_string_pretty`).
        let lookback = hit.saturating_sub(256);
        for try_start in (lookback..hit).rev() {
            if bytes[try_start] != b'{' {
                continue;
            }
            // Streaming parse — stops cleanly at the first complete value.
            let mut stream = serde_json::Deserializer::from_slice(&bytes[try_start..])
                .into_iter::<Value>();
            let parsed = match stream.next() {
                Some(Ok(v)) => v,
                _ => continue, // not a valid JSON object here, walk back further
            };

            // Verify it's the ConfigToml schema, not a sub-schema.
            let Some(props) = parsed
                .get("properties")
                .and_then(|p| p.as_object())
            else {
                continue;
            };
            let has_signature = CONFIG_TOML_SIGNATURE
                .iter()
                .all(|key| props.contains_key(*key));
            if !has_signature {
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

    best.map(|(_, v)| v).ok_or(BinaryMineError::NoMatches)
}

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
/// `CODEX_[A-Z][A-Z0-9_]{2,40}`. Doesn't depend on the `regex` crate
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
        // Walk forward collecting [A-Z0-9_], cap at 40 bytes after the prefix
        // to prevent run-on into unrelated interned strings.
        let mut end = after + 1;
        let cap = (after + 40).min(bytes.len());
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

/// Cheap stable identity for the Codex binary. Reads the first and last
/// 4 KiB only, so it's fast even for the 196 MiB native binary. Different
/// versions / builds of Codex always diverge in either header or trailer,
/// so collisions across releases are negligible.
pub fn cache_key_for_binary(native_binary_path: &Path) -> Result<String, String> {
    let mut file = File::open(native_binary_path)
        .map_err(|e| format!("open({}): {}", native_binary_path.display(), e))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("metadata({}): {}", native_binary_path.display(), e))?;
    let len = metadata.len();

    let mut hasher = Sha256::new();
    hasher.update(len.to_le_bytes());

    let chunk_size = 4096u64.min(len);
    let mut head = vec![0u8; chunk_size as usize];
    file.read_exact(&mut head)
        .map_err(|e| format!("read head: {}", e))?;
    hasher.update(&head);

    if len > chunk_size {
        let tail_offset = len.saturating_sub(chunk_size);
        file.seek(SeekFrom::Start(tail_offset))
            .map_err(|e| format!("seek tail: {}", e))?;
        let mut tail = vec![0u8; chunk_size as usize];
        file.read_exact(&mut tail)
            .map_err(|e| format!("read tail: {}", e))?;
        hasher.update(&tail);
    }

    Ok(format!("{:x}", hasher.finalize()))
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
    fn vendored_schema_loads_and_has_signature() {
        let schema = vendored_codex_settings_schema();
        let props = schema
            .get("properties")
            .and_then(|p| p.as_object())
            .expect("vendored schema has properties");
        for key in CONFIG_TOML_SIGNATURE {
            assert!(props.contains_key(*key), "vendored schema missing {key}");
        }
        assert!(
            props.len() >= 20,
            "vendored schema has {} top-level keys, expected >=20",
            props.len()
        );
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

        let result = discover_codex_settings_schema_sync(&tmp);
        assert_eq!(result.source, "binary");
        assert_eq!(
            result.schema.get("title").and_then(|v| v.as_str()),
            Some("ConfigToml")
        );
        let _ = std::fs::remove_file(tmp);
    }

    #[test]
    fn falls_back_to_bundled_when_binary_lacks_signature() {
        // Decoy schema only — no ConfigToml signature → should serve bundled.
        let only_decoy = r#"{"$schema": "http://json-schema.org/draft-07/schema#","title":"ProfileToml","properties":{"model":{"type":"string"}}}"#;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"\0\0junk\0\0");
        bytes.extend_from_slice(only_decoy.as_bytes());
        bytes.extend_from_slice(b"\0\0junk\0\0");

        let tmp = std::env::temp_dir().join("codex_discovery_fallback.bin");
        std::fs::write(&tmp, &bytes).unwrap();

        let result = discover_codex_settings_schema_sync(&tmp);
        assert_eq!(result.source, "bundled");
        // Bundled schema must still be valid.
        assert!(result.schema.get("properties").is_some());
        let _ = std::fs::remove_file(tmp);
    }

    #[test]
    fn falls_back_to_bundled_when_binary_missing() {
        let result = discover_codex_settings_schema_sync(Path::new(
            "/nonexistent/codex/binary/path/codex",
        ));
        assert_eq!(result.source, "bundled");
        assert!(result.schema.get("properties").is_some());
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
        let future = merged.iter().find(|v| v.name == "CODEX_FUTURE_VAR").unwrap();
        assert!(!future.documented);

        // Sort order: documented first.
        let first_undoc = names.iter().position(|n| {
            merged.iter().any(|v| v.name == *n && !v.documented)
        });
        let last_doc = names
            .iter()
            .rposition(|n| merged.iter().any(|v| v.name == *n && v.documented));
        if let (Some(fu), Some(ld)) = (first_undoc, last_doc) {
            assert!(ld < fu, "documented should sort before undocumented");
        }

        let _ = std::fs::remove_file(tmp);
    }

    #[test]
    fn cache_key_changes_when_binary_changes() {
        let tmp_a = std::env::temp_dir().join("codex_cache_key_a.bin");
        let tmp_b = std::env::temp_dir().join("codex_cache_key_b.bin");
        std::fs::write(&tmp_a, b"hello world").unwrap();
        std::fs::write(&tmp_b, b"hello world!").unwrap();
        let key_a = cache_key_for_binary(&tmp_a).unwrap();
        let key_b = cache_key_for_binary(&tmp_b).unwrap();
        assert_ne!(key_a, key_b);
        let _ = std::fs::remove_file(tmp_a);
        let _ = std::fs::remove_file(tmp_b);
    }
}

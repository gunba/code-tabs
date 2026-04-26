//! Integration test: extract the ConfigToml schema from the locally installed
//! Codex native binary. Skipped (with a printed reason) if the binary isn't
//! present on this developer's machine.
//!
//! Run with: cargo test --test codex_schema_extract -- --nocapture

use std::path::PathBuf;

use code_tabs_lib::discovery::codex::{
    cache_key_for_binary, discover_codex_env_vars_sync, discover_codex_settings_schema_sync,
    vendored_codex_settings_schema,
};

fn locate_codex_native() -> Option<PathBuf> {
    // Mirror the production walk: detect the wrapper, then the platform vendor path.
    let wrapper_str = std::process::Command::new("which")
        .arg("codex")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())?;
    let wrapper = PathBuf::from(wrapper_str.trim());
    let canonical = std::fs::canonicalize(&wrapper).unwrap_or(wrapper);
    if canonical.extension().and_then(|e| e.to_str()) != Some("js") {
        return Some(canonical);
    }
    // npm wrapper layout: <root>/bin/codex.js → <root>/node_modules/@openai/codex-<triple>/vendor/<triple>/codex/codex
    let triple = "x86_64-unknown-linux-musl";
    let pkg = "codex-linux-x64";
    let exe = "codex";
    let root = canonical.parent()?.parent()?;
    let candidates = [
        root.join("node_modules")
            .join("@openai")
            .join(pkg)
            .join("vendor")
            .join(triple)
            .join("codex")
            .join(exe),
        root.join("vendor").join(triple).join("codex").join(exe),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

#[test]
fn resolves_codex_schema_from_real_binary_or_bundled() {
    let bundled = vendored_codex_settings_schema();
    let bundled_props = bundled
        .get("properties")
        .and_then(|p| p.as_object())
        .expect("bundled schema has properties");
    eprintln!("Bundled schema: {} top-level properties", bundled_props.len());
    assert!(bundled_props.len() >= 20);

    let Some(bin) = locate_codex_native() else {
        eprintln!("SKIP: no Codex native binary on this machine");
        return;
    };
    eprintln!("Using Codex binary: {}", bin.display());

    let result = discover_codex_settings_schema_sync(&bin);
    eprintln!("Schema source: {}", result.source);
    let props = result
        .schema
        .get("properties")
        .and_then(|p| p.as_object())
        .expect("schema missing properties");
    let prop_count = props.len();
    eprintln!("Top-level properties: {}", prop_count);

    // Either source must yield the four signature keys.
    for key in &["model_providers", "mcp_servers", "profiles", "shell_environment_policy"] {
        assert!(props.contains_key(*key), "missing signature key {key}");
    }
    assert!(prop_count >= 20, "expected >=20 top-level keys, got {prop_count}");
    assert!(matches!(result.source, "binary" | "bundled"));

    // Cache key roundtrip — same binary should produce a stable hash.
    let k1 = cache_key_for_binary(&bin).unwrap();
    let k2 = cache_key_for_binary(&bin).unwrap();
    assert_eq!(k1, k2);
    assert_eq!(k1.len(), 64, "expected sha256 hex (64 chars), got {}", k1.len());
}

#[test]
fn mines_real_codex_env_vars_when_binary_present() {
    let Some(bin) = locate_codex_native() else {
        eprintln!("SKIP: no Codex native binary on this machine");
        return;
    };
    let vars = discover_codex_env_vars_sync(&bin).expect("mine env vars");
    let names: Vec<&str> = vars.iter().map(|v| v.name.as_str()).collect();
    eprintln!("Mined {} env vars: first few = {:?}", vars.len(), &names.iter().take(8).collect::<Vec<_>>());

    // Curated entries must be present.
    assert!(names.contains(&"OPENAI_API_KEY"));
    assert!(names.contains(&"CODEX_HOME"));
    assert!(names.contains(&"CODEX_SANDBOX"));
    assert!(names.contains(&"SSL_CERT_FILE"));

    // Documented should sort before undocumented.
    let first_undoc = vars.iter().position(|v| !v.documented);
    let last_doc = vars.iter().rposition(|v| v.documented);
    if let (Some(fu), Some(ld)) = (first_undoc, last_doc) {
        assert!(ld < fu, "documented entries should precede undocumented");
    }
}

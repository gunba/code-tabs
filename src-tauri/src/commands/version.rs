// [VA-03] Rust version commands: build info, CLI version check, CLI update with install method detection
use regex::Regex;
use scraper::{Html, Selector};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    pub app_version: String,
    pub claude_code_build_version: String,
}

#[tauri::command]
pub fn get_build_info() -> BuildInfo {
    BuildInfo {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        claude_code_build_version: env!("CLAUDE_CODE_BUILD_VERSION").to_string(),
    }
}

fn linux_use_native_chrome_from_env(session: &str, desktop: &str) -> bool {
    if !session.eq_ignore_ascii_case("wayland") {
        return false;
    }
    let desktop = desktop.to_uppercase();
    desktop.split(':').any(|s| s == "KDE")
}

// [PL-01] Returns true on Linux + KDE + Wayland — the combination where native
// window decorations can still appear despite `decorations:false`. Frontend uses
// this to skip the custom Header and keep a single OS-provided titlebar.
#[tauri::command]
pub fn linux_use_native_chrome() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default();
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    linux_use_native_chrome_from_env(&session, &desktop)
}

// [CN-01] Per-CLI changelog fetch: claude raw GitHub markdown CHANGELOG.md vs codex GitHub releases atom feed + GitHub releases API fallback; semver-aware filter selects entries strictly after fromVersion through toVersion (inclusive), capped at 12 (or 5 default).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogEntry {
    pub version: String,
    pub date: Option<String>,
    pub body: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliChangelog {
    pub cli: String,
    pub source_url: String,
    pub from_version: Option<String>,
    pub to_version: Option<String>,
    pub entries: Vec<ChangelogEntry>,
    pub truncated: bool,
}

fn version_re() -> &'static Regex {
    static VERSION_RE: OnceLock<Regex> = OnceLock::new();
    VERSION_RE.get_or_init(|| {
        Regex::new(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?")
            .expect("version regex must compile")
    })
}

fn normalize_cli_version(version: &str) -> Option<String> {
    version_re().find(version).map(|m| m.as_str().to_string())
}

fn parse_version(version: &str) -> Option<Version> {
    let normalized = normalize_cli_version(version)?;
    Version::parse(&normalized).ok()
}

fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    match (parse_version(a), parse_version(b)) {
        (Some(pa), Some(pb)) => pa.cmp(&pb),
        (None, Some(_)) => std::cmp::Ordering::Less,
        (Some(_), None) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

fn is_prerelease(version: &str) -> bool {
    parse_version(version)
        .map(|parsed| !parsed.pre.is_empty())
        .unwrap_or(false)
}

fn is_version_after(version: &str, after: &Option<String>) -> bool {
    if parse_version(version).is_none() {
        return false;
    }
    after.as_deref().map_or(true, |a| {
        parse_version(a)
            .map(|_| compare_versions(version, a).is_gt())
            .unwrap_or(true)
    })
}

fn is_version_at_or_before(version: &str, before: &Option<String>) -> bool {
    if parse_version(version).is_none() {
        return false;
    }
    before.as_deref().map_or(true, |b| {
        parse_version(b)
            .map(|_| compare_versions(version, b).is_le())
            .unwrap_or(true)
    })
}

fn truncate_body(body: &str) -> (String, bool) {
    const MAX_BODY_CHARS: usize = 12_000;
    if body.chars().count() <= MAX_BODY_CHARS {
        return (body.trim().to_string(), false);
    }
    let truncated = body.chars().take(MAX_BODY_CHARS).collect::<String>();
    (format!("{}\n\n[truncated]", truncated.trim_end()), true)
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("code-tabs")
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))
}

fn fetch_text(url: &str) -> Result<String, String> {
    let client = http_client()?;
    client
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|e| format!("Failed to fetch {url}: {e}"))
}

fn select_entries(
    entries: Vec<ChangelogEntry>,
    from_version: Option<String>,
    to_version: Option<String>,
    default_count: usize,
) -> (Vec<ChangelogEntry>, bool) {
    const MAX_ENTRIES: usize = 12;
    let mut selected = Vec::new();
    for entry in entries {
        if from_version.is_some() || to_version.is_some() {
            if !is_version_after(&entry.version, &from_version) {
                continue;
            }
            if !is_version_at_or_before(&entry.version, &to_version) {
                continue;
            }
        }
        selected.push(entry);
        if selected.len() >= MAX_ENTRIES {
            return (selected, true);
        }
        if from_version.is_none() && to_version.is_none() && selected.len() >= default_count {
            break;
        }
    }
    (selected, false)
}

fn fetch_claude_changelog(
    from_version: Option<String>,
    to_version: Option<String>,
) -> Result<CliChangelog, String> {
    const SOURCE_URL: &str =
        "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md";
    let raw = fetch_text(SOURCE_URL)?;
    let heading_re = Regex::new(r"^##\s+(.+?)\s*$").unwrap();
    let mut entries = Vec::new();
    let mut current_version: Option<String> = None;
    let mut body_lines: Vec<String> = Vec::new();

    let push_entry = |entries: &mut Vec<ChangelogEntry>,
                      version: Option<String>,
                      body_lines: &mut Vec<String>| {
        let Some(version) = version else {
            return false;
        };
        let body = body_lines.join("\n").trim().to_string();
        body_lines.clear();
        if body.is_empty() {
            return false;
        }
        let (body, body_truncated) = truncate_body(&body);
        entries.push(ChangelogEntry {
            version,
            date: None,
            body,
            url: Some("https://code.claude.com/docs/en/changelog".to_string()),
        });
        body_truncated
    };

    let mut truncated = false;
    for line in raw.lines() {
        if let Some(caps) = heading_re.captures(line) {
            truncated |= push_entry(&mut entries, current_version.take(), &mut body_lines);
            current_version = normalize_cli_version(&caps[1]);
            continue;
        }
        if current_version.is_some() {
            body_lines.push(line.to_string());
        }
    }
    truncated |= push_entry(&mut entries, current_version, &mut body_lines);

    let (selected, selection_truncated) = select_entries(
        entries,
        from_version.clone().and_then(|v| normalize_cli_version(&v)),
        to_version.clone().and_then(|v| normalize_cli_version(&v)),
        5,
    );
    Ok(CliChangelog {
        cli: "claude".to_string(),
        source_url: "https://code.claude.com/docs/en/changelog".to_string(),
        from_version,
        to_version,
        entries: selected,
        truncated: truncated || selection_truncated,
    })
}

fn collapse_text(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn html_fragment_to_markdown(input: &str) -> String {
    let fragment = Html::parse_fragment(input);
    let selector = Selector::parse("h1, h2, h3, h4, h5, h6, li, p").unwrap();
    let mut lines = Vec::new();
    for node in fragment.select(&selector) {
        let text = collapse_text(&node.text().collect::<Vec<_>>().join(" "));
        if text.is_empty() {
            continue;
        }
        match node.value().name() {
            "li" => lines.push(format!("- {text}")),
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => lines.push(format!("### {text}")),
            _ => lines.push(text),
        }
    }
    if lines.is_empty() {
        let text = collapse_text(&fragment.root_element().text().collect::<Vec<_>>().join(" "));
        if !text.is_empty() {
            lines.push(text);
        }
    }
    lines.join("\n")
}

fn parse_codex_atom(raw: &str) -> Vec<ChangelogEntry> {
    let document = Html::parse_document(raw);
    let entry_selector = Selector::parse("entry").unwrap();
    let title_selector = Selector::parse("title").unwrap();
    let updated_selector = Selector::parse("updated").unwrap();
    let link_selector = Selector::parse("link[href]").unwrap();
    let content_selector = Selector::parse("content").unwrap();
    document
        .select(&entry_selector)
        .filter_map(|entry| {
            let title = entry
                .select(&title_selector)
                .next()
                .map(|node| collapse_text(&node.text().collect::<Vec<_>>().join(" ")))?;
            let version = normalize_cli_version(&title)?;
            let date = entry
                .select(&updated_selector)
                .next()
                .map(|node| collapse_text(&node.text().collect::<Vec<_>>().join(" ")))
                .filter(|s| !s.is_empty());
            let url = entry
                .select(&link_selector)
                .next()
                .and_then(|node| node.value().attr("href"))
                .map(str::to_string)
                .filter(|s| !s.is_empty());
            let raw_body = entry
                .select(&content_selector)
                .next()
                .map(|node| {
                    let inner = node.inner_html();
                    if inner.contains("&lt;") {
                        node.text().collect::<Vec<_>>().join("")
                    } else {
                        inner
                    }
                })
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| format!("Release {version}"));
            let body = html_fragment_to_markdown(&raw_body);
            let (body, _) = truncate_body(&body);
            Some(ChangelogEntry {
                version,
                date,
                body,
                url,
            })
        })
        .collect()
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    html_url: String,
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    published_at: Option<String>,
}

fn fetch_codex_release_by_version(version: &str) -> Result<Option<ChangelogEntry>, String> {
    let Some(normalized) = normalize_cli_version(version) else {
        return Ok(None);
    };
    let client = http_client()?;
    for tag in [
        format!("rust-v{normalized}"),
        format!("v{normalized}"),
        normalized.clone(),
    ] {
        let url = format!("https://api.github.com/repos/openai/codex/releases/tags/{tag}");
        let resp = client.get(&url).send();
        match resp {
            Ok(r) if r.status().is_success() => {
                let release = r
                    .json::<GithubRelease>()
                    .map_err(|e| format!("Invalid GitHub release JSON: {e}"))?;
                let title = release.name.unwrap_or(release.tag_name);
                let version = normalize_cli_version(&title).unwrap_or(normalized);
                let fallback = format!("Release {version}");
                let body_source = release
                    .body
                    .as_deref()
                    .filter(|b| !b.trim().is_empty())
                    .unwrap_or(&fallback);
                let (body, _) = truncate_body(body_source);
                return Ok(Some(ChangelogEntry {
                    version,
                    date: release.published_at,
                    body,
                    url: Some(release.html_url),
                }));
            }
            Ok(r) if r.status().as_u16() == 404 => continue,
            Ok(r) => return Err(format!("GitHub release lookup failed: HTTP {}", r.status())),
            Err(e) => return Err(format!("GitHub release lookup failed: {e}")),
        }
    }
    Ok(None)
}

fn fetch_codex_changelog(
    from_version: Option<String>,
    to_version: Option<String>,
) -> Result<CliChangelog, String> {
    const SOURCE_URL: &str = "https://github.com/openai/codex/releases";
    let raw = fetch_text("https://github.com/openai/codex/releases.atom")?;
    let mut entries = parse_codex_atom(&raw);
    let from = from_version.clone().and_then(|v| normalize_cli_version(&v));
    let to = to_version.clone().and_then(|v| normalize_cli_version(&v));
    let include_prereleases = to.as_deref().map(is_prerelease).unwrap_or(false);
    if !include_prereleases {
        entries.retain(|entry| !is_prerelease(&entry.version));
    }
    let (mut selected, mut truncated) = select_entries(entries, from, to.clone(), 5);

    if selected.is_empty() {
        if let Some(to) = to.as_deref() {
            if let Some(entry) = fetch_codex_release_by_version(to)? {
                selected.push(entry);
            }
        }
    }

    for entry in &selected {
        if entry.body.contains("[truncated]") {
            truncated = true;
        }
    }

    Ok(CliChangelog {
        cli: "codex".to_string(),
        source_url: SOURCE_URL.to_string(),
        from_version,
        to_version,
        entries: selected,
        truncated,
    })
}

#[tauri::command]
pub async fn fetch_cli_changelog(
    cli: String,
    from_version: Option<String>,
    to_version: Option<String>,
) -> Result<CliChangelog, String> {
    tokio::task::spawn_blocking(move || match cli.as_str() {
        "claude" => fetch_claude_changelog(from_version, to_version),
        "codex" => fetch_codex_changelog(from_version, to_version),
        other => Err(format!("Unsupported CLI for changelog: {other}")),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn check_latest_cli_version() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| format!("HTTP client error: {e}"))?;
        let resp = client
            .get("https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags")
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.text())
            .map_err(|e| format!("Failed to check npm: {e}"))?;
        let json: serde_json::Value =
            serde_json::from_str(&resp).map_err(|e| format!("Invalid JSON: {e}"))?;
        json["latest"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "No 'latest' field in npm dist-tags response".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Detect how Claude Code CLI was installed from its resolved path.
/// Normalizes path separators so Windows backslash paths match correctly.
fn normalized_install_paths(cli_path: &str) -> Vec<String> {
    let mut paths = vec![cli_path.replace('\\', "/").to_lowercase()];
    if let Ok(canonical) = std::fs::canonicalize(cli_path) {
        let canonical = canonical
            .to_string_lossy()
            .replace('\\', "/")
            .to_lowercase();
        if !paths.iter().any(|path| path == &canonical) {
            paths.push(canonical);
        }
    }
    paths
}

fn detect_install_method_from_normalized(lower: &str) -> &'static str {
    let components = lower.split('/').collect::<Vec<_>>();
    if components
        .iter()
        .any(|part| matches!(*part, "homebrew" | "linuxbrew"))
    {
        "brew"
    } else if components.iter().any(|part| *part == "volta") {
        "volta"
    } else if components.iter().any(|part| *part == "node_modules")
        || lower.ends_with(".cmd")
        || lower.ends_with(".ps1")
    {
        "npm"
    } else if lower.contains("/.local/share/claude/versions/")
        || components
            .windows(2)
            .any(|window| window == ["claude", "versions"])
    {
        "binary"
    } else {
        "unknown"
    }
}

fn detect_install_method(cli_path: &str) -> &'static str {
    for lower in normalized_install_paths(cli_path) {
        let method = detect_install_method_from_normalized(&lower);
        if method != "unknown" {
            return method;
        }
    }
    "unknown"
}

fn detect_codex_install_method_from_normalized(lower: &str) -> &'static str {
    let components = lower.split('/').collect::<Vec<_>>();
    if components
        .iter()
        .any(|part| matches!(*part, "homebrew" | "linuxbrew"))
    {
        "brew"
    } else if components.iter().any(|part| *part == "node_modules")
        || lower.ends_with(".cmd")
        || lower.ends_with(".ps1")
    {
        "npm"
    } else if components
        .windows(2)
        .any(|window| window == [".cargo", "bin"])
    {
        "cargo"
    } else if components.iter().any(|part| *part == ".codex") {
        "binary"
    } else {
        "unknown"
    }
}

fn detect_codex_install_method(cli_path: &str) -> &'static str {
    for lower in normalized_install_paths(cli_path) {
        let method = detect_codex_install_method_from_normalized(&lower);
        if method != "unknown" {
            return method;
        }
    }
    "unknown"
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdateResult {
    pub method: String,
    pub success: bool,
    pub message: String,
}

fn run_update_command(program: &str, args: &[&str]) -> CliUpdateResult {
    let method = program.to_string();
    let mut cmd = std::process::Command::new(program);
    cmd.args(args);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    match cmd.output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            if output.status.success() {
                CliUpdateResult {
                    method,
                    success: true,
                    message: if stdout.is_empty() {
                        "Update completed".to_string()
                    } else {
                        stdout
                    },
                }
            } else {
                CliUpdateResult {
                    method,
                    success: false,
                    message: if stderr.is_empty() {
                        format!("Update failed with exit code {}", output.status)
                    } else {
                        stderr
                    },
                }
            }
        }
        // Program not found or failed to execute
        Err(e) => CliUpdateResult {
            method,
            success: false,
            message: format!("Failed to run {program}: {e}"),
        },
    }
}

#[tauri::command]
pub async fn update_cli() -> Result<CliUpdateResult, String> {
    tokio::task::spawn_blocking(|| {
        let cli_path = super::detect_claude_cli_sync()?;
        let method = detect_install_method(&cli_path);

        let result = match method {
            "brew" => run_update_command("brew", &["upgrade", "claude-code"]),
            "npm" => run_update_command("npm", &["update", "-g", "@anthropic-ai/claude-code"]),
            "volta" => {
                run_update_command("volta", &["install", "@anthropic-ai/claude-code@latest"])
            }
            // For binary installs and unknown, try the CLI's own self-updater
            _ => run_update_command(&cli_path, &["update"]),
        };

        Ok(CliUpdateResult {
            method: method.to_string(),
            ..result
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn update_codex_cli() -> Result<CliUpdateResult, String> {
    tokio::task::spawn_blocking(|| {
        let cli_path = super::codex_cli::detect_codex_cli_sync()?;
        let method = detect_codex_install_method(&cli_path);

        let result = match method {
            "brew" => run_update_command("brew", &["upgrade", "codex"]),
            "npm" => run_update_command("npm", &["update", "-g", "@openai/codex"]),
            "cargo" => run_update_command("cargo", &["install", "codex-cli"]),
            _ => CliUpdateResult {
                method: method.to_string(),
                success: false,
                message: "Codex update is only supported for Homebrew, npm, and cargo installs"
                    .into(),
            },
        };

        Ok(CliUpdateResult {
            method: method.to_string(),
            ..result
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_compare_handles_cli_prefixes_and_prereleases() {
        assert!(compare_versions("Claude Code 2.1.119", "2.1.118").is_gt());
        assert!(compare_versions("codex-cli 0.126.0-alpha.1", "0.125.0").is_gt());
        assert!(compare_versions("0.126.0", "0.126.0-alpha.2").is_gt());
        assert!(compare_versions("0.126.0-alpha.10", "0.126.0-alpha.2").is_gt());
        assert!(compare_versions("2.0.0-rc.1", "2.0.0-beta.9").is_gt());
        assert!(compare_versions("garbage", "2.1.119").is_lt());
    }

    #[test]
    fn linux_native_chrome_uses_os_titlebar_for_kde_wayland() {
        assert!(linux_use_native_chrome_from_env("wayland", "KDE"));
        assert!(linux_use_native_chrome_from_env("wayland", "GNOME:KDE"));
        assert!(!linux_use_native_chrome_from_env("x11", "KDE"));
        assert!(!linux_use_native_chrome_from_env("wayland", "GNOME"));
    }

    #[test]
    fn codex_atom_parser_extracts_release_entries() {
        let raw = r#"
        <feed>
            <entry>
            <updated>2026-04-24T18:29:40Z</updated>
            <link rel="alternate" type="text/html" href="https://github.com/openai/codex/releases/tag/rust-v0.124.0"/>
            <title>0.124.0</title>
            <content type="html">&lt;h2&gt;New Features&lt;/h2&gt;&lt;ul&gt;&lt;li&gt;Added app-server work &#x2014; and &amp;copy; text.&lt;/li&gt;&lt;/ul&gt;</content>
          </entry>
        </feed>
        "#;
        let entries = parse_codex_atom(raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].version, "0.124.0");
        assert!(entries[0].body.contains("### New Features"));
        assert!(entries[0].body.contains("app-server work"));
        assert!(entries[0].body.contains("and \u{00a9} text."));
    }

    #[test]
    fn select_entries_filters_open_closed_version_range() {
        let entries = vec![
            ChangelogEntry {
                version: "2.1.119".into(),
                date: None,
                body: "a".into(),
                url: None,
            },
            ChangelogEntry {
                version: "2.1.118".into(),
                date: None,
                body: "b".into(),
                url: None,
            },
            ChangelogEntry {
                version: "2.1.117".into(),
                date: None,
                body: "c".into(),
                url: None,
            },
        ];
        let (selected, truncated) =
            select_entries(entries, Some("2.1.117".into()), Some("2.1.119".into()), 5);
        assert!(!truncated);
        assert_eq!(
            selected
                .iter()
                .map(|e| e.version.as_str())
                .collect::<Vec<_>>(),
            vec!["2.1.119", "2.1.118"],
        );
    }

    #[test]
    fn install_detection_matches_path_components_not_substrings() {
        assert_eq!(
            detect_install_method("/tmp/homebrewery/bin/claude"),
            "unknown"
        );
        assert_eq!(detect_install_method("/opt/homebrew/bin/claude"), "brew");
        assert_eq!(
            detect_install_method("/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"),
            "npm"
        );
        assert_eq!(
            detect_install_method(r"C:\Users\me\AppData\Roaming\npm\claude.cmd"),
            "npm"
        );
    }

    #[test]
    fn codex_install_detection_handles_supported_installers() {
        assert_eq!(
            detect_codex_install_method("/tmp/linuxbrewery/bin/codex"),
            "unknown"
        );
        assert_eq!(
            detect_codex_install_method("/home/linuxbrew/.linuxbrew/bin/codex"),
            "brew"
        );
        assert_eq!(
            detect_codex_install_method("/usr/lib/node_modules/@openai/codex/bin/codex.js"),
            "npm"
        );
        assert_eq!(
            detect_codex_install_method(r"C:\Users\me\.cargo\bin\codex.exe"),
            "cargo"
        );
    }
}

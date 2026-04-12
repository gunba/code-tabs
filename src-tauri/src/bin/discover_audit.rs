//! Standalone discovery audit binary.
//!
// [DA-01] discover_audit binary: subcommands dump/audit/fetch-docs; exit codes 0/1/2/3
// [DA-02] Advisory-only CI; triggers on discovery source changes + weekly
//!
//! Runs the same `claude_tabs_lib::discovery::*` functions the app runs, plus
//! a thin audit layer that diffs discovered items against docs.claude.com.
//! This exists so discovery drift surfaces in CI / dev tooling — not in
//! production error reports from users.
//!
//! Usage:
//!   discover_audit dump       [--cli-path PATH] [--what WHAT] [--format FORMAT]
//!   discover_audit audit      [--cli-path PATH] [--docs-dir DIR] [--what WHAT] [--docs-url URL]
//!   discover_audit fetch-docs [--out DIR]
//!
//! WHAT = settings|commands|env-vars|all   (default: all)
//! FORMAT = json|pretty                    (default: json)
//!
//! Exit codes:
//!   0 = success (audit: 0 missing)
//!   1 = audit found missing items
//!   2 = usage / invocation error
//!   3 = runtime error (discovery / network / parse)

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::process::ExitCode;

use claude_tabs_lib::discovery::{
    discover_builtin_commands_sync, discover_env_vars_sync, discover_plugin_commands_sync,
    discover_settings_schema_sync,
};
use scraper::{Html, Selector};

const SETTINGS_URL: &str = "https://code.claude.com/docs/en/settings";
const COMMANDS_URL: &str = "https://code.claude.com/docs/en/commands";
const ENV_VARS_URL: &str = "https://code.claude.com/docs/en/env-vars";

// ---------------- argv parsing (minimal, no clap dep) ----------------

struct Args {
    cli_path: Option<String>,
    what: What,
    format: Format,
    docs_dir: Option<PathBuf>,
    docs_url_override: Option<String>,
    out_dir: Option<PathBuf>,
}

#[derive(Clone, Copy, PartialEq)]
enum What {
    Settings,
    Commands,
    EnvVars,
    All,
}

#[derive(Clone, Copy, PartialEq)]
enum Format {
    Json,
    Pretty,
}

fn parse_args(raw: &[String]) -> Result<Args, String> {
    let mut args = Args {
        cli_path: None,
        what: What::All,
        format: Format::Json,
        docs_dir: None,
        docs_url_override: None,
        out_dir: None,
    };
    let mut i = 0;
    while i < raw.len() {
        match raw[i].as_str() {
            "--cli-path" => {
                args.cli_path = Some(raw.get(i + 1).cloned().ok_or("--cli-path needs a value")?);
                i += 2;
            }
            "--what" => {
                let v = raw.get(i + 1).ok_or("--what needs a value")?.as_str();
                args.what = match v {
                    "settings" => What::Settings,
                    "commands" => What::Commands,
                    "env-vars" => What::EnvVars,
                    "all" => What::All,
                    other => return Err(format!("--what: unknown value {:?}", other)),
                };
                i += 2;
            }
            "--format" => {
                let v = raw.get(i + 1).ok_or("--format needs a value")?.as_str();
                args.format = match v {
                    "json" => Format::Json,
                    "pretty" => Format::Pretty,
                    other => return Err(format!("--format: unknown value {:?}", other)),
                };
                i += 2;
            }
            "--docs-dir" => {
                args.docs_dir = Some(PathBuf::from(
                    raw.get(i + 1).ok_or("--docs-dir needs a value")?,
                ));
                i += 2;
            }
            "--docs-url" => {
                args.docs_url_override =
                    Some(raw.get(i + 1).cloned().ok_or("--docs-url needs a value")?);
                i += 2;
            }
            "--out" => {
                args.out_dir =
                    Some(PathBuf::from(raw.get(i + 1).ok_or("--out needs a value")?));
                i += 2;
            }
            other => return Err(format!("unknown argument: {}", other)),
        }
    }
    Ok(args)
}

// ---------------- main dispatcher ----------------

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().collect();
    if argv.len() < 2 {
        print_usage();
        return ExitCode::from(2);
    }
    let subcommand = argv[1].clone();
    let rest = &argv[2..];
    let args = match parse_args(rest) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("error: {}", e);
            print_usage();
            return ExitCode::from(2);
        }
    };
    match subcommand.as_str() {
        "dump" => cmd_dump(&args),
        "audit" => cmd_audit(&args),
        "fetch-docs" => cmd_fetch_docs(&args),
        "-h" | "--help" | "help" => {
            print_usage();
            ExitCode::SUCCESS
        }
        other => {
            eprintln!("unknown subcommand: {}", other);
            print_usage();
            ExitCode::from(2)
        }
    }
}

fn print_usage() {
    eprintln!(
        "discover_audit — test discovery against docs.claude.com\n\
         \n\
         USAGE:\n    \
         discover_audit <subcommand> [--cli-path PATH] [--what WHAT] [--format FORMAT] ...\n\
         \n\
         SUBCOMMANDS:\n    \
         dump       Print what the discovery pipeline finds (JSON).\n    \
         audit      Diff discovery output against cached docs pages; exit 1 if anything is missing.\n    \
         fetch-docs Download docs.claude.com pages for offline audit; refresh when docs change.\n\
         \n\
         WHAT    = settings | commands | env-vars | all     (default: all)\n\
         FORMAT  = json | pretty                            (default: json)"
    );
}

// ---------------- subcommands ----------------

fn cmd_dump(args: &Args) -> ExitCode {
    let discovered = match run_discovery(args) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("discovery error: {}", e);
            return ExitCode::from(3);
        }
    };
    match args.format {
        Format::Json => {
            let json = serde_json::to_string_pretty(&discovered.to_json()).unwrap();
            println!("{}", json);
        }
        Format::Pretty => discovered.print_pretty(),
    }
    ExitCode::SUCCESS
}

fn cmd_audit(args: &Args) -> ExitCode {
    let discovered = match run_discovery(args) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("discovery error: {}", e);
            return ExitCode::from(3);
        }
    };

    let docs = match load_docs(args) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("docs load error: {}", e);
            return ExitCode::from(3);
        }
    };

    let report = audit_diff(&discovered, &docs, args.what);
    match args.format {
        Format::Json => {
            println!("{}", serde_json::to_string_pretty(&report.to_json()).unwrap());
        }
        Format::Pretty => report.print_pretty(),
    }

    if report.total_missing() > 0 {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}

fn cmd_fetch_docs(args: &Args) -> ExitCode {
    let out = args
        .out_dir
        .clone()
        .unwrap_or_else(|| PathBuf::from("src-tauri/tests/fixtures"));
    if let Err(e) = std::fs::create_dir_all(&out) {
        eprintln!("failed to create {}: {}", out.display(), e);
        return ExitCode::from(3);
    }
    let targets = [
        (SETTINGS_URL, "settings.html"),
        (COMMANDS_URL, "commands.html"),
        (ENV_VARS_URL, "env-vars.html"),
    ];
    for (url, fname) in targets {
        match fetch_url(url) {
            Ok(body) => {
                let path = out.join(fname);
                if let Err(e) = std::fs::write(&path, &body) {
                    eprintln!("failed to write {}: {}", path.display(), e);
                    return ExitCode::from(3);
                }
                eprintln!("fetched {} ({} bytes) -> {}", url, body.len(), path.display());
            }
            Err(e) => {
                eprintln!("fetch {} failed: {}", url, e);
                return ExitCode::from(3);
            }
        }
    }
    ExitCode::SUCCESS
}

// ---------------- discovery runner ----------------

#[derive(Default)]
struct DiscoveredSet {
    settings: BTreeMap<String, serde_json::Value>,
    commands: BTreeMap<String, serde_json::Value>,
    env_vars: BTreeMap<String, serde_json::Value>,
    // What we actually ran — the auditor uses this to know whether to diff each set.
    ran_settings: bool,
    ran_commands: bool,
    ran_env_vars: bool,
}

impl DiscoveredSet {
    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "settings": self.settings.values().cloned().collect::<Vec<_>>(),
            "commands": self.commands.values().cloned().collect::<Vec<_>>(),
            "envVars":  self.env_vars.values().cloned().collect::<Vec<_>>(),
        })
    }

    fn print_pretty(&self) {
        if self.ran_settings {
            println!("Settings ({}):", self.settings.len());
            for k in self.settings.keys() {
                println!("  {}", k);
            }
        }
        if self.ran_commands {
            println!("Commands ({}):", self.commands.len());
            for k in self.commands.keys() {
                println!("  {}", k);
            }
        }
        if self.ran_env_vars {
            println!("Env vars ({}):", self.env_vars.len());
            for k in self.env_vars.keys() {
                println!("  {}", k);
            }
        }
    }
}

fn run_discovery(args: &Args) -> Result<DiscoveredSet, String> {
    let mut out = DiscoveredSet::default();
    let cli_path = args.cli_path.as_deref();

    if matches!(args.what, What::Settings | What::All) {
        out.ran_settings = true;
        for field in discover_settings_schema_sync(cli_path)? {
            if let Some(k) = field.get("key").and_then(|v| v.as_str()) {
                out.settings.insert(k.to_string(), field);
            }
        }
    }

    if matches!(args.what, What::Commands | What::All) {
        out.ran_commands = true;
        for entry in discover_builtin_commands_sync(cli_path)? {
            if let Some(k) = entry.get("cmd").and_then(|v| v.as_str()) {
                out.commands.insert(k.to_string(), entry);
            }
        }
        // Include plugin/user-skill commands in the discovered set so the
        // commands audit doesn't treat user skills as extra.
        let (plugin, rejections) = discover_plugin_commands_sync(&[])?;
        if !rejections.is_empty() {
            eprintln!(
                "warning: {} SKILL.md file(s) rejected during plugin scan",
                rejections.len()
            );
            for r in &rejections {
                eprintln!("  {}: {}", r.path, r.reason);
            }
        }
        for entry in plugin {
            if let Some(k) = entry.get("cmd").and_then(|v| v.as_str()) {
                out.commands.entry(k.to_string()).or_insert(entry);
            }
        }
    }

    if matches!(args.what, What::EnvVars | What::All) {
        out.ran_env_vars = true;
        for var in discover_env_vars_sync(cli_path)? {
            let j = serde_json::to_value(&var).map_err(|e| e.to_string())?;
            out.env_vars.insert(var.name.clone(), j);
        }
    }

    Ok(out)
}

// ---------------- docs loader ----------------

struct DocsExpected {
    settings: Option<BTreeSet<String>>,
    commands: Option<BTreeSet<CommandExpectation>>,
    env_vars: Option<BTreeSet<String>>,
}

#[derive(Clone, Eq, PartialEq, Ord, PartialOrd)]
struct CommandExpectation {
    /// Canonical form starting with `/`.
    cmd: String,
    /// True when the docs row carried a [Skill] marker. Currently informational
    /// only — we report skills as missing the same way as other commands.
    is_skill: bool,
}

fn load_docs(args: &Args) -> Result<DocsExpected, String> {
    let default_dir = PathBuf::from("src-tauri/tests/fixtures");
    let docs_dir = args.docs_dir.clone().unwrap_or(default_dir);
    let want = args.what;

    let read = |fname: &str, url_when_missing: &str| -> Result<Option<String>, String> {
        let path = docs_dir.join(fname);
        if path.exists() {
            std::fs::read_to_string(&path)
                .map(Some)
                .map_err(|e| format!("read {}: {}", path.display(), e))
        } else if let Some(url) = args.docs_url_override.as_deref() {
            fetch_url(url).map(Some)
        } else {
            // Offline-friendly: if the fixture is missing, emit a clear error so
            // the caller knows to run `discover_audit fetch-docs`.
            Err(format!(
                "{} not found. Run `discover_audit fetch-docs` first or pass --docs-dir. (source: {})",
                path.display(),
                url_when_missing
            ))
        }
    };

    let settings = if matches!(want, What::Settings | What::All) {
        read("settings.html", SETTINGS_URL)?.as_deref().map(parse_settings_html).transpose()?
    } else {
        None
    };
    let commands = if matches!(want, What::Commands | What::All) {
        read("commands.html", COMMANDS_URL)?.as_deref().map(parse_commands_html).transpose()?
    } else {
        None
    };
    let env_vars = if matches!(want, What::EnvVars | What::All) {
        read("env-vars.html", ENV_VARS_URL)?.as_deref().map(parse_env_vars_html).transpose()?
    } else {
        None
    };

    Ok(DocsExpected {
        settings,
        commands,
        env_vars,
    })
}

// ---------------- docs parsers ----------------
//
// Mintlify pages render markdown tables as `<table><thead><tr><th>…</th></tr></thead>
// <tbody><tr><td>…</td></tr>…</tbody></table>`. We extract the *first column* of
// every `<tr>` under a `<tbody>` and trim it to the bare identifier, stripping
// trailing tags and noise like `(Recommended)`.

fn parse_settings_html(html: &str) -> Result<BTreeSet<String>, String> {
    let doc = Html::parse_document(html);
    let tr_sel = Selector::parse("table tbody tr").unwrap();
    let td_sel = Selector::parse("td").unwrap();
    let code_sel = Selector::parse("code").unwrap();
    let mut out = BTreeSet::new();
    for row in doc.select(&tr_sel) {
        let first_td = match row.select(&td_sel).next() {
            Some(td) => td,
            None => continue,
        };
        // Prefer inner <code> text (docs put setting keys in code ticks).
        let raw = match first_td.select(&code_sel).next() {
            Some(c) => c.text().collect::<String>(),
            None => first_td.text().collect::<String>(),
        };
        let key = normalize_key(&raw);
        if is_plausible_setting_key(&key) {
            out.insert(key);
        }
    }
    if out.is_empty() {
        return Err("settings.html: found 0 rows — parser may be broken or fixture wrong page".into());
    }
    Ok(out)
}

fn parse_commands_html(html: &str) -> Result<BTreeSet<CommandExpectation>, String> {
    let doc = Html::parse_document(html);
    let tr_sel = Selector::parse("table tbody tr").unwrap();
    let td_sel = Selector::parse("td").unwrap();
    let code_sel = Selector::parse("code").unwrap();
    let mut out: BTreeSet<CommandExpectation> = BTreeSet::new();
    for row in doc.select(&tr_sel) {
        let mut tds = row.select(&td_sel);
        let first_td = match tds.next() {
            Some(td) => td,
            None => continue,
        };
        let second_td_text = tds.next().map(|td| td.text().collect::<String>()).unwrap_or_default();
        // Commands are rendered as `<code>/commit</code>`; strip to slash-name.
        let raw = match first_td.select(&code_sel).next() {
            Some(c) => c.text().collect::<String>(),
            None => first_td.text().collect::<String>(),
        };
        let raw = raw.trim();
        // Normalize: take first whitespace-separated token (arguments like `<arg>` are after the name).
        let cmd = raw.split_whitespace().next().unwrap_or("").to_string();
        if !cmd.starts_with('/') || cmd.len() < 2 {
            continue;
        }
        let is_skill = second_td_text.contains("[Skill]");
        out.insert(CommandExpectation { cmd, is_skill });
    }
    if out.is_empty() {
        return Err("commands.html: found 0 rows — parser may be broken or fixture wrong page".into());
    }
    Ok(out)
}

fn parse_env_vars_html(html: &str) -> Result<BTreeSet<String>, String> {
    let doc = Html::parse_document(html);
    let tr_sel = Selector::parse("table tbody tr").unwrap();
    let td_sel = Selector::parse("td").unwrap();
    let code_sel = Selector::parse("code").unwrap();
    let mut out = BTreeSet::new();
    for row in doc.select(&tr_sel) {
        let first_td = match row.select(&td_sel).next() {
            Some(td) => td,
            None => continue,
        };
        let raw = match first_td.select(&code_sel).next() {
            Some(c) => c.text().collect::<String>(),
            None => first_td.text().collect::<String>(),
        };
        let name = raw.trim().to_string();
        // Env vars are UPPER_SNAKE_CASE; filter noise.
        if name.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
            && name.len() >= 3
            && name.chars().next().map_or(false, |c| c.is_ascii_uppercase())
        {
            out.insert(name);
        }
    }
    if out.is_empty() {
        return Err("env-vars.html: found 0 rows — parser may be broken or fixture wrong page".into());
    }
    Ok(out)
}

fn normalize_key(raw: &str) -> String {
    // Strip surrounding whitespace, backticks, parens like `(Recommended)`.
    let s = raw.trim().trim_matches('`').trim();
    // Stop at the first char that isn't a valid identifier/subkey separator.
    s.chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '.' || *c == '-')
        .collect::<String>()
}

fn is_plausible_setting_key(s: &str) -> bool {
    if s.is_empty() || s.len() > 64 {
        return false;
    }
    // Real settings are camelCase or dotted.path.camelCase — always start with
    // an ASCII lowercase letter. This cheap filter drops noise rows from the
    // page's non-setting tables (scope comparisons, permission-rule examples,
    // use-case summaries with header words like "Bash", "Project", "User").
    let first = match s.chars().next() {
        Some(c) => c,
        None => return false,
    };
    if !first.is_ascii_lowercase() {
        return false;
    }
    // Allow letters, digits, dots (for nested keys like worktree.isolation),
    // underscores and dashes (some permission names use hyphens).
    s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

// ---------------- diff / report ----------------

struct AuditReport {
    settings_missing: Vec<String>,
    settings_extra: Vec<String>,
    commands_missing: Vec<String>,
    commands_extra: Vec<String>,
    env_vars_missing: Vec<String>,
    env_vars_extra: Vec<String>,
    settings_checked: bool,
    commands_checked: bool,
    env_vars_checked: bool,
}

impl AuditReport {
    fn total_missing(&self) -> usize {
        self.settings_missing.len() + self.commands_missing.len() + self.env_vars_missing.len()
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "settings": {
                "checked": self.settings_checked,
                "missing": self.settings_missing,
                "extra": self.settings_extra,
            },
            "commands": {
                "checked": self.commands_checked,
                "missing": self.commands_missing,
                "extra": self.commands_extra,
            },
            "envVars": {
                "checked": self.env_vars_checked,
                "missing": self.env_vars_missing,
                "extra": self.env_vars_extra,
            },
            "totalMissing": self.total_missing(),
        })
    }

    fn print_pretty(&self) {
        let print_section = |label: &str, checked: bool, missing: &[String], extra: &[String]| {
            if !checked {
                return;
            }
            println!(
                "{}: {} missing, {} extra (informational)",
                label,
                missing.len(),
                extra.len()
            );
            for m in missing {
                println!("  MISSING {}", m);
            }
            if !extra.is_empty() {
                println!("  (extra keys — present in discovery but not in docs; often OK):");
                for e in extra {
                    println!("    {}", e);
                }
            }
        };
        print_section("Settings", self.settings_checked, &self.settings_missing, &self.settings_extra);
        print_section("Commands", self.commands_checked, &self.commands_missing, &self.commands_extra);
        print_section("Env vars", self.env_vars_checked, &self.env_vars_missing, &self.env_vars_extra);
        println!("\ntotal missing: {}", self.total_missing());
    }
}

fn audit_diff(found: &DiscoveredSet, docs: &DocsExpected, want: What) -> AuditReport {
    let (sm, se) = match (&docs.settings, matches!(want, What::Settings | What::All)) {
        (Some(expected), true) => diff_string_sets(&found.settings.keys().cloned().collect(), expected),
        _ => (Vec::new(), Vec::new()),
    };
    let (cm, ce) = match (&docs.commands, matches!(want, What::Commands | What::All)) {
        (Some(expected), true) => {
            let expected_set: BTreeSet<String> = expected.iter().map(|c| c.cmd.clone()).collect();
            diff_string_sets(&found.commands.keys().cloned().collect(), &expected_set)
        }
        _ => (Vec::new(), Vec::new()),
    };
    let (em, ee) = match (&docs.env_vars, matches!(want, What::EnvVars | What::All)) {
        (Some(expected), true) => diff_string_sets(&found.env_vars.keys().cloned().collect(), expected),
        _ => (Vec::new(), Vec::new()),
    };

    AuditReport {
        settings_checked: docs.settings.is_some(),
        commands_checked: docs.commands.is_some(),
        env_vars_checked: docs.env_vars.is_some(),
        settings_missing: sm,
        settings_extra: se,
        commands_missing: cm,
        commands_extra: ce,
        env_vars_missing: em,
        env_vars_extra: ee,
    }
}

fn diff_string_sets(
    found: &BTreeSet<String>,
    expected: &BTreeSet<String>,
) -> (Vec<String>, Vec<String>) {
    let missing: Vec<String> = expected.difference(found).cloned().collect();
    let extra: Vec<String> = found.difference(expected).cloned().collect();
    (missing, extra)
}

// ---------------- network ----------------

fn fetch_url(url: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("claude-tabs-discover-audit/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {}", e))?;
    let resp = client
        .get(url)
        .send()
        .map_err(|e| format!("http get {}: {}", url, e))?
        .error_for_status()
        .map_err(|e| format!("http status {}: {}", url, e))?;
    resp.text().map_err(|e| format!("http body {}: {}", url, e))
}

// ---------------- tests ----------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal settings fixture mirroring the Mintlify table shape.
    const SETTINGS_FIXTURE: &str = r#"
<html><body>
<h2>Available settings</h2>
<table><thead><tr><th>Key</th><th>Description</th></tr></thead>
<tbody>
  <tr><td><code>showThinkingSummaries</code></td><td>Show thinking summaries</td></tr>
  <tr><td><code>model</code></td><td>Default model</td></tr>
  <tr><td><code>permissions.allow</code></td><td>Permission allow rules</td></tr>
</tbody></table>
<h2>Worktree settings</h2>
<table><thead><tr><th>Key</th><th>Description</th></tr></thead>
<tbody>
  <tr><td><code>worktree.isolation</code></td><td>Isolation mode</td></tr>
</tbody></table>
</body></html>
"#;

    const COMMANDS_FIXTURE: &str = r#"
<html><body>
<table><thead><tr><th>Command</th><th>Purpose</th></tr></thead>
<tbody>
  <tr><td><code>/commit</code></td><td>[Skill] Create a commit</td></tr>
  <tr><td><code>/review-pr</code> &lt;num&gt;</td><td>Review a PR</td></tr>
  <tr><td><code>/help</code></td><td>Show help</td></tr>
</tbody></table>
</body></html>
"#;

    const ENV_VARS_FIXTURE: &str = r#"
<html><body>
<table><thead><tr><th>Variable</th><th>Purpose</th></tr></thead>
<tbody>
  <tr><td><code>ANTHROPIC_API_KEY</code></td><td>API key</td></tr>
  <tr><td><code>CLAUDE_CODE_MAX_OUTPUT_TOKENS</code></td><td>Max tokens</td></tr>
</tbody></table>
</body></html>
"#;

    #[test]
    fn parse_settings_extracts_keys_from_multiple_tables() {
        let keys = parse_settings_html(SETTINGS_FIXTURE).unwrap();
        assert!(keys.contains("showThinkingSummaries"));
        assert!(keys.contains("model"));
        assert!(keys.contains("permissions.allow"));
        assert!(keys.contains("worktree.isolation"));
    }

    #[test]
    fn parse_commands_extracts_and_marks_skills() {
        let cmds = parse_commands_html(COMMANDS_FIXTURE).unwrap();
        let by_name: std::collections::BTreeMap<_, _> =
            cmds.iter().map(|c| (c.cmd.clone(), c.is_skill)).collect();
        assert_eq!(by_name.get("/commit"), Some(&true), "skill marker detected");
        assert_eq!(by_name.get("/review-pr"), Some(&false));
        assert_eq!(by_name.get("/help"), Some(&false));
    }

    #[test]
    fn parse_env_vars_extracts_uppercase_names() {
        let vars = parse_env_vars_html(ENV_VARS_FIXTURE).unwrap();
        assert!(vars.contains("ANTHROPIC_API_KEY"));
        assert!(vars.contains("CLAUDE_CODE_MAX_OUTPUT_TOKENS"));
    }

    #[test]
    fn diff_reports_missing_and_extra() {
        let found: BTreeSet<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        let expected: BTreeSet<String> = ["b", "c", "d"].iter().map(|s| s.to_string()).collect();
        let (missing, extra) = diff_string_sets(&found, &expected);
        assert_eq!(missing, vec!["d".to_string()]);
        assert_eq!(extra, vec!["a".to_string()]);
    }

    #[test]
    fn parse_rejects_empty_table() {
        let html = "<html><body><table><tbody></tbody></table></body></html>";
        let err = parse_settings_html(html).unwrap_err();
        assert!(err.contains("0 rows"));
    }

    #[test]
    fn normalize_key_strips_noise() {
        assert_eq!(normalize_key("  `showThinkingSummaries`  "), "showThinkingSummaries");
        assert_eq!(normalize_key("permissions.allow (Recommended)"), "permissions.allow");
        assert_eq!(normalize_key("fast-mode"), "fast-mode");
    }
}

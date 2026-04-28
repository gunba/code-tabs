//! Claude Code CLI discovery primitives.
//!
//! Pure sync functions used by both the runtime Tauri commands (`commands::cli`)
//! and the standalone `discover_audit` binary (`bin/discover_audit.rs`) — same
//! code path in both, so the audit tool can never drift from the runtime.
//!
//! Codex's equivalent lives in `super::codex`. Shared types/helpers
//! (`DiscoveredEnvVar`, `PluginScanRejection`, `scan_skill_md`, …) live in
//! `super` (`discovery/mod.rs`).

use regex::Regex;
use serde_json::json;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use super::{scan_skill_md, DiscoveredEnvVar, PluginScanRejection};

// Current Claude Code standalone binaries can be well over 200 MB. Keep this
// as a guardrail against accidental huge-file reads, not as a shape assertion.
const CLAUDE_BINARY_MAX_BYTES: u64 = 500 * 1024 * 1024;
const MAX_PLUGIN_SCAN_DEPTH: usize = 8;

static CMD_SHIM_JS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)"([^"]+\.js)""#).unwrap());
static BUILTIN_NAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"name:"([\w][\w-]*)""#).unwrap());
static DESC_LITERAL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"description:"([^"]*?)""#).unwrap());
static DESC_COMPUTED_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"description[^"]{0,80}"([^"]*?)""#).unwrap());
static DESC_TEMPLATE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"description[^`]{0,80}`([^`]*?)`"#).unwrap());
static STRIP_INTERPOLATIONS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"\$\{[^}]*\}"#).unwrap());
static SETTINGS_DESC_DOUBLE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"\.describe\("([^"]{4,500})"\)"#).unwrap());
static SETTINGS_DESC_SINGLE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"\.describe\('([^']{4,500})'\)"#).unwrap());
static SETTINGS_DESC_TEMPLATE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"\.describe\(`([^`]{4,500})`\)"#).unwrap());
static ENUM_CHOICES_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"\[([^\]]{1,200})\]"#).unwrap());
static SETTINGS_METADATA_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"([a-zA-Z][a-zA-Z0-9]{1,40}):\{source:"(?:global|project|local|user|managed|policy|dynamic)","#,
    )
    .unwrap()
});
static SETTINGS_FACTORY_KEY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"([a-zA-Z][a-zA-Z0-9]{1,40}):[a-zA-Z_$][a-zA-Z0-9_$]{0,20}\([^)]{0,160}\)(?:\.[a-zA-Z]+\([^)]*\))*\.describe\("#,
    )
    .unwrap()
});
static GLOBAL_CONFIG_LITERAL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""([a-z][a-zA-Z0-9]{1,40})""#).unwrap());
static ZOD_ESM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"import\s*\*\s*as\s+([a-zA-Z_$][a-zA-Z0-9_$]{0,3})\s*from\s*["']zod["']"#).unwrap()
});
static ZOD_CJS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"([a-zA-Z_$][a-zA-Z0-9_$]{0,3})\s*=\s*require\(\s*["']zod["']\s*\)"#).unwrap()
});
static ZOD_ESBUILD_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"[,;(]\s*([a-zA-Z_$][a-zA-Z0-9_$]{0,3})\s*=\s*[a-zA-Z_$][a-zA-Z0-9_$]{0,3}\(\s*["']zod["']\s*\)"#)
        .unwrap()
});
static ZOD_SIGNAL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"([a-zA-Z_$][a-zA-Z0-9_$]{0,3})\.(object|string|boolean|number|enum|array|record|literal|union|discriminatedUnion)\("#,
    )
    .unwrap()
});
static ENV_DOT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"process\.env\.([A-Z][A-Z0-9_]{2,})").unwrap());
static ENV_BRACKET_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"process\.env\[["']([A-Z][A-Z0-9_]{2,})["']\]"#).unwrap());
static ENV_LITERAL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"["']([A-Z][A-Z0-9_]{5,})["']"#).unwrap());
static ENV_ASSIGN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"["']([A-Z][A-Z0-9_]{5,})=[^"']{0,80}["']"#).unwrap());
static ENV_WORD_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"\b([A-Z][A-Z0-9_]{5,})\b"#).unwrap());

/// Content + provenance of a Claude Code binary read from disk.
pub struct ClaudeBinaryRead {
    pub content: String,
    pub source: &'static str,
    pub path: Option<String>,
}

#[derive(Clone, Copy)]
enum ClaudeBinarySource {
    CmdShimJs,
    SymlinkTarget,
    DirectCliPath,
    SiblingNodeModules,
    LegacyVersionsDir,
    NpmRootGlobal,
}

impl ClaudeBinarySource {
    fn as_str(self) -> &'static str {
        match self {
            ClaudeBinarySource::CmdShimJs => "cmd_shim_js",
            ClaudeBinarySource::SymlinkTarget => "symlink_target",
            ClaudeBinarySource::DirectCliPath => "direct_cli_path",
            ClaudeBinarySource::SiblingNodeModules => "sibling_node_modules",
            ClaudeBinarySource::LegacyVersionsDir => "legacy_versions_dir",
            ClaudeBinarySource::NpmRootGlobal => "npm_root_global",
        }
    }
}

struct ClaudeBinaryCandidate {
    path: PathBuf,
    source: ClaudeBinarySource,
}

enum CandidateRead {
    Missing,
    Unreadable(String),
    TooLarge(u64),
    Readable(String),
}

fn read_candidate(path: &Path) -> CandidateRead {
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return CandidateRead::Missing,
        Err(e) => return CandidateRead::Unreadable(e.to_string()),
    };
    if !meta.is_file() {
        return CandidateRead::Missing;
    }
    if meta.len() > CLAUDE_BINARY_MAX_BYTES {
        return CandidateRead::TooLarge(meta.len());
    }

    let likely_text = matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("js" | "mjs" | "cjs")
    );
    if likely_text {
        match std::fs::read_to_string(path) {
            Ok(content) => return CandidateRead::Readable(content),
            Err(_) => {}
        }
    }

    match std::fs::read(path) {
        Ok(bytes) => CandidateRead::Readable(String::from_utf8_lossy(&bytes).into_owned()),
        Err(e) => CandidateRead::Unreadable(e.to_string()),
    }
}

fn is_claude_content(content: &str) -> bool {
    let has_command_shape = content.contains(r#"name:""#) && content.contains("description:");
    let has_claude_anchor = [
        "@anthropic-ai/claude-code",
        "getPromptForCommand",
        "userInvocable:!0",
        "whenToUse:",
        "pluginCommand:",
    ]
    .iter()
    .any(|anchor| content.contains(anchor));

    has_command_shape && has_claude_anchor
}

fn resolve_cmd_shim_targets(path: &Path) -> Vec<PathBuf> {
    let shim = match std::fs::read_to_string(path) {
        Ok(shim) => shim,
        Err(_) => return Vec::new(),
    };
    CMD_SHIM_JS_RE
        .captures_iter(&shim)
        .filter_map(|cap| cap.get(1).map(|m| PathBuf::from(m.as_str())))
        .collect()
}

fn push_candidate(
    candidates: &mut Vec<ClaudeBinaryCandidate>,
    path: PathBuf,
    source: ClaudeBinarySource,
) {
    candidates.push(ClaudeBinaryCandidate { path, source });
}

fn initial_claude_binary_candidates(cli_path: Option<&str>) -> Vec<ClaudeBinaryCandidate> {
    let mut candidates = Vec::new();

    if let Some(path_str) = cli_path {
        let path = Path::new(path_str);

        if path_str.to_lowercase().ends_with(".cmd") {
            for js_path in resolve_cmd_shim_targets(path) {
                push_candidate(&mut candidates, js_path, ClaudeBinarySource::CmdShimJs);
            }
        }

        #[cfg(not(target_os = "windows"))]
        if path.is_symlink() {
            if let Ok(resolved) = std::fs::canonicalize(path) {
                push_candidate(&mut candidates, resolved, ClaudeBinarySource::SymlinkTarget);
            }
        }

        push_candidate(
            &mut candidates,
            path.to_path_buf(),
            ClaudeBinarySource::DirectCliPath,
        );

        if let Some(parent) = path.parent() {
            push_candidate(
                &mut candidates,
                parent
                    .join("node_modules")
                    .join("@anthropic-ai")
                    .join("claude-code")
                    .join("cli.js"),
                ClaudeBinarySource::SiblingNodeModules,
            );
        }
    }

    if let Some(home) = dirs::home_dir() {
        let versions_dir = home
            .join(".local")
            .join("share")
            .join("claude")
            .join("versions");
        if let Ok(entries) = std::fs::read_dir(&versions_dir) {
            let mut versions: Vec<_> = entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            // Sort by parsed semver tuple so "2.1.104" > "2.1.92". Non-numeric
            // segments sort after numeric ones but still deterministically.
            versions.sort_by(|a, b| version_key(a).cmp(&version_key(b)));
            if let Some(v) = versions.last() {
                push_candidate(
                    &mut candidates,
                    versions_dir.join(v),
                    ClaudeBinarySource::LegacyVersionsDir,
                );
            }
        }
    }

    candidates
}

fn npm_global_candidate() -> Option<ClaudeBinaryCandidate> {
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    let mut npm_cmd = std::process::Command::new("npm");
    npm_cmd.args(["root", "-g"]);
    #[cfg(target_os = "windows")]
    npm_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = npm_cmd.output().ok()?;
    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        return None;
    }
    Some(ClaudeBinaryCandidate {
        path: Path::new(&root)
            .join("@anthropic-ai")
            .join("claude-code")
            .join("cli.js"),
        source: ClaudeBinarySource::NpmRootGlobal,
    })
}

fn read_first_valid_candidate(
    candidates: Vec<ClaudeBinaryCandidate>,
) -> Result<Option<ClaudeBinaryRead>, String> {
    let mut seen = HashSet::new();
    let mut rejected = Vec::new();

    for candidate in candidates {
        let dedup_key = std::fs::canonicalize(&candidate.path).unwrap_or(candidate.path.clone());
        if !seen.insert(dedup_key) {
            continue;
        }

        match read_candidate(&candidate.path) {
            CandidateRead::Missing => {}
            CandidateRead::Unreadable(err) => rejected.push(format!(
                "{} ({}): unreadable: {}",
                candidate.path.to_string_lossy(),
                candidate.source.as_str(),
                err
            )),
            CandidateRead::TooLarge(len) => rejected.push(format!(
                "{} ({}): {} bytes exceeds {} byte cap",
                candidate.path.to_string_lossy(),
                candidate.source.as_str(),
                len,
                CLAUDE_BINARY_MAX_BYTES
            )),
            CandidateRead::Readable(content) => {
                if is_claude_content(&content) {
                    return Ok(Some(ClaudeBinaryRead {
                        content,
                        source: candidate.source.as_str(),
                        path: Some(candidate.path.to_string_lossy().to_string()),
                    }));
                }
                rejected.push(format!(
                    "{} ({}): did not match Claude Code binary markers",
                    candidate.path.to_string_lossy(),
                    candidate.source.as_str()
                ));
            }
        }
    }

    if rejected.is_empty() {
        Ok(None)
    } else {
        Err(format!(
            "Could not locate Claude Code binary; rejected candidate(s): {}",
            rejected.join("; ")
        ))
    }
}

// [RC-16] 5-step binary resolution: .cmd shim -> direct -> sibling node_modules -> legacy versions -> npm root -g
/// Read the Claude Code binary content for pattern scanning.
/// Resolution chain: direct CLI path -> .cmd shim -> sibling node_modules -> legacy versions dir -> npm root -g.
pub fn read_claude_binary(cli_path: Option<&str>) -> Result<ClaudeBinaryRead, String> {
    match read_first_valid_candidate(initial_claude_binary_candidates(cli_path))? {
        Some(binary) => return Ok(binary),
        None => {}
    }

    // `npm root -g` is a slow process fallback. Only use it after all cheap
    // filesystem candidates are absent; if a readable candidate was rejected,
    // returning that reason is more accurate than silently scanning elsewhere.
    if let Some(candidate) = npm_global_candidate() {
        if let Some(binary) = read_first_valid_candidate(vec![candidate])? {
            return Ok(binary);
        }
    }

    Err("Could not locate Claude Code binary".into())
}

/// Parse a version-like dir name into a sort key so that "2.1.104" sorts after
/// "2.1.92". Each dot-separated segment parses as an integer; un-parseable
/// segments fall back to lexicographic ordering by being pushed with a sentinel
/// so numeric versions still beat non-numeric ones deterministically.
fn version_key(s: &str) -> Vec<(u32, String)> {
    s.split('.')
        .map(|seg| match seg.parse::<u32>() {
            Ok(n) => (n, String::new()),
            Err(_) => (u32::MAX, seg.to_string()),
        })
        .collect()
}

/// Walk a balanced-paren region starting at `start` (which should be the byte
/// position just after the opening `{` or `[`). Returns the byte offset of the
/// matching closer within `content`, or `None` if the region is unterminated
/// within `max` bytes. `open` and `close` must be ASCII and not appear in
/// multi-byte UTF-8 sequences — true for `{}`, `[]`, `()`.
///
/// This is a lightweight JS lexer, not a parser. It ignores delimiters inside
/// strings, template literals, comments, and regex literals so schema walkers
/// don't terminate on quoted text.
fn walk_balanced(
    content: &str,
    start: usize,
    open: char,
    close: char,
    max: usize,
) -> Option<usize> {
    let limit = (start + max).min(content.len());
    content.get(start..limit)?;
    let bytes = content.as_bytes();
    let mut depth: i32 = 1;

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum LexState {
        Code,
        Single,
        Double,
        Template,
        Regex,
        LineComment,
        BlockComment,
    }

    let open = open as u8;
    let close = close as u8;
    let mut state = LexState::Code;
    let mut escaped = false;
    let mut in_regex_class = false;
    let mut prev_sig: Option<u8> = None;
    let mut i = start;

    while i < limit {
        let b = bytes[i];
        match state {
            LexState::Code => {
                if b == b'\'' {
                    state = LexState::Single;
                    escaped = false;
                } else if b == b'"' {
                    state = LexState::Double;
                    escaped = false;
                } else if b == b'`' {
                    state = LexState::Template;
                    escaped = false;
                } else if b == b'/' && i + 1 < limit && bytes[i + 1] == b'/' {
                    state = LexState::LineComment;
                    i += 1;
                } else if b == b'/' && i + 1 < limit && bytes[i + 1] == b'*' {
                    state = LexState::BlockComment;
                    i += 1;
                } else if b == b'/'
                    && prev_sig
                        .map(|p| b"([{=:;,!&|?+-*%^~<>".contains(&p))
                        .unwrap_or(true)
                {
                    state = LexState::Regex;
                    escaped = false;
                    in_regex_class = false;
                } else if b == open {
                    depth += 1;
                } else if b == close {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i);
                    }
                }

                if !b.is_ascii_whitespace() {
                    prev_sig = Some(b);
                }
            }
            LexState::Single => {
                if escaped {
                    escaped = false;
                } else if b == b'\\' {
                    escaped = true;
                } else if b == b'\'' {
                    state = LexState::Code;
                }
            }
            LexState::Double => {
                if escaped {
                    escaped = false;
                } else if b == b'\\' {
                    escaped = true;
                } else if b == b'"' {
                    state = LexState::Code;
                }
            }
            LexState::Template => {
                if escaped {
                    escaped = false;
                } else if b == b'\\' {
                    escaped = true;
                } else if b == b'`' {
                    state = LexState::Code;
                }
            }
            LexState::Regex => {
                if escaped {
                    escaped = false;
                } else if b == b'\\' {
                    escaped = true;
                } else if b == b'[' {
                    in_regex_class = true;
                } else if b == b']' {
                    in_regex_class = false;
                } else if b == b'/' && !in_regex_class {
                    state = LexState::Code;
                }
            }
            LexState::LineComment => {
                if b == b'\n' {
                    state = LexState::Code;
                }
            }
            LexState::BlockComment => {
                if b == b'*' && i + 1 < limit && bytes[i + 1] == b'/' {
                    state = LexState::Code;
                    i += 1;
                }
            }
        }
        i += 1;
    }

    None
}

/// Scan the Claude Code binary for built-in slash commands.
/// Two-step scan: finds name:"..." positions, then searches a brace-depth-bounded
/// window for descriptions (literal, reversed, computed/ternary, template literal).
pub fn discover_builtin_commands_sync(
    cli_path: Option<&str>,
) -> Result<Vec<serde_json::Value>, String> {
    let content = read_claude_binary(cli_path)?.content;

    let mut commands = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for name_match in BUILTIN_NAME_RE.find_iter(&content) {
        let name_cap = BUILTIN_NAME_RE
            .captures(&content[name_match.start()..])
            .unwrap();
        let name = name_cap[1].to_string();
        // Filter MCP prompt template fragments (name:"mcp__"+serverName+"__"+promptName)
        if name.contains("__") {
            continue;
        }
        let cmd = format!("/{}", name);
        // Length gate only; dedup runs *after* the marker check so a non-command
        // `name:"mcp"` hit (the MCP tool) can't poison `seen` and hide the real
        // `/mcp` command that appears later in the bundle.
        if cmd.len() < 4 {
            continue;
        }

        // Look for description in a window around the name match.
        // Forward window: up to 1500 chars after name, bounded by the enclosing object.
        // (Wider than it might seem necessary because skill registrations embed
        //  long `whenToUse:'…'` strings between the name and the marker tokens.)
        // We track brace depth: { increments, } decrements. When depth reaches -1,
        // we've exited the current object. This correctly handles nested braces in
        // getter functions ({...}) and template literal interpolations (${...}).
        let fwd_start = name_match.end();
        let fwd_limit = (fwd_start + 1500).min(content.len());
        let fwd_raw = &content[fwd_start..fwd_limit];
        let mut fwd_end = fwd_raw.len();
        let mut depth: i32 = 0;
        for (i, ch) in fwd_raw.char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth < 0 {
                        fwd_end = i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let fwd_window = &fwd_raw[..fwd_end];

        // Reverse window: up to 500 chars before name
        let rev_start = name_match.start().saturating_sub(500);
        let rev_window = &content[rev_start..name_match.start()];
        // Truncate at last } to stay within the same object
        let rev_window = match rev_window.rfind('}') {
            Some(pos) => &rev_window[pos + 1..],
            None => rev_window,
        };

        // Require a command-like marker in the surrounding window. The marker
        // set covers both traditional commands (`type:"prompt"|"local-jsx"|"local"`)
        // and registered skills (`userInvocable:!0`, `whenToUse:` with either
        // quote style, `getPromptForCommand`, `pluginCommand:"`, `argumentHint:"`).
        // Every real command has at least one; none of these strings appear in
        // highlight-js language defs, crypto/AWS SDK, or DOM globals.
        let markers = [
            r#"type:"prompt""#,
            r#"type:"local-jsx""#,
            r#"type:"local""#,
            "userInvocable:!0",
            r#"whenToUse:""#,
            r#"whenToUse:'"#,
            "getPromptForCommand",
            r#"pluginCommand:""#,
            r#"argumentHint:""#,
            r#"argumentHint:'"#,
        ];
        let has_command_marker = markers
            .iter()
            .any(|m| fwd_window.contains(m) || rev_window.contains(m));
        if !has_command_marker {
            continue;
        }

        // Dedup only after we've confirmed this looks like a command. Earlier
        // dedup would let the first non-command match for a name squat on the
        // entry (e.g. an MCP tool with the same name).
        if !seen.insert(cmd.clone()) {
            continue;
        }

        // Skip hidden commands (debug/internal: heapdump, output-style, rate-limit-options)
        // Only matches literal isHidden:!0, not computed expressions like isHidden:someCondition
        if fwd_window.contains("isHidden:!0") || rev_window.contains("isHidden:!0") {
            continue;
        }

        // Try patterns in priority order — search both forward and reverse windows
        let strip_interpolations = |raw: &str| -> String {
            STRIP_INTERPOLATIONS_RE
                .replace_all(raw, "")
                .trim()
                .to_string()
        };

        let desc = None
            // 1. Literal description in forward window
            .or_else(|| {
                DESC_LITERAL_RE
                    .captures(fwd_window)
                    .map(|c| c[1].to_string())
            })
            // 2. Literal description in reverse window (reversed property order)
            .or_else(|| {
                DESC_LITERAL_RE
                    .captures(rev_window)
                    .map(|c| c[1].to_string())
            })
            // 3. Computed description in forward window
            .or_else(|| {
                DESC_COMPUTED_RE
                    .captures(fwd_window)
                    .map(|c| c[1].to_string())
            })
            // 4. Computed description in reverse window
            .or_else(|| {
                DESC_COMPUTED_RE
                    .captures(rev_window)
                    .map(|c| c[1].to_string())
            })
            // 5. Template literal in forward window
            .or_else(|| {
                DESC_TEMPLATE_RE
                    .captures(fwd_window)
                    .map(|c| strip_interpolations(&c[1]))
            })
            // 6. Template literal in reverse window
            .or_else(|| {
                DESC_TEMPLATE_RE
                    .captures(rev_window)
                    .map(|c| strip_interpolations(&c[1]))
            })
            .unwrap_or_default();

        // Clean up escaped newlines in descriptions
        let desc = desc.replace("\\n", " ");
        commands.push(serde_json::json!({ "cmd": cmd, "desc": desc }));
    }

    // Filter out noise (internal tools, MCP tools, non-slash-commands)
    commands.retain(|c| {
        let cmd = c["cmd"].as_str().unwrap_or("");
        let desc = c["desc"].as_str().unwrap_or("");
        // Skip commands that look like CLI tools or MCP tools (very long descriptions about DOM/browser)
        !cmd.starts_with("/--")
            && cmd != "/release-notes"
            && !desc.contains("tab ID")
            && !desc.contains("DOM")
            && cmd.len() >= 4
            && cmd.len() <= 30
    });

    Ok(commands)
}

/// Scan the Claude Code binary for settings schema definitions.
/// Extracts Zod schema patterns: keyName:<alias>.type().optional().describe("...").
/// Returns discovered settings with key, type, description, choices.
///
/// Alias detection: the minified Zod import is named `u` in current builds but
/// may change. We scan for likely aliases (`import*as X from"zod"` or short-var
/// require patterns) and build the key regex dynamically. Falls back to any
/// single lowercase letter prefix when detection turns up nothing.
pub fn discover_settings_schema_sync(
    cli_path: Option<&str>,
) -> Result<Vec<serde_json::Value>, String> {
    let content = read_claude_binary(cli_path)?.content;

    let aliases = detect_zod_aliases(&content);
    let alias_pattern = if aliases.is_empty() {
        // Fallback: any single lowercase letter as the alias
        "[a-z]".to_string()
    } else {
        // Build alternation like (?:u|z|zod)
        let escaped: Vec<String> = aliases.iter().map(|a| regex::escape(a)).collect();
        format!("(?:{})", escaped.join("|"))
    };

    let mut fields = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // Pattern: keyName:<alias>.type(args).optional().catch(...).describe("description")
    // Allow an optional whitespace before the dot (some minifiers emit ". ").
    let key_pattern = format!(
        r#"([a-zA-Z][a-zA-Z0-9]{{1,40}}):{}\.(enum|string|boolean|number|array|record|object|lazy|union|literal)\("#,
        alias_pattern
    );
    let key_re = Regex::new(&key_pattern).map_err(|e| format!("regex error: {}", e))?;

    for cap in key_re.captures_iter(&content) {
        let key = cap[1].to_string();
        let base_type = cap[2].to_string();

        // Skip internal/noise keys (too short, all-caps constants, common JS identifiers).
        // 2-char minimum admits `pr` (attribution.pr is a real setting) while the noise
        // allowlist below rejects the common 2-char minifier outputs.
        if key.len() < 2 || key.chars().all(|c| c.is_uppercase()) {
            continue;
        }
        if is_settings_key_noise(&key) {
            continue;
        }

        if !seen.insert(key.clone()) {
            continue;
        }

        // Wider lookahead (400 -> 1200 chars) so `.optional().catch(...).refine(...)`
        // chains don't push `.describe()` out of range.
        let match_end = cap.get(0).unwrap().end();
        let lookahead = &content[match_end..std::cmp::min(match_end + 1200, content.len())];

        // Extract description — try double, single, then template-literal form.
        let description = SETTINGS_DESC_DOUBLE_RE
            .captures(lookahead)
            .map(|c| c[1].to_string())
            .or_else(|| {
                SETTINGS_DESC_SINGLE_RE
                    .captures(lookahead)
                    .map(|c| c[1].to_string())
            })
            .or_else(|| {
                SETTINGS_DESC_TEMPLATE_RE
                    .captures(lookahead)
                    .map(|c| STRIP_INTERPOLATIONS_RE.replace_all(&c[1], "").to_string())
            })
            .map(|d| d.replace("\\n", " "));

        // Only keep entries that have a description (filters out non-settings Zod schemas)
        let desc = match description {
            Some(d) => d,
            None => continue,
        };

        // Extract enum choices from <alias>.enum(["a","b","c"])
        let choices: Option<Vec<String>> = if base_type == "enum" {
            ENUM_CHOICES_RE.captures(lookahead).map(|c| {
                c[1].split(',')
                    .filter_map(|s| {
                        let trimmed = s.trim().trim_matches('"').trim_matches('\'');
                        if !trimmed.is_empty() {
                            Some(trimmed.to_string())
                        } else {
                            None
                        }
                    })
                    .collect()
            })
        } else {
            None
        };

        // Check for .optional()
        let optional = lookahead.contains(".optional()");

        // Map Zod type to our field type
        let field_type = match base_type.as_str() {
            "boolean" => "boolean",
            "number" => "number",
            "enum" => "enum",
            "array" => "stringArray",
            "record" => "stringMap",
            "object" | "lazy" | "union" => "object",
            _ => "string",
        };

        let mut entry = json!({
            "key": key,
            "type": field_type,
            "description": desc,
            "optional": optional,
        });
        if let Some(c) = choices {
            entry["choices"] = json!(c);
        }
        fields.push(entry);
    }

    // Three supplementary passes catch settings the Zod+describe pattern misses.
    // Each returns a Vec<(key, source-tag)> so we dedup against the main scan
    // without double-counting keys the Zod pass already found.
    let mut seen_keys: std::collections::HashSet<String> = fields
        .iter()
        .filter_map(|e| e["key"].as_str().map(|s| s.to_string()))
        .collect();

    let mut push_extra =
        |key: String, source: &'static str, fields: &mut Vec<serde_json::Value>| {
            if seen_keys.insert(key.clone()) {
                fields.push(json!({
                    "key": key,
                    "type": "string",
                    "description": "",
                    "optional": true,
                    "source": source,
                }));
            }
        };

    // Pass A: settings metadata objects like `showTurnDuration:{source:"global",type:"boolean",description:'…'}`
    for key in scan_settings_metadata(&content) {
        push_extra(key, "metadata", &mut fields);
    }

    // Pass B: schema-factory settings like `permissions:$Kq(H).optional().describe(...)`
    for key in scan_settings_factory_keys(&content) {
        push_extra(key, "schema_factory", &mut fields);
    }

    // Pass C: GlobalConfig key array anchored on "apiKeyHelper"
    for key in scan_global_config_keys(&content) {
        push_extra(key, "global_config_array", &mut fields);
    }

    // Pass D: dotted forms for nested namespaces (filesystem.allowRead, etc.)
    for key in scan_nested_namespaces(&content, &alias_pattern) {
        push_extra(key, "nested", &mut fields);
    }

    // Sort alphabetically for consistency
    fields.sort_by(|a, b| {
        a["key"]
            .as_str()
            .unwrap_or("")
            .cmp(b["key"].as_str().unwrap_or(""))
    });

    Ok(fields)
}

/// Find settings-metadata object entries.
///
/// Minified binary shape:
///     showTurnDuration:{source:"global",type:"boolean",description:'…'}
///
/// The `source:"(global|project|local|user|managed|policy|dynamic)"` literal is
/// unique to this metadata structure — no false positives from C++ or crypto
/// libraries. We keep an explicit blocklist for the handful of object-property
/// names that happen to neighbor a `source:` string for unrelated reasons.
fn scan_settings_metadata(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for cap in SETTINGS_METADATA_RE.captures_iter(content) {
        let key = cap[1].to_string();
        if is_settings_key_noise(&key) {
            continue;
        }
        if seen.insert(key.clone()) {
            out.push(key);
        }
    }
    out
}

/// Find settings whose schema is produced by a helper/factory call rather than
/// by a direct Zod alias method. Example:
///     permissions:$Kq(H).optional().describe("Tool usage permissions")
fn scan_settings_factory_keys(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for cap in SETTINGS_FACTORY_KEY_RE.captures_iter(content) {
        let key = cap[1].to_string();
        if is_settings_key_noise(&key) {
            continue;
        }
        let desc_start = cap.get(0).map(|m| m.end()).unwrap_or(0);
        let desc_window = &content[desc_start..std::cmp::min(desc_start + 180, content.len())];
        if !desc_window.to_ascii_lowercase().contains("configuration") {
            continue;
        }
        if seen.insert(key.clone()) {
            out.push(key);
        }
    }
    out
}

/// Find the GlobalConfig key string array.
///
/// The bundle ships an array like
///     Tcq=["apiKeyHelper","installMethod","theme",…,"autoConnectIde",…];
/// containing every top-level config key that `settings.json` / `~/.claude.json`
/// can hold. We anchor on the canonical entry `"apiKeyHelper"` and walk outward
/// to the enclosing `[`…`]` pair, then pull every string literal.
fn scan_global_config_keys(content: &str) -> Vec<String> {
    let anchor = "\"apiKeyHelper\"";
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut search_from = 0;
    while let Some(rel) = content[search_from..].find(anchor) {
        let hit = search_from + rel;
        search_from = hit + anchor.len();

        // Walk left for the enclosing `[`. Stop at `;` or `{` (object literal) — we
        // only want array context, not `{apiKeyHelper:…}` property lists.
        let rev_start = hit.saturating_sub(200);
        let before = &content[rev_start..hit];
        let bracket_rel = match before.rfind('[') {
            Some(p) => p,
            None => continue,
        };
        // Reject when a `{` or `;` sits between the `[` and our anchor (signals
        // we're inside an object, not inside a pure string array).
        let between = &before[bracket_rel + 1..];
        if between.contains('{') || between.contains(';') {
            continue;
        }
        let bracket_abs = rev_start + bracket_rel;
        let end = match walk_balanced(content, bracket_abs + 1, '[', ']', 8192) {
            Some(e) => e,
            None => continue,
        };
        let body = &content[bracket_abs + 1..end];
        // Pure-identifier literal: "[a-z][a-zA-Z0-9]{1,40}" (no dots, no slashes,
        // no spaces). Excludes URLs, paths, descriptions.
        for cap in GLOBAL_CONFIG_LITERAL_RE.captures_iter(body) {
            let key = cap[1].to_string();
            if is_settings_key_noise(&key) {
                continue;
            }
            if seen.insert(key.clone()) {
                out.push(key);
            }
        }
    }
    out
}

/// Find dotted forms for nested-object settings.
///
/// For each parent namespace, detect either:
///     namespace:<alias>.object({ innerKey:<alias>.type(…), … })
/// or the function-returning variant:
///     namespace:abc()  // where `function abc(){ return <alias>.object({ innerKey:… }) }`
///
/// Extract each inner key and emit `namespace.innerKey`. Only emit the dotted
/// form — the flat inner key is already caught by the top-level Zod scan, and
/// doubling it up would inflate the "extras" diff with redundant entries.
fn scan_nested_namespaces(content: &str, alias_pattern: &str) -> Vec<String> {
    // Reuse the same inner-key pattern the top-level Zod scan uses so we pick
    // up exactly the same key shapes.
    let inner_key_re = Regex::new(&format!(
        r#"([a-zA-Z][a-zA-Z0-9]{{1,40}}):{}\.(enum|string|boolean|number|array|record|object|lazy|union|literal)\("#,
        alias_pattern
    ))
    .unwrap();

    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // Variant 1: namespace:<alias>.object({ … })
    let direct_re = Regex::new(&format!(
        r#"[,{{]([a-zA-Z][a-zA-Z0-9]{{2,30}}):{}\.object\(\{{"#,
        alias_pattern
    ))
    .unwrap();
    for cap in direct_re.captures_iter(content) {
        let ns = &cap[1];
        if is_settings_key_noise(ns) {
            continue;
        }
        let m = cap.get(0).unwrap();
        let brace_pos = match content[m.start()..m.end()].rfind('{') {
            Some(p) => m.start() + p,
            None => continue,
        };
        let end = match walk_balanced(content, brace_pos + 1, '{', '}', 16_384) {
            Some(e) => e,
            None => continue,
        };
        let body = &content[brace_pos + 1..end];
        if extract_inner_dotted(&inner_key_re, ns, body, &mut seen, &mut out) {
            emit_namespace(ns, &mut seen, &mut out);
        }
    }

    // Variant 2: namespace:shortFnName() — lazy schema factories like
    //   `,network:_S7(),filesystem:fS7(),permissions:HR7()`
    let fn_re = Regex::new(r#"[,{]([a-zA-Z][a-zA-Z0-9]{2,30}):([a-zA-Z_$][a-zA-Z0-9_$]{0,6})\(\)"#)
        .unwrap();
    let mut resolved_pairs: HashSet<(String, String)> = HashSet::new();
    for cap in fn_re.captures_iter(content) {
        let ns = cap[1].to_string();
        if is_settings_key_noise(&ns) {
            continue;
        }
        let fn_name = cap[2].to_string();
        if !resolved_pairs.insert((ns.clone(), fn_name.clone())) {
            continue;
        }
        if let Some(body) = resolve_lazy_schema_body(content, &fn_name, alias_pattern) {
            if extract_inner_dotted(&inner_key_re, &ns, body, &mut seen, &mut out) {
                emit_namespace(&ns, &mut seen, &mut out);
            }
        }
    }

    out
}

fn emit_namespace(
    namespace: &str,
    seen: &mut std::collections::HashSet<String>,
    out: &mut Vec<String>,
) {
    if seen.insert(namespace.to_string()) {
        out.push(namespace.to_string());
    }
}

fn extract_inner_dotted(
    inner_key_re: &Regex,
    namespace: &str,
    body: &str,
    seen: &mut std::collections::HashSet<String>,
    out: &mut Vec<String>,
) -> bool {
    let mut added = false;
    for cap in inner_key_re.captures_iter(body) {
        let inner = &cap[1];
        if is_settings_key_noise(inner) {
            continue;
        }
        let dotted = format!("{}.{}", namespace, inner);
        if seen.insert(dotted.clone()) {
            out.push(dotted);
            added = true;
        }
    }
    added
}

/// Resolve a lazy schema factory like `fS7=mH(()=>N.object({…}))` and return
/// the body of its `.object({…})` argument, if any.
///
/// The bundle emits several equivalent forms:
///     fS7=mH(()=>N.object({…}))    // memoized lazy
///     fS7=()=>N.object({…})        // arrow function
///     function fS7(){return N.object({…})}
///     fS7=function(){return N.object({…})}
/// We search for `<fn>=` (unambiguous: assignments, not references) and scan
/// a bounded window forward for the next `.object({`. The balanced-brace walk
/// handles every form uniformly.
fn resolve_lazy_schema_body<'a>(
    content: &'a str,
    fn_name: &str,
    alias_pattern: &str,
) -> Option<&'a str> {
    // Try the `=` assignment first, then the `function NAME()` declaration.
    let assignment = format!("{}=", fn_name);
    let declaration = format!("function {}(", fn_name);
    let starts: Vec<usize> = [&assignment, &declaration]
        .iter()
        .filter_map(|needle| content.find(needle.as_str()).map(|p| p + needle.len()))
        .collect();

    let obj_re = regex::Regex::new(&format!(r#"{}\.object\(\{{"#, alias_pattern)).unwrap();

    for start in starts {
        let window_end = (start + 400).min(content.len());
        let window = content.get(start..window_end)?;
        if let Some(m) = obj_re.find(window) {
            let brace_pos = start + m.end() - 1; // points at `{`
            let body_end = walk_balanced(content, brace_pos + 1, '{', '}', 16_384)?;
            return Some(&content[brace_pos + 1..body_end]);
        }
    }
    None
}

/// Central noise filter for settings-key candidates. Centralized so the three
/// settings passes agree on what counts as noise.
fn is_settings_key_noise(key: &str) -> bool {
    matches!(
        key,
        "type"
            | "name"
            | "value"
            | "message"
            | "data"
            | "error"
            | "status"
            | "content"
            | "role"
            | "input"
            | "output"
            | "result"
            | "text"
            | "key"
            | "description"
            | "title"
            | "path"
            | "args"
            | "options"
            | "config"
            | "params"
            | "command"
            | "event"
            | "action"
            | "state"
            | "context"
            | "source"
            | "target"
            | "children"
            | "parent"
            | "index"
            | "length"
    )
}

/// Detect the minified variable alias(es) used for the Zod import in the bundle.
/// Looks for patterns like:
///   - import*as X from"zod"
///   - var X=require("zod")
///   - ,X=e("zod")
///   - let X=Object.assign(...zod...)
/// Returns short variable names (1-3 chars, typical for minifiers).
fn detect_zod_aliases(content: &str) -> Vec<String> {
    let mut aliases = std::collections::BTreeSet::new();

    // ES-module `import * as X from "zod"`
    for cap in ZOD_ESM_RE.captures_iter(content) {
        aliases.insert(cap[1].to_string());
    }

    // CommonJS `X=require("zod")` or `var X=require("zod")`
    for cap in ZOD_CJS_RE.captures_iter(content) {
        aliases.insert(cap[1].to_string());
    }

    // esbuild-style `,X=e("zod")` / `,X=r("zod")` — the loader variable varies
    for cap in ZOD_ESBUILD_RE.captures_iter(content) {
        aliases.insert(cap[1].to_string());
    }

    // Inline-bundled zod: when no import/require form is present (newer builds
    // inline the zod source), fall back to a frequency heuristic. The real zod
    // alias is the short identifier that appears before `.object(`,
    // `.string()`, `.boolean()` etc. hundreds of times — far more often than
    // any unrelated variable.
    if aliases.is_empty() {
        let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for cap in ZOD_SIGNAL_RE.captures_iter(content) {
            *counts.entry(cap[1].to_string()).or_insert(0) += 1;
        }
        // 50-hit threshold: real zod aliases in the bundle fire 500-5000 times;
        // no unrelated identifier clears this bar in practice.
        if let Some((ident, _)) = counts.iter().max_by_key(|(_, &n)| n) {
            if counts[ident] >= 50 {
                aliases.insert(ident.clone());
            }
        }
    }

    aliases.into_iter().collect()
}

/// Curated catalog of environment variables Claude Code reads.
/// Merged with any additional `process.env.X` names found in the binary.
pub fn env_var_catalog() -> Vec<DiscoveredEnvVar> {
    vec![
        DiscoveredEnvVar {
            name: "ANTHROPIC_API_KEY".into(),
            description: "Anthropic API key for authentication".into(),
            category: "api".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "ANTHROPIC_BASE_URL".into(),
            description: "Custom API base URL (for proxies or alternative endpoints)".into(),
            category: "api".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "ANTHROPIC_AUTH_TOKEN".into(),
            description: "Bearer token (alternative to API key)".into(),
            category: "api".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "CLAUDE_CODE_API_KEY_HELPER_TTY".into(),
            description: "Program path that outputs an API key to stdout".into(),
            category: "api".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "ANTHROPIC_MODEL".into(),
            description: "Default model override".into(),
            category: "model".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "ANTHROPIC_SMALL_FAST_MODEL".into(),
            description: "Small/fast model for lightweight tasks".into(),
            category: "model".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "CLAUDE_CODE_MAX_OUTPUT_TOKENS".into(),
            description: "Maximum output tokens per response".into(),
            category: "model".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "CLAUDE_CODE_DISABLE_TELEMETRY".into(),
            description: "Disable usage telemetry (set to \"1\")".into(),
            category: "features".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "CLAUDE_CODE_GIT_BASH_PATH".into(),
            description: "Path to Git Bash executable (Windows)".into(),
            category: "features".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "CLAUDE_CODE_ENABLE_UNIFIED_READ_WRITE".into(),
            description: "Enable unified read+write tool".into(),
            category: "features".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "BASH_DEFAULT_TIMEOUT_MS".into(),
            description: "Default bash command timeout in milliseconds".into(),
            category: "features".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "BASH_MAX_TIMEOUT_MS".into(),
            description: "Maximum allowed bash timeout in milliseconds".into(),
            category: "features".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "DISABLE_AUTOUPDATER".into(),
            description: "Disable automatic updates (set to \"1\")".into(),
            category: "features".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "CLAUDE_CODE_USE_BEDROCK".into(),
            description: "Use AWS Bedrock instead of direct API (set to \"1\")".into(),
            category: "aws".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "CLAUDE_CODE_BEDROCK_REGION".into(),
            description: "AWS region for Bedrock".into(),
            category: "aws".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "AWS_PROFILE".into(),
            description: "AWS credential profile for Bedrock authentication".into(),
            category: "aws".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "AWS_REGION".into(),
            description: "AWS region (fallback for Bedrock region)".into(),
            category: "aws".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "CLAUDE_CODE_USE_VERTEX".into(),
            description: "Use Google Vertex AI instead of direct API (set to \"1\")".into(),
            category: "gcp".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "ANTHROPIC_VERTEX_PROJECT_ID".into(),
            description: "Google Cloud project ID for Vertex AI".into(),
            category: "gcp".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "ANTHROPIC_VERTEX_REGION".into(),
            description: "Google Cloud region for Vertex AI".into(),
            category: "gcp".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "HTTP_PROXY".into(),
            description: "HTTP proxy server URL".into(),
            category: "network".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "HTTPS_PROXY".into(),
            description: "HTTPS proxy server URL".into(),
            category: "network".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "NO_PROXY".into(),
            description: "Comma-separated hosts to bypass proxy".into(),
            category: "network".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "NODE_TLS_REJECT_UNAUTHORIZED".into(),
            description: "TLS cert validation — set \"0\" to disable (insecure)".into(),
            category: "network".into(),
            documented: true,
        },
        DiscoveredEnvVar {
            name: "CLAUDE_CODE_SKIP_BINARY_CHECK".into(),
            description: "Skip binary integrity check on startup".into(),
            category: "debug".into(),
            documented: true,
        },
    ]
}

/// Mine the Claude CLI binary for environment variable names.
///
/// Four passes cover the shapes the bundle actually emits:
///   1. `process.env.NAME` — dot access
///   2. `process.env['NAME']` / `process.env["NAME"]` — bracket access
///   3. Bare `"NAME"` string literals with a known env-var prefix that live
///      near a `process.env` site (within 64 KB). Catches values used via
///      indirect lookup, e.g. the `VERTEX_REGION_*` or `OTEL_METRICS_INCLUDE_*`
///      tables.
///   4. `"NAME=…"` child-env assignments — catches `CLAUDECODE=1` style.
///
/// The hardcoded catalog is merged in last so every bundle-mined name starts
/// with `documented: false` and can be overridden if the catalog promotes it.
pub fn discover_env_vars_sync(cli_path: Option<&str>) -> Result<Vec<DiscoveredEnvVar>, String> {
    let catalog = env_var_catalog();
    let catalog_names: std::collections::HashSet<String> =
        catalog.iter().map(|e| e.name.clone()).collect();

    let mut result: Vec<DiscoveredEnvVar> = catalog;

    let content = read_claude_binary(cli_path)?;

    {
        let mut seen: std::collections::HashSet<String> = catalog_names;
        let push = |name: String,
                    result: &mut Vec<DiscoveredEnvVar>,
                    seen: &mut std::collections::HashSet<String>| {
            if seen.insert(name.clone()) {
                result.push(DiscoveredEnvVar {
                    name,
                    description: String::new(),
                    category: "other".into(),
                    documented: false,
                });
            }
        };

        // Pass 1: process.env.NAME (dot access)
        for cap in ENV_DOT_RE.captures_iter(&content.content) {
            push(cap[1].to_string(), &mut result, &mut seen);
        }

        // Pass 2: process.env['NAME'] / ["NAME"] (bracket + literal)
        for cap in ENV_BRACKET_RE.captures_iter(&content.content) {
            push(cap[1].to_string(), &mut result, &mut seen);
        }

        // Pass 3: proximity-gated bare string literals. Precompute all
        // `process.env` offsets once, then for each candidate literal check
        // whether it sits within 64 KB of any such offset. The distance gate
        // keeps us out of string tables for unrelated modules (error codes,
        // SQL keywords, telemetry tags) which cluster elsewhere in the bundle.
        let env_anchors: Vec<usize> = content
            .content
            .match_indices("process.env")
            .map(|(i, _)| i)
            .collect();

        // Prefix allowlist: names used as env vars by Claude Code specifically.
        // `CLAUDECODE` exact is a bare flag we'd otherwise need special-casing;
        // treat it as its own prefix.
        const ENV_PREFIXES: &[&str] = &[
            "ANTHROPIC_",
            "CLAUDE_",
            "CLAUDECODE",
            "OTEL_",
            "VERTEX_",
            "GOOGLE_",
            "AWS_",
            "BEDROCK_",
            "GCP_",
            "AZURE_",
        ];

        let near_env = |offset: usize| -> bool {
            // Binary search for the nearest process.env anchor; accept if
            // either neighbour is within 64 KB.
            const RADIUS: usize = 64 * 1024;
            match env_anchors.binary_search(&offset) {
                Ok(_) => true,
                Err(idx) => {
                    let before = idx.checked_sub(1).and_then(|i| env_anchors.get(i)).copied();
                    let after = env_anchors.get(idx).copied();
                    [before, after].iter().flatten().any(|a| {
                        let d = if *a > offset {
                            *a - offset
                        } else {
                            offset - *a
                        };
                        d <= RADIUS
                    })
                }
            }
        };

        for cap in ENV_LITERAL_RE.captures_iter(&content.content) {
            let name = &cap[1];
            let has_prefix = ENV_PREFIXES.iter().any(|p| name.starts_with(p));
            let has_underscore = name.contains('_') || name == "CLAUDECODE";
            if !has_prefix || !has_underscore {
                continue;
            }
            let offset = cap.get(0).unwrap().start();
            if !near_env(offset) {
                continue;
            }
            push(name.to_string(), &mut result, &mut seen);
        }

        // Pass 4: NAME=value assignments inside quoted strings like
        //   "CLAUDECODE=1"
        // Common for env vars that parent process passes to children.
        for cap in ENV_ASSIGN_RE.captures_iter(&content.content) {
            let name = &cap[1];
            if ENV_PREFIXES.iter().any(|p| name.starts_with(p)) {
                push(name.to_string(), &mut result, &mut seen);
            }
        }

        // Pass 5: word-bounded UPPERCASE identifiers anywhere near a
        // `process.env` anchor. Catches env vars mentioned only in user-facing
        // error messages (e.g. `"…or set CLAUDE_CODE_TEAM_NAME."`) that the
        // quoted-literal passes miss because the name sits mid-string. The
        // proximity gate and prefix allowlist together keep this tight.
        for cap in ENV_WORD_RE.captures_iter(&content.content) {
            let name = &cap[1];
            let has_prefix = ENV_PREFIXES.iter().any(|p| name.starts_with(p));
            let has_underscore = name.contains('_');
            if !has_prefix || !has_underscore {
                continue;
            }
            let offset = cap.get(0).unwrap().start();
            if !near_env(offset) {
                continue;
            }
            push(name.to_string(), &mut result, &mut seen);
        }
    }

    // Sort: documented first, then by category, then by name
    result.sort_by(|a, b| {
        b.documented
            .cmp(&a.documented)
            .then(a.category.cmp(&b.category))
            .then(a.name.cmp(&b.name))
    });

    Ok(result)
}

/// Scan global and project command/skill directories. Returns the command list
/// plus any rejection reasons (for observability).
///
/// Behavior for SKILL.md:
///   - Command identifier = frontmatter `name:` if present, else parent directory name
///     (matches Claude Code's own skill loader at
///     `claude_code/src/skills/loadSkillsDir.ts`).
///   - Description = frontmatter `description:` if present, else first non-empty
///     markdown line after the frontmatter (again, matching Claude Code).
///   - A SKILL.md is only rejected when both identifier sources fail (file has
///     no frontmatter and the parent dir name is empty or not a valid slug).
pub fn discover_plugin_commands_sync(
    extra_dirs: &[String],
) -> Result<(Vec<serde_json::Value>, Vec<PluginScanRejection>), String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    discover_plugin_commands_sync_with_home(extra_dirs, &home)
}

/// Test-friendly variant that takes the home directory explicitly so unit
/// tests don't pick up the developer's real `~/.claude/skills/`.
pub(crate) fn discover_plugin_commands_sync_with_home(
    extra_dirs: &[String],
    home: &std::path::Path,
) -> Result<(Vec<serde_json::Value>, Vec<PluginScanRejection>), String> {
    let mut commands = Vec::new();
    let mut rejections = Vec::new();

    fn scan_dir(
        dir: &std::path::Path,
        commands: &mut Vec<serde_json::Value>,
        rejections: &mut Vec<PluginScanRejection>,
        visited: &mut HashSet<PathBuf>,
        depth: usize,
    ) {
        if depth > MAX_PLUGIN_SCAN_DEPTH {
            return;
        }
        let visited_key = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        if !visited.insert(visited_key) {
            return;
        }

        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    scan_dir(&path, commands, rejections, visited, depth + 1);
                } else if path.file_name().and_then(|n| n.to_str()) == Some("SKILL.md") {
                    scan_skill_md(&path, commands, rejections);
                } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
                    if let Some(parent) = path.parent() {
                        if parent.file_name().and_then(|n| n.to_str()) == Some("commands") {
                            let name = path
                                .file_stem()
                                .and_then(|s| s.to_str())
                                .unwrap_or("")
                                .to_string();
                            if !name.is_empty() {
                                let desc = std::fs::read_to_string(&path)
                                    .ok()
                                    .and_then(|c| {
                                        c.lines().next().map(|l| {
                                            l.trim().trim_start_matches('#').trim().to_string()
                                        })
                                    })
                                    .unwrap_or_default();
                                commands.push(json!({
                                    "cmd": format!("/{}", name),
                                    "desc": desc
                                }));
                            }
                        }
                    }
                }
            }
        }
    }

    let mut visited = HashSet::new();

    // 1. Global plugins
    let plugins_dir = home.join(".claude").join("plugins");
    if plugins_dir.exists() {
        scan_dir(
            &plugins_dir,
            &mut commands,
            &mut rejections,
            &mut visited,
            0,
        );
    }

    // 2. User-level custom commands (~/.claude/commands/)
    let user_cmds = home.join(".claude").join("commands");
    if user_cmds.exists() {
        scan_dir(&user_cmds, &mut commands, &mut rejections, &mut visited, 0);
    }

    // 3. User-level skills (~/.claude/skills/)
    let user_skills = home.join(".claude").join("skills");
    if user_skills.exists() {
        scan_dir(
            &user_skills,
            &mut commands,
            &mut rejections,
            &mut visited,
            0,
        );
    }

    // 4. Project-level custom commands and skills for each provided directory
    for dir in extra_dirs {
        let project_cmds = std::path::Path::new(dir).join(".claude").join("commands");
        if project_cmds.exists() {
            scan_dir(
                &project_cmds,
                &mut commands,
                &mut rejections,
                &mut visited,
                0,
            );
        }
        let project_skills = std::path::Path::new(dir).join(".claude").join("skills");
        if project_skills.exists() {
            scan_dir(
                &project_skills,
                &mut commands,
                &mut rejections,
                &mut visited,
                0,
            );
        }
    }

    // Dedup by command name (first win — matches original behavior).
    let mut seen = std::collections::HashSet::new();
    commands.retain(|c| {
        let name = c["cmd"].as_str().unwrap_or("").to_string();
        seen.insert(name)
    });

    Ok((commands, rejections))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- scan_skill_md via discover_plugin_commands_sync ----

    fn write_skill(dir: &std::path::Path, name: &str, content: &str) -> std::path::PathBuf {
        let skill_dir = dir.join(name);
        std::fs::create_dir_all(&skill_dir).unwrap();
        let path = skill_dir.join("SKILL.md");
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn skill_with_name_and_description_in_frontmatter() {
        let tmp = tempfile::tempdir().unwrap();
        let skills_dir = tmp.path().join(".claude").join("skills");
        std::fs::create_dir_all(&skills_dir).unwrap();
        write_skill(
            &skills_dir,
            "dirname",
            "---\nname: custom-name\ndescription: Does things\n---\nbody\n",
        );

        let (cmds, rejections) = discover_plugin_commands_sync_with_home(&[], tmp.path()).unwrap();
        assert!(
            rejections.is_empty(),
            "no rejections expected, got {:?}",
            rejections
        );
        // Frontmatter name wins over directory name.
        assert!(
            cmds.iter().any(|c| c["cmd"] == "/custom-name"),
            "/custom-name expected in {:?}",
            cmds
        );
    }

    #[test]
    fn skill_with_only_description_uses_dir_name() {
        // This is the bug case: user's ~/.claude/skills/{r,b,c,j,rj}/SKILL.md
        let tmp = tempfile::tempdir().unwrap();
        let skills_dir = tmp.path().join(".claude").join("skills");
        std::fs::create_dir_all(&skills_dir).unwrap();
        write_skill(
            &skills_dir,
            "r",
            "---\ndescription: \"Document the change, review it\"\n---\nbody\n",
        );

        let (cmds, rejections) = discover_plugin_commands_sync_with_home(&[], tmp.path()).unwrap();
        assert!(rejections.is_empty(), "rejections: {:?}", rejections);
        let r = cmds.iter().find(|c| c["cmd"] == "/r");
        assert!(r.is_some(), "/r expected in {:?}", cmds);
        // Description carried through (quotes stripped).
        assert_eq!(r.unwrap()["desc"], "Document the change, review it");
    }

    #[test]
    fn skill_with_no_frontmatter_uses_dir_name_and_body_line() {
        let tmp = tempfile::tempdir().unwrap();
        let skills_dir = tmp.path().join(".claude").join("skills");
        std::fs::create_dir_all(&skills_dir).unwrap();
        write_skill(
            &skills_dir,
            "plain",
            "# Plain skill\n\nDoes stuff without frontmatter.\n",
        );

        let (cmds, rejections) = discover_plugin_commands_sync_with_home(&[], tmp.path()).unwrap();
        assert!(rejections.is_empty(), "rejections: {:?}", rejections);
        let plain = cmds.iter().find(|c| c["cmd"] == "/plain");
        assert!(plain.is_some(), "/plain expected in {:?}", cmds);
        // First non-empty body line (with leading # stripped).
        assert_eq!(plain.unwrap()["desc"], "Plain skill");
    }

    #[test]
    fn skill_md_with_invalid_parent_rejected() {
        // A SKILL.md placed in a dir whose name is not a valid slug should be rejected
        // when there's no frontmatter name either.
        let tmp = tempfile::tempdir().unwrap();
        let skills_dir = tmp.path().join(".claude").join("skills");
        let bad = skills_dir.join("1bad name");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(bad.join("SKILL.md"), "no frontmatter\n").unwrap();

        let (_cmds, rejections) = discover_plugin_commands_sync_with_home(&[], tmp.path()).unwrap();
        assert!(
            rejections.iter().any(|r| r.path.contains("SKILL.md")),
            "expected rejection, got {:?}",
            rejections
        );
    }

    #[test]
    fn commands_md_uses_filename() {
        let tmp = tempfile::tempdir().unwrap();
        let cmds_dir = tmp.path().join(".claude").join("commands");
        std::fs::create_dir_all(&cmds_dir).unwrap();
        std::fs::write(cmds_dir.join("hello.md"), "# Hello command\nbody\n").unwrap();

        let (cmds, _) = discover_plugin_commands_sync_with_home(&[], tmp.path()).unwrap();
        assert!(cmds.iter().any(|c| c["cmd"] == "/hello"));
    }

    #[test]
    fn dedup_first_occurrence_wins() {
        let tmp1 = tempfile::tempdir().unwrap();
        let tmp2 = tempfile::tempdir().unwrap();
        for (i, tmp) in [&tmp1, &tmp2].iter().enumerate() {
            let skills_dir = tmp.path().join(".claude").join("skills");
            std::fs::create_dir_all(&skills_dir).unwrap();
            write_skill(
                &skills_dir,
                "same",
                &format!("---\ndescription: \"from {}\"\n---\n", i),
            );
        }

        let (cmds, _) = discover_plugin_commands_sync_with_home(
            &[tmp2.path().to_string_lossy().into_owned()],
            tmp1.path(),
        )
        .unwrap();
        let same: Vec<_> = cmds.iter().filter(|c| c["cmd"] == "/same").collect();
        assert_eq!(same.len(), 1, "expected dedup, got {:?}", same);
        assert_eq!(same[0]["desc"], "from 0");
    }

    #[test]
    fn plugin_scan_respects_depth_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let mut deep = tmp.path().join(".claude").join("skills");
        for part in ["a", "b", "c", "d", "e", "f", "g", "h", "i"] {
            deep = deep.join(part);
        }
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(
            deep.join("SKILL.md"),
            "---\nname: too-deep\ndescription: Too deep\n---\n",
        )
        .unwrap();

        let (cmds, rejections) = discover_plugin_commands_sync_with_home(&[], tmp.path()).unwrap();
        assert!(rejections.is_empty(), "rejections: {:?}", rejections);
        assert!(
            !cmds.iter().any(|c| c["cmd"] == "/too-deep"),
            "depth-limited scan should not include deeply nested skills: {:?}",
            cmds
        );
    }

    // ---- detect_zod_aliases + discover_settings_schema_sync ----

    #[test]
    fn alias_detect_esm() {
        let content = r#"import*as u from"zod";var settings={"#;
        let aliases = detect_zod_aliases(content);
        assert!(aliases.contains(&"u".to_string()), "got {:?}", aliases);
    }

    #[test]
    fn alias_detect_cjs() {
        let content = r#"var z=require("zod");"#;
        let aliases = detect_zod_aliases(content);
        assert!(aliases.contains(&"z".to_string()), "got {:?}", aliases);
    }

    #[test]
    fn settings_regex_catches_show_thinking_summaries_shape() {
        // Synthetic minified-style blob.
        // The test helper adds a Claude-specific anchor so `read_claude_binary`
        // returns our file instead of falling through to a system binary.
        let content = concat!(
            r#"name:"",description:"" "#,
            r#"import*as u from"zod";"#,
            r#"var s=u.object({"#,
            r#"showThinkingSummaries:u.boolean().optional().describe("Show thinking summaries"),"#,
            r#"alwaysThinkingEnabled:u.boolean().optional().catch(false).describe("Always enabled"),"#,
            r#"outputStyle:u.enum(["auto","verbose","concise"]).optional().describe("Output style choice"),"#,
            r#"}).passthrough();"#,
        );
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("cli.js");
        write_claude_fixture(&p, content);

        let fields = discover_settings_schema_sync(Some(p.to_str().unwrap())).unwrap();
        let keys: Vec<&str> = fields
            .iter()
            .map(|f| f["key"].as_str().unwrap_or(""))
            .collect();
        assert!(keys.contains(&"showThinkingSummaries"), "got {:?}", keys);
        assert!(keys.contains(&"alwaysThinkingEnabled"), "got {:?}", keys);
        assert!(keys.contains(&"outputStyle"), "got {:?}", keys);

        let output_style = fields
            .iter()
            .find(|f| f["key"] == "outputStyle")
            .expect("outputStyle entry");
        assert_eq!(output_style["type"], "enum");
        let choices = output_style["choices"]
            .as_array()
            .expect("choices array")
            .iter()
            .map(|c| c.as_str().unwrap_or(""))
            .collect::<Vec<_>>();
        assert_eq!(choices, vec!["auto", "verbose", "concise"]);
    }

    #[test]
    fn settings_regex_catches_different_alias() {
        // When the minifier uses `z` instead of `u`, we still find keys.
        let content = concat!(
            r#"name:"",description:"" "#,
            r#"var z=require("zod");"#,
            r#"var s=z.object({"#,
            r#"showThinkingSummaries:z.boolean().optional().describe("Show it"),"#,
            r#"}).passthrough();"#,
        );
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("cli.js");
        write_claude_fixture(&p, content);

        let fields = discover_settings_schema_sync(Some(p.to_str().unwrap())).unwrap();
        assert!(fields.iter().any(|f| f["key"] == "showThinkingSummaries"));
    }

    #[test]
    fn settings_regex_handles_template_literal_describe() {
        let content = concat!(
            r#"name:"",description:"" "#,
            r#"import*as u from"zod";"#,
            r#"var s=u.object({"#,
            "fastMode:u.boolean().optional().describe(`Fast mode.`),",
            r#"}).passthrough();"#,
        );
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("cli.js");
        write_claude_fixture(&p, content);

        let fields = discover_settings_schema_sync(Some(p.to_str().unwrap())).unwrap();
        assert!(fields.iter().any(|f| f["key"] == "fastMode"));
    }

    #[test]
    fn settings_regex_describe_past_long_chain() {
        // Verify the wider 1200-char lookahead catches .describe() after a very long chain.
        let long_chain =
            ".optional().catch(\"\").refine(x => x == x, {message: \"blah\"})".repeat(6); // ~400+ chars of chain
        let content = format!(
            r#"name:"",description:"" import*as u from"zod";var s=u.object({{remote:u.boolean(){}.describe("A setting")}});"#,
            long_chain
        );
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("cli.js");
        write_claude_fixture(&p, &content);

        let fields = discover_settings_schema_sync(Some(p.to_str().unwrap())).unwrap();
        assert!(
            fields.iter().any(|f| f["key"] == "remote"),
            "remote expected in {:?}",
            fields
        );
    }

    // ---- ported from legacy cli.rs tests ----

    /// A unique marker embedded in test content to prove the returned content
    /// came from our temp file rather than a system-installed Claude binary.
    const TEST_MARKER: &str = "TEST_MARKER_7f3a9c2e";
    const TEST_CLAUDE_ANCHOR: &str = "getPromptForCommand";

    fn write_claude_fixture(path: &std::path::Path, content: impl AsRef<str>) {
        std::fs::write(path, format!("{};{}", TEST_CLAUDE_ANCHOR, content.as_ref())).unwrap();
    }

    /// Valid content with an embedded marker for origin verification.
    fn valid_content_with_marker() -> String {
        format!(
            r#"{};stuff name:"review",description:"Review code" {} more stuff"#,
            TEST_CLAUDE_ANCHOR, TEST_MARKER
        )
    }

    // --- read_claude_binary tests ---

    #[test]
    fn read_binary_direct_js_path_valid_content() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");
        let content = valid_content_with_marker();
        write_claude_fixture(&js_path, &content);

        let result = read_claude_binary(Some(js_path.to_str().unwrap()));
        assert!(result.is_ok(), "should read valid JS file directly");
        let returned = result.unwrap();
        // Verify the content came from our temp file, not a system fallback
        assert!(
            returned.content.contains(TEST_MARKER),
            "should return content from the given path"
        );
        assert_eq!(returned.source, "direct_cli_path");
        assert_eq!(returned.path.as_deref(), Some(js_path.to_str().unwrap()));
    }

    #[test]
    fn read_binary_direct_path_invalid_content_skipped() {
        // When the direct path has invalid content, read_claude_binary skips it
        // and falls through to later resolution steps. The function may still
        // succeed via system fallbacks (legacy versions dir, npm root -g).
        // We verify the direct path's content is NOT returned.
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");
        let invalid_with_marker = format!("console.log('{}');", TEST_MARKER);
        std::fs::write(&js_path, &invalid_with_marker).unwrap();

        let result = read_claude_binary(Some(js_path.to_str().unwrap()));
        match result {
            Ok(content) => {
                // If fallback succeeded, verify it did NOT return our invalid content
                assert!(
                    !content.content.contains(TEST_MARKER),
                    "invalid content should be skipped; fallback returned system binary"
                );
            }
            Err(_) => {
                // All fallbacks failed too — expected on machines without Claude
            }
        }
    }

    #[test]
    fn read_binary_cmd_shim_resolves_to_js() {
        let dir = tempfile::tempdir().unwrap();

        // Create the JS file with valid content and marker
        let js_path = dir.path().join("cli.js");
        let content = valid_content_with_marker();
        write_claude_fixture(&js_path, &content);

        // Create a .cmd shim pointing to it (mimics npm's Windows shims)
        let cmd_path = dir.path().join("claude.cmd");
        let shim_content = format!(
            "@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \"{}\" %*\r\n) ELSE (\r\n  node  \"{}\" %*\r\n)",
            js_path.display(),
            js_path.display()
        );
        std::fs::write(&cmd_path, &shim_content).unwrap();

        let result = read_claude_binary(Some(cmd_path.to_str().unwrap()));
        assert!(
            result.is_ok(),
            "should resolve .cmd shim to JS file: {:?}",
            result.err()
        );
        let returned = result.unwrap();
        assert!(
            returned.content.contains(TEST_MARKER),
            "should return content from the .cmd shim's JS target"
        );
        assert_eq!(returned.source, "cmd_shim_js");
        assert_eq!(returned.path.as_deref(), Some(js_path.to_str().unwrap()));
    }

    #[test]
    fn read_binary_cmd_shim_invalid_js_not_returned() {
        let dir = tempfile::tempdir().unwrap();

        // Create JS file with INVALID content bearing a marker
        let js_path = dir.path().join("cli.js");
        let invalid_with_marker = format!("console.log('{}');", TEST_MARKER);
        std::fs::write(&js_path, &invalid_with_marker).unwrap();

        // Create a .cmd shim pointing to it
        let cmd_path = dir.path().join("claude.cmd");
        let shim_content = format!("@\"%~dp0\\node.exe\" \"{}\" %*\r\n", js_path.display());
        std::fs::write(&cmd_path, &shim_content).unwrap();

        let result = read_claude_binary(Some(cmd_path.to_str().unwrap()));
        match result {
            Ok(content) => {
                assert!(
                    !content.content.contains(TEST_MARKER),
                    "invalid JS content via shim should not be returned"
                );
            }
            Err(_) => {
                // All fallbacks failed — expected behavior
            }
        }
    }

    #[test]
    fn read_binary_cmd_shim_missing_js_not_returned() {
        let dir = tempfile::tempdir().unwrap();

        // .cmd shim points to a JS file that does not exist
        let cmd_path = dir.path().join("claude.cmd");
        let missing_path = dir.path().join("nonexistent.js");
        let shim_content = format!("@\"node\" \"{}\" %*\r\n", missing_path.display());
        std::fs::write(&cmd_path, &shim_content).unwrap();

        let result = read_claude_binary(Some(cmd_path.to_str().unwrap()));
        // The shim's target doesn't exist, so the .cmd resolution step fails.
        // The function may still succeed via later fallbacks.
        // We just verify it doesn't panic.
        let _ = result;
    }

    #[test]
    fn read_binary_sibling_node_modules_fallback() {
        let dir = tempfile::tempdir().unwrap();

        // Create the sibling node_modules structure with marked content
        let sibling_dir = dir
            .path()
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code");
        std::fs::create_dir_all(&sibling_dir).unwrap();
        let content = valid_content_with_marker();
        std::fs::write(sibling_dir.join("cli.js"), &content).unwrap();

        // Give an invalid direct path (non-.cmd file in same directory)
        let fake_bin = dir.path().join("claude");
        std::fs::write(&fake_bin, "not-valid-content").unwrap();

        let result = read_claude_binary(Some(fake_bin.to_str().unwrap()));
        assert!(
            result.is_ok(),
            "should fall through to sibling node_modules: {:?}",
            result.err()
        );
        let returned = result.unwrap();
        let expected_cli = sibling_dir.join("cli.js");
        assert!(
            returned.content.contains(TEST_MARKER),
            "should return content from sibling node_modules"
        );
        assert_eq!(returned.source, "sibling_node_modules");
        assert_eq!(
            returned.path.as_deref(),
            Some(expected_cli.to_str().unwrap())
        );
    }

    #[test]
    fn read_binary_none_path_does_not_panic() {
        // With no cli_path, it tries legacy versions dir and npm root -g.
        // Whether it succeeds depends on system state — just verify no panic.
        let result = read_claude_binary(None);
        let _ = result;
    }

    #[test]
    fn read_binary_nonexistent_path_does_not_panic() {
        // Nonexistent direct path causes fallthrough to later steps.
        // Whether it ultimately succeeds depends on system state.
        let result = read_claude_binary(Some("/nonexistent/path/to/claude"));
        let _ = result;
    }

    #[test]
    fn claude_content_requires_claude_specific_anchor() {
        assert!(
            !is_claude_content(r#"var x={name:"build",description:"Build"};"#),
            "generic name/description objects must not pass binary validation"
        );
        assert!(is_claude_content(
            r#"getPromptForCommand;var x={name:"build",description:"Build"};"#
        ));
    }

    // --- discover_builtin_commands_sync tests ---

    #[test]
    fn discover_builtin_extracts_commands() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        // Simulated minified binary content with command registrations
        let content = concat!(
            r#"var a={type:"prompt",name:"review",description:"Review code changes"}; "#,
            r#"var b={type:"local-jsx",name:"init",description:"Initialize a new project"}; "#,
            r#"var c={type:"local",name:"compact",description:"Compact conversation history"}; "#,
            r#"var d={type:"prompt",name:"bug-report",description:"Report a bug"};"#,
        );
        write_claude_fixture(&js_path, content);

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        assert!(result.is_ok());
        let commands = result.unwrap();
        assert!(
            commands.len() >= 4,
            "should extract at least 4 commands, got {}",
            commands.len()
        );

        let names: Vec<&str> = commands.iter().filter_map(|c| c["cmd"].as_str()).collect();
        assert!(names.contains(&"/review"), "should contain /review");
        assert!(names.contains(&"/init"), "should contain /init");
        assert!(names.contains(&"/compact"), "should contain /compact");
        assert!(
            names.contains(&"/bug-report"),
            "should contain /bug-report (hyphens allowed)"
        );
    }

    #[test]
    fn discover_builtin_deduplicates_commands() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = r#"var a={type:"local",name:"review",description:"First"};var b={type:"local",name:"review",description:"Second"}"#;
        write_claude_fixture(&js_path, content);

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();
        let review_count = commands
            .iter()
            .filter(|c| c["cmd"].as_str() == Some("/review"))
            .count();
        assert_eq!(review_count, 1, "should deduplicate /review");
    }

    #[test]
    fn discover_builtin_filters_noise() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = concat!(
            r#"var a={type:"local",name:"review",description:"Review code"}; "#,
            r#"var b={type:"local",name:"browser-tool",description:"Interact with DOM elements"}"#,
        );
        write_claude_fixture(&js_path, content);

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();
        let names: Vec<&str> = commands.iter().filter_map(|c| c["cmd"].as_str()).collect();

        assert!(names.contains(&"/review"), "/review should be kept");
        assert!(
            !names.contains(&"/browser-tool"),
            "DOM-related tool should be filtered"
        );
    }

    #[test]
    fn discover_builtin_cleans_escaped_newlines() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = r#"var a={type:"local",name:"review",description:"Line one\nLine two"}"#;
        write_claude_fixture(&js_path, content);

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();
        let desc = commands[0]["desc"].as_str().unwrap();
        assert!(
            !desc.contains("\\n"),
            "escaped newlines should be replaced with spaces"
        );
        assert!(desc.contains("Line one Line two"));
    }

    #[test]
    fn discover_builtin_no_commands_in_content() {
        // Content passes is_claude_content but has no extractable commands
        // besides the validation pattern itself.
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");
        // Minimal valid content — "ab" is too short to pass the >=4 char filter
        let content = r#"var a={type:"local",name:"ab",description:"Too short"}"#;
        write_claude_fixture(&js_path, content);

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        assert!(result.is_ok());
        // /ab is only 3 chars, filtered by cmd.len() >= 4
        let commands = result.unwrap();
        let names: Vec<&str> = commands.iter().filter_map(|c| c["cmd"].as_str()).collect();
        assert!(
            !names.contains(&"/ab"),
            "/ab should be filtered (too short)"
        );
    }

    #[test]
    fn discover_builtin_intervening_properties() {
        // Commands with aliases/type/etc. between name and description
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = concat!(
            r#"var x={type:"local-jsx",name:"tasks",aliases:["bashes"],description:"List and manage background tasks",load:()=>null};"#,
            r#" var y={type:"local-jsx",name:"branch",aliases:["fork"],description:"Create a branch",argumentHint:"[name]",load:()=>null};"#,
            r#" var z={type:"local-jsx",name:"permissions",aliases:["allowed-tools"],description:"Manage allow and deny tool permission rules",load:()=>null};"#,
        );
        write_claude_fixture(&js_path, content);

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();
        let names: Vec<&str> = commands.iter().filter_map(|c| c["cmd"].as_str()).collect();

        assert!(
            names.contains(&"/tasks"),
            "should find /tasks with intervening aliases"
        );
        assert!(
            names.contains(&"/branch"),
            "should find /branch with intervening aliases"
        );
        assert!(
            names.contains(&"/permissions"),
            "should find /permissions with intervening aliases"
        );

        let tasks_desc = commands
            .iter()
            .find(|c| c["cmd"].as_str() == Some("/tasks"))
            .and_then(|c| c["desc"].as_str())
            .unwrap();
        assert_eq!(tasks_desc, "List and manage background tasks");
    }

    #[test]
    fn discover_builtin_reversed_property_order() {
        // Commands where description comes before name in the object
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = concat!(
            r#"var x={description:"Restore the code and/or conversation to a previous point",name:"rewind",aliases:["checkpoint"],type:"local"};"#,
            r#" var y={description:"View release notes",name:"release-notes",type:"local",supportsNonInteractive:!0};"#,
        );
        write_claude_fixture(&js_path, content);

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();
        let names: Vec<&str> = commands.iter().filter_map(|c| c["cmd"].as_str()).collect();

        assert!(
            names.contains(&"/rewind"),
            "should find /rewind with reversed order"
        );
        assert!(
            !names.contains(&"/release-notes"),
            "Claude changelog command should be managed by Code Tabs instead"
        );

        let rewind_desc = commands
            .iter()
            .find(|c| c["cmd"].as_str() == Some("/rewind"))
            .and_then(|c| c["desc"].as_str())
            .unwrap();
        assert!(
            rewind_desc.contains("Restore"),
            "rewind should have its description"
        );
    }

    #[test]
    fn discover_builtin_computed_description() {
        // Commands with ternary or function-call descriptions
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = concat!(
            r#"var x={type:"local-jsx",name:"login",description:yv$()?"Switch Anthropic accounts":"Sign in with your Anthropic account",load:()=>null};"#,
            r#" var y={type:"local-jsx",name:"terminal-setup",description:M6==="Apple"?"Enable Option key":"Install Shift key",load:()=>null};"#,
        );
        write_claude_fixture(&js_path, content);

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();
        let names: Vec<&str> = commands.iter().filter_map(|c| c["cmd"].as_str()).collect();

        assert!(
            names.contains(&"/login"),
            "should find /login with computed description"
        );
        assert!(
            names.contains(&"/terminal-setup"),
            "should find /terminal-setup with computed description"
        );

        let login_desc = commands
            .iter()
            .find(|c| c["cmd"].as_str() == Some("/login"))
            .and_then(|c| c["desc"].as_str())
            .unwrap();
        assert!(
            login_desc.contains("Anthropic"),
            "login should have first branch of ternary as description"
        );
    }

    #[test]
    fn discover_builtin_template_literal_description() {
        // Commands with template literal (backtick) descriptions
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = r#"var x={type:"local-jsx",name:"model",get description(){return`Set the AI model for Claude Code (currently ${Bw(Zf())})`}}"#;
        write_claude_fixture(&js_path, content);

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();
        let names: Vec<&str> = commands.iter().filter_map(|c| c["cmd"].as_str()).collect();

        assert!(
            names.contains(&"/model"),
            "should find /model with template literal description"
        );

        let model_desc = commands
            .iter()
            .find(|c| c["cmd"].as_str() == Some("/model"))
            .and_then(|c| c["desc"].as_str())
            .unwrap();
        assert!(
            model_desc.contains("Set the AI model"),
            "model should have template literal text"
        );
        assert!(
            !model_desc.contains("${"),
            "interpolations should be stripped"
        );
    }

    #[test]
    fn discover_builtin_name_only_fallback() {
        // Commands with no extractable description get empty desc
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        // Name exists but description is a bare variable reference (no quoted strings nearby).
        // Include a standard-pattern command (with object boundary) so content passes is_claude_content.
        let content = concat!(
            r#"var z={type:"local",name:"review",description:"Review code"};"#,
            r#"var x={type:"local",name:"fast",get description(){return someVar},load:()=>null}"#,
        );
        write_claude_fixture(&js_path, content);

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();
        let names: Vec<&str> = commands.iter().filter_map(|c| c["cmd"].as_str()).collect();

        assert!(
            names.contains(&"/fast"),
            "should find /fast even without extractable description"
        );

        let fast_desc = commands
            .iter()
            .find(|c| c["cmd"].as_str() == Some("/fast"))
            .and_then(|c| c["desc"].as_str())
            .unwrap();
        assert_eq!(fast_desc, "", "should have empty description as fallback");
    }

    #[test]
    fn discover_builtin_no_cross_object_theft() {
        // A command with no description must not steal the next object's description
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = concat!(
            r#"var a={name:"foo",type:"local",load:()=>null};"#,
            r#"var b={type:"local",name:"bar",description:"Bar description",load:()=>null};"#,
        );
        write_claude_fixture(&js_path, content);

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();

        let foo_desc = commands
            .iter()
            .find(|c| c["cmd"].as_str() == Some("/foo"))
            .and_then(|c| c["desc"].as_str())
            .unwrap();
        let bar_desc = commands
            .iter()
            .find(|c| c["cmd"].as_str() == Some("/bar"))
            .and_then(|c| c["desc"].as_str())
            .unwrap();

        assert_eq!(foo_desc, "", "/foo should not steal /bar's description");
        assert_eq!(
            bar_desc, "Bar description",
            "/bar should keep its own description"
        );
    }

    #[test]
    fn discover_builtin_rejects_non_command_names() {
        // highlight.js languages, signals, HTML elements — all lack type:"prompt/local/local-jsx"
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = concat!(
            r#"var real={type:"prompt",name:"commit",description:"Create a git commit"}; "#,
            r#"{name:"Python",value:"python"}; "#,
            r#"{name:"SIGABRT",number:6,action:"core",description:"Aborted",standard:"ansi"}; "#,
            r#"NK({tag:"div",name:"HTMLDivElement",ctor:function($,q,K){i_.call(this,$,q,K)}})"#,
        );
        write_claude_fixture(&js_path, content);

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();
        let names: Vec<&str> = commands.iter().filter_map(|c| c["cmd"].as_str()).collect();

        assert!(names.contains(&"/commit"), "real command should be found");
        assert!(
            !names.contains(&"/Python"),
            "highlight.js language should be filtered"
        );
        assert!(!names.contains(&"/SIGABRT"), "signal should be filtered");
        assert!(
            !names.contains(&"/HTMLDivElement"),
            "HTML element should be filtered"
        );
    }

    #[test]
    fn discover_builtin_filters_hidden_commands() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = concat!(
            r#"var a={type:"local",name:"heapdump",description:"Dump the JS heap",isHidden:!0,load:()=>null};"#,
            r#"var b={type:"local-jsx",name:"help",description:"Show help",load:()=>null};"#,
        );
        write_claude_fixture(&js_path, content);

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();
        let names: Vec<&str> = commands.iter().filter_map(|c| c["cmd"].as_str()).collect();

        assert!(
            !names.contains(&"/heapdump"),
            "isHidden:!0 command should be filtered"
        );
        assert!(names.contains(&"/help"), "visible command should be kept");
    }

    #[test]
    fn discover_builtin_filters_mcp_template_names() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = concat!(
            r#"var a={type:"prompt",name:"mcp__",description:"MCP prompt"}; "#,
            r#"var b={type:"local-jsx",name:"mcp",description:"Manage MCP servers"};"#,
        );
        write_claude_fixture(&js_path, content);

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();
        let names: Vec<&str> = commands.iter().filter_map(|c| c["cmd"].as_str()).collect();

        assert!(
            !names.contains(&"/mcp__"),
            "MCP template fragment should be filtered"
        );
        assert!(names.contains(&"/mcp"), "real /mcp command should be kept");
    }

    // --- discover_settings_schema_sync tests ---

    #[test]
    fn discover_schema_extracts_boolean_field() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        // Must also pass is_claude_content validation
        let content = concat!(
            r#"name:"init",description:"Initialize" "#,
            r#"verboseMode:u.boolean().optional().describe("Enable verbose logging")"#,
        );
        write_claude_fixture(&js_path, content);

        let result = discover_settings_schema_sync(Some(js_path.to_str().unwrap()));
        assert!(result.is_ok());
        let fields = result.unwrap();
        let verbose = fields.iter().find(|f| f["key"] == "verboseMode");
        assert!(verbose.is_some(), "should find verboseMode field");
        let v = verbose.unwrap();
        assert_eq!(v["type"], "boolean");
        assert_eq!(v["optional"], true);
        assert!(v["description"]
            .as_str()
            .unwrap()
            .contains("verbose logging"));
    }

    #[test]
    fn discover_schema_extracts_enum_with_choices() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = concat!(
            r#"name:"init",description:"Initialize" "#,
            r#"themeMode:u.enum(["light","dark","system"]).optional().describe("UI theme preference")"#,
        );
        write_claude_fixture(&js_path, content);

        let result = discover_settings_schema_sync(Some(js_path.to_str().unwrap()));
        let fields = result.unwrap();
        let theme = fields.iter().find(|f| f["key"] == "themeMode");
        assert!(theme.is_some(), "should find themeMode field");
        let t = theme.unwrap();
        assert_eq!(t["type"], "enum");
        let choices: Vec<&str> = t["choices"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert_eq!(choices, vec!["light", "dark", "system"]);
    }

    #[test]
    fn discover_schema_skips_noise_keys() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        // "type", "name", "value" are in the skip list
        let content = concat!(
            r#"name:"init",description:"Initialize" "#,
            r#"type:u.string().describe("Should be skipped") "#,
            r#"value:u.string().describe("Should be skipped") "#,
            r#"customSetting:u.string().describe("Should be kept")"#,
        );
        write_claude_fixture(&js_path, content);

        let result = discover_settings_schema_sync(Some(js_path.to_str().unwrap()));
        let fields = result.unwrap();
        let keys: Vec<&str> = fields.iter().filter_map(|f| f["key"].as_str()).collect();
        assert!(
            !keys.contains(&"type"),
            "noise key 'type' should be skipped"
        );
        assert!(
            !keys.contains(&"value"),
            "noise key 'value' should be skipped"
        );
        assert!(keys.contains(&"customSetting"), "valid key should be kept");
    }

    #[test]
    fn discover_schema_skips_fields_without_describe() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        // Separate the two fields with enough distance that noDescription's lookahead
        // cannot reach hasDescription's .describe(). The lookahead window is 1200 chars.
        // Use non-alphanumeric padding so regex key boundaries work correctly.
        let padding = ";".repeat(1500);
        let content = format!(
            r#"name:"init",description:"Initialize" noDescription:u.boolean().optional() {}hasDescription:u.boolean().optional().describe("Has a description")"#,
            padding
        );
        write_claude_fixture(&js_path, content);

        let result = discover_settings_schema_sync(Some(js_path.to_str().unwrap()));
        let fields = result.unwrap();
        let keys: Vec<&str> = fields.iter().filter_map(|f| f["key"].as_str()).collect();
        assert!(
            !keys.contains(&"noDescription"),
            "field without .describe() should be skipped"
        );
        assert!(
            keys.contains(&"hasDescription"),
            "field with .describe() should be kept"
        );
    }

    #[test]
    fn discover_schema_no_schemas_in_content() {
        // Content passes is_claude_content but has no Zod patterns
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");
        let content = r#"name:"init",description:"Initialize" no zod here"#;
        write_claude_fixture(&js_path, content);

        let result = discover_settings_schema_sync(Some(js_path.to_str().unwrap()));
        assert!(result.is_ok());
        assert!(
            result.unwrap().is_empty(),
            "no Zod patterns means no schema fields"
        );
    }

    #[test]
    fn discover_schema_sorts_alphabetically() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = concat!(
            r#"name:"init",description:"Initialize" "#,
            r#"zebraSetting:u.string().describe("Zebra setting") "#,
            r#"alphaSetting:u.string().describe("Alpha setting") "#,
            r#"middleSetting:u.string().describe("Middle setting")"#,
        );
        write_claude_fixture(&js_path, content);

        let result = discover_settings_schema_sync(Some(js_path.to_str().unwrap()));
        let fields = result.unwrap();
        let keys: Vec<&str> = fields.iter().filter_map(|f| f["key"].as_str()).collect();
        assert_eq!(
            keys,
            vec!["alphaSetting", "middleSetting", "zebraSetting"],
            "should be sorted alphabetically"
        );
    }

    // ---- version_key (semver-aware dir selection) ----

    #[test]
    fn version_key_sorts_numerically() {
        let mut v = vec!["2.1.104", "2.1.90", "2.1.92"];
        v.sort_by(|a, b| version_key(a).cmp(&version_key(b)));
        assert_eq!(v, vec!["2.1.90", "2.1.92", "2.1.104"]);
    }

    #[test]
    fn version_key_handles_non_numeric() {
        // Non-numeric segment sorts after numeric via u32::MAX sentinel.
        let mut v = vec!["2.1.5-beta", "2.1.5"];
        v.sort_by(|a, b| version_key(a).cmp(&version_key(b)));
        // "2.1.5-beta" parses as (2,"") (1,"") (MAX,"5-beta"); "2.1.5" parses as
        // (2,"") (1,"") (5,""). Numeric 5 < MAX, so "2.1.5" sorts first.
        assert_eq!(v, vec!["2.1.5", "2.1.5-beta"]);
    }

    // ---- walk_balanced (brace walker) ----

    #[test]
    fn walk_balanced_finds_matching_brace() {
        let s = "({a:1,b:{c:2}})";
        // Start one past the first `{` (at index 1 after `(`)
        let open_pos = s.find('{').unwrap();
        let end = walk_balanced(s, open_pos + 1, '{', '}', 100).unwrap();
        assert_eq!(&s[open_pos..=end], "{a:1,b:{c:2}}");
    }

    #[test]
    fn walk_balanced_returns_none_when_unterminated() {
        let s = "{a:1,b:{c:2}";
        let end = walk_balanced(s, 1, '{', '}', 100);
        assert!(end.is_none());
    }

    #[test]
    fn walk_balanced_respects_max() {
        let s = "{".to_string() + &"a".repeat(1000) + "}";
        // max=10 truncates before the closing brace is reached.
        let end = walk_balanced(&s, 1, '{', '}', 10);
        assert!(end.is_none());
    }

    #[test]
    fn walk_balanced_ignores_delimiters_inside_strings_and_comments() {
        let s = r#"{a:"}",b:'}',c:`}`,d:/}/,e:/* } */{f:1}}"#;
        let end = walk_balanced(s, 1, '{', '}', 100).unwrap();
        assert_eq!(&s[..=end], s);
    }

    // ---- scan_settings_metadata ----

    #[test]
    fn scan_settings_metadata_finds_source_objects() {
        let content = r#"data={theme:{source:"global",type:"enum",description:"Theme"},showTurnDuration:{source:"global",type:"boolean",description:'Turn duration'}}"#;
        let keys = scan_settings_metadata(content);
        assert!(keys.contains(&"theme".to_string()));
        assert!(keys.contains(&"showTurnDuration".to_string()));
    }

    #[test]
    fn scan_settings_metadata_rejects_unknown_source() {
        // `source:"http"` is not in the whitelist — should not match.
        let content = r#"foo:{source:"http",type:"string"}"#;
        let keys = scan_settings_metadata(content);
        assert!(keys.is_empty());
    }

    #[test]
    fn scan_settings_metadata_filters_noise_keys() {
        // `value` is in the noise allowlist.
        let content = r#"value:{source:"global",type:"string"}"#;
        let keys = scan_settings_metadata(content);
        assert!(keys.is_empty(), "noise key `value` should be filtered");
    }

    #[test]
    fn scan_settings_factory_keys_finds_helper_schema_setting() {
        let content = r#"settings={permissions:$Kq(H).optional().describe("Tool usage permissions configuration")}"#;
        let keys = scan_settings_factory_keys(content);
        assert_eq!(keys, vec!["permissions".to_string()]);
    }

    // ---- scan_global_config_keys ----

    #[test]
    fn scan_global_config_keys_extracts_array() {
        let content = r#"var x=["apiKeyHelper","theme","autoConnectIde","editorMode","env"];"#;
        let keys = scan_global_config_keys(content);
        assert!(keys.contains(&"autoConnectIde".to_string()));
        assert!(keys.contains(&"editorMode".to_string()));
        assert!(keys.contains(&"theme".to_string()));
    }

    #[test]
    fn scan_global_config_keys_ignores_object_context() {
        // Anchor is inside an object literal, not an array — should be rejected.
        let content = r#"x={"apiKeyHelper":"foo","other":"bar"}"#;
        let keys = scan_global_config_keys(content);
        assert!(keys.is_empty());
    }

    #[test]
    fn scan_global_config_keys_handles_multiple_arrays() {
        let content = concat!(
            r#"a=["apiKeyHelper","first","second"];"#,
            r#"b=["apiKeyHelper","third"];"#,
        );
        let keys = scan_global_config_keys(content);
        assert!(keys.contains(&"first".to_string()));
        assert!(keys.contains(&"third".to_string()));
    }

    // ---- scan_nested_namespaces ----

    #[test]
    fn scan_nested_namespaces_direct_object() {
        let content = r#"schema={worktree:N.object({sparsePaths:N.array(N.string()).optional(),symlinkDirectories:N.array(N.string()).optional()})}"#;
        let keys = scan_nested_namespaces(content, "N");
        assert!(keys.contains(&"worktree.sparsePaths".to_string()));
        assert!(keys.contains(&"worktree.symlinkDirectories".to_string()));
        assert!(
            keys.contains(&"worktree".to_string()),
            "namespace itself should be emitted when a schema is resolved"
        );
    }

    #[test]
    fn scan_nested_namespaces_lazy_factory() {
        // Factory-returning form like `fS7=mH(()=>N.object({…}))`.
        let content = r#"_S7=mH(()=>N.object({allowedDomains:N.array(N.string()).optional(),httpProxyPort:N.number().optional()}));root={network:_S7(),filesystem:_S7()}"#;
        let keys = scan_nested_namespaces(content, "N");
        assert!(keys.contains(&"network.allowedDomains".to_string()));
        assert!(keys.contains(&"network.httpProxyPort".to_string()));
        assert!(keys.contains(&"network".to_string()));
    }

    #[test]
    fn scan_nested_namespaces_respects_alias() {
        // Alias is `z`; `N.` schemas should NOT match.
        let content = r#"schema={worktree:N.object({sparsePaths:N.array(N.string()).optional()})}"#;
        let keys = scan_nested_namespaces(content, "z");
        assert!(keys.is_empty(), "mismatched alias should capture nothing");
    }

    #[test]
    fn scan_nested_namespaces_discovers_new_namespace() {
        let content =
            r#"schema={futureThing:N.object({enabled:N.boolean().optional(),mode:N.string()})}"#;
        let keys = scan_nested_namespaces(content, "N");
        assert!(keys.contains(&"futureThing.enabled".to_string()));
        assert!(keys.contains(&"futureThing.mode".to_string()));
        assert!(keys.contains(&"futureThing".to_string()));
    }

    // ---- command marker expansion ----

    #[test]
    fn discover_commands_picks_up_skill_with_userinvocable() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");
        // Must pass is_claude_content check, so include the sentinel strings.
        let content = r#"{name:"init",description:"init",type:"local",x:1}{name:"batch",description:"Run batch",whenToUse:'…',userInvocable:!0}"#;
        write_claude_fixture(&js_path, content);

        let cmds = discover_builtin_commands_sync(Some(js_path.to_str().unwrap())).unwrap();
        let names: Vec<&str> = cmds.iter().filter_map(|c| c["cmd"].as_str()).collect();
        assert!(
            names.contains(&"/batch"),
            "skill with userInvocable should be picked up"
        );
    }

    #[test]
    fn discover_commands_dedup_after_marker_check() {
        // First `name:"mcp"` is a non-command (MCP tool: no marker). Second has
        // `type:"local-jsx"` — the real command. Post-fix, /mcp must survive.
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");
        let filler = "x".repeat(1200);
        let content = format!(
            r#"{{isMcp:!0,name:"mcp",description:"mcp tool",x:1}}{}{{type:"local-jsx",name:"mcp",description:"Manage MCP servers"}}"#,
            filler
        );
        write_claude_fixture(&js_path, &content);

        let cmds = discover_builtin_commands_sync(Some(js_path.to_str().unwrap())).unwrap();
        let names: Vec<&str> = cmds.iter().filter_map(|c| c["cmd"].as_str()).collect();
        assert!(
            names.contains(&"/mcp"),
            "real command must survive dedup when a same-named non-command appears first"
        );
    }

    // ---- env var passes ----

    #[test]
    fn discover_env_vars_bracket_access() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");
        let content = r#"name:"init",description:"init",x=process.env['ANTHROPIC_LOG']||''"#;
        write_claude_fixture(&js_path, content);

        let vars = discover_env_vars_sync(Some(js_path.to_str().unwrap())).unwrap();
        assert!(
            vars.iter().any(|v| v.name == "ANTHROPIC_LOG"),
            "bracket-access env var should be picked up"
        );
    }

    #[test]
    fn discover_env_vars_proximity_literal() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");
        // `VERTEX_REGION_CLAUDE_4_0_OPUS` is a bare literal; must be within
        // 64 KB of a `process.env` anchor to pass.
        let content = r#"name:"init",description:"init",process.env.ANTHROPIC_API_KEY;table=[["claude-opus-4","VERTEX_REGION_CLAUDE_4_0_OPUS"]]"#;
        write_claude_fixture(&js_path, content);

        let vars = discover_env_vars_sync(Some(js_path.to_str().unwrap())).unwrap();
        assert!(
            vars.iter()
                .any(|v| v.name == "VERTEX_REGION_CLAUDE_4_0_OPUS"),
            "proximity-gated literal should be picked up"
        );
    }

    #[test]
    fn discover_env_vars_rejects_unprefixed_literal() {
        // `RANDOM_CONSTANT` does not have an allowlisted prefix.
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");
        let content =
            r#"name:"init",description:"init",process.env.ANTHROPIC_API_KEY;x="RANDOM_CONSTANT""#;
        write_claude_fixture(&js_path, content);

        let vars = discover_env_vars_sync(Some(js_path.to_str().unwrap())).unwrap();
        assert!(
            !vars.iter().any(|v| v.name == "RANDOM_CONSTANT"),
            "un-prefixed literal should be rejected"
        );
    }

    #[test]
    fn discover_env_vars_assignment_form() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");
        let content = r#"name:"init",description:"init",args=["CLAUDECODE=1","CLAUDE_CODE_EXPERIMENTAL_X=y"]"#;
        write_claude_fixture(&js_path, content);

        let vars = discover_env_vars_sync(Some(js_path.to_str().unwrap())).unwrap();
        assert!(vars.iter().any(|v| v.name == "CLAUDECODE"));
        assert!(vars.iter().any(|v| v.name == "CLAUDE_CODE_EXPERIMENTAL_X"));
    }
}

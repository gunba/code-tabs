//! Discovery primitives shared between CLIs.
//!
//! Per-CLI mining (Claude .js binary scanning, Codex native-binary schema
//! extraction) lives in `claude` and `codex` submodules. This file holds:
//!   * shared cross-CLI types (`DiscoveredEnvVar`, `PluginScanRejection`),
//!   * shared SKILL.md parsing helpers used by both Claude plugin discovery
//!     and Codex skill discovery (`scan_skill_md`, `parse_skill_frontmatter`,
//!     `is_valid_skill_slug`).
//!
//! Existing call sites (`commands::cli`, `commands::codex_cli`,
//! `bin/discover_audit`) import via `crate::discovery::<symbol>` — the
//! `pub use claude::*` re-export below keeps that surface stable after the
//! Phase 1a split.

use serde_json::json;

pub mod claude;
pub mod codex;

pub use claude::*;

/// Discovered environment variable entry.
///
/// Used by both Claude env-var discovery (`claude::discover_env_vars_sync`)
/// and Codex env-var discovery (`codex::discover_codex_env_vars_sync`).
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct DiscoveredEnvVar {
    pub name: String,
    pub description: String,
    pub category: String,
    pub documented: bool,
}

/// Rejection reason emitted when a SKILL.md couldn't be turned into a command.
/// Callers (the Tauri wrappers) log a debug warning so silent drops stop being
/// silent. Used by both Claude plugin discovery and Codex skill discovery.
#[derive(Debug, Clone)]
pub struct PluginScanRejection {
    pub path: String,
    pub reason: String,
}

// [DM-02] scan_skill_md: name=frontmatter name: > parent dir name; desc=frontmatter desc: > first body line; reject only when both name sources fail
/// Parse a single SKILL.md file. Implements the resolution order shared by
/// Claude Code and Codex skill loaders:
///   * `name`: frontmatter `name:` > parent directory name (must be a valid slug).
///   * `description`: frontmatter `description:` > first non-empty body line
///     (truncated to 120 chars, surrounding matching quotes stripped).
/// Rejected only when both name sources fail.
pub fn scan_skill_md(
    path: &std::path::Path,
    commands: &mut Vec<serde_json::Value>,
    rejections: &mut Vec<PluginScanRejection>,
) {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            rejections.push(PluginScanRejection {
                path: path.to_string_lossy().to_string(),
                reason: format!("read error: {}", e),
            });
            return;
        }
    };

    let (fm_name, fm_desc, body) = parse_skill_frontmatter(&content);

    let name = fm_name.or_else(|| {
        path.parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty() && is_valid_skill_slug(s))
    });

    let name = match name {
        Some(n) => n,
        None => {
            rejections.push(PluginScanRejection {
                path: path.to_string_lossy().to_string(),
                reason: "no frontmatter name: and parent dir name is invalid".into(),
            });
            return;
        }
    };

    let desc = fm_desc
        .or_else(|| {
            body.lines()
                .map(|l| l.trim())
                .find(|l| !l.is_empty())
                .map(|l| l.trim_start_matches('#').trim().to_string())
        })
        .map(|s| {
            let s = s.trim();
            let s = s
                .strip_prefix('"')
                .and_then(|s| s.strip_suffix('"'))
                .or_else(|| s.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
                .unwrap_or(s);
            s.chars().take(120).collect::<String>()
        })
        .unwrap_or_default();

    commands.push(json!({
        "cmd": format!("/{}", name),
        "desc": desc
    }));
}

/// Extract `(frontmatter_name, frontmatter_description, body)` from a SKILL.md.
/// Each component may be absent. Tolerates a leading BOM and missing closing
/// `---`.
pub(crate) fn parse_skill_frontmatter(content: &str) -> (Option<String>, Option<String>, &str) {
    let trimmed = content.trim_start_matches('\u{feff}');
    let rest = match trimmed.strip_prefix("---") {
        Some(r) => r.trim_start_matches('\r').trim_start_matches('\n'),
        None => return (None, None, trimmed),
    };
    let end = match rest.find("\n---") {
        Some(i) => i,
        None => return (None, None, trimmed),
    };
    let meta = &rest[..end];
    let body_start = end + "\n---".len();
    let body = rest[body_start..]
        .trim_start_matches('\r')
        .trim_start_matches('\n');

    let extract = |key: &str| -> Option<String> {
        meta.lines()
            .map(|l| l.trim())
            .find(|l| l.starts_with(&format!("{}:", key)))
            .and_then(|l| l.splitn(2, ':').nth(1))
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };

    (extract("name"), extract("description"), body)
}

/// Validate a directory name is usable as a slash-command identifier.
/// Starts with a letter, then alphanumeric / `-` / `_`.
pub(crate) fn is_valid_skill_slug(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- parse_skill_frontmatter ----

    #[test]
    fn frontmatter_extracts_name_and_description() {
        let input = "---\nname: my-skill\ndescription: A cool skill\n---\nbody text\n";
        let (name, desc, body) = parse_skill_frontmatter(input);
        assert_eq!(name.as_deref(), Some("my-skill"));
        assert_eq!(desc.as_deref(), Some("A cool skill"));
        assert_eq!(body, "body text\n");
    }

    #[test]
    fn frontmatter_description_only_ok() {
        let input = "---\ndescription: \"Only desc\"\n---\nbody\n";
        let (name, desc, _body) = parse_skill_frontmatter(input);
        assert!(name.is_none());
        assert_eq!(desc.as_deref(), Some("\"Only desc\""));
    }

    #[test]
    fn frontmatter_absent() {
        let input = "no frontmatter here";
        let (name, desc, body) = parse_skill_frontmatter(input);
        assert!(name.is_none());
        assert!(desc.is_none());
        assert_eq!(body, "no frontmatter here");
    }

    #[test]
    fn frontmatter_malformed_treated_as_body() {
        let input = "---\nname: x\nno closing dashes";
        let (name, desc, _body) = parse_skill_frontmatter(input);
        assert!(name.is_none());
        assert!(desc.is_none());
    }

    // ---- is_valid_skill_slug ----

    #[test]
    fn slug_valid_cases() {
        assert!(is_valid_skill_slug("r"));
        assert!(is_valid_skill_slug("review-pr"));
        assert!(is_valid_skill_slug("my_skill"));
        assert!(is_valid_skill_slug("a1b2"));
    }

    #[test]
    fn slug_invalid_cases() {
        assert!(!is_valid_skill_slug(""));
        assert!(!is_valid_skill_slug("1name"));
        assert!(!is_valid_skill_slug(".hidden"));
        assert!(!is_valid_skill_slug("has space"));
    }
}

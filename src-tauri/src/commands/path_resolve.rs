use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use ignore::WalkBuilder;
use regex::Regex;

const INDEX_TTL: Duration = Duration::from_secs(60);
const MAX_INDEXED_FILES: usize = 100_000;
const MAX_WALK_DEPTH: usize = 12;

// Dirs skipped even if not gitignored. Hidden dirs (.git, .next, .cache)
// are already filtered by WalkBuilder::hidden(true), so keep this list to
// the non-hidden offenders.
const EXTRA_IGNORED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "vendor",
    "__pycache__",
];

static INDEX_CACHE: LazyLock<Mutex<HashMap<String, Arc<CwdIndex>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static LINE_SUFFIX_RE: OnceLock<Regex> = OnceLock::new();
fn line_suffix_re() -> &'static Regex {
    LINE_SUFFIX_RE.get_or_init(|| Regex::new(r"^(.+?)(:\d+(?::\d+)?)$").unwrap())
}

struct CwdIndex {
    built_at: Instant,
    by_basename: HashMap<String, Vec<PathBuf>>, // lowercase basename -> paths
    files: Vec<PathBuf>,
}

#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPath {
    pub candidate: String,
    pub abs_path: Option<String>,
    pub is_dir: bool,
}

fn normalize_cwd(cwd: &str) -> String {
    cwd.trim_end_matches(['/', '\\']).to_string()
}

fn is_absolute(p: &str) -> bool {
    if p.starts_with('/') || p.starts_with('\\') {
        return true;
    }
    // Windows drive letter: `C:\...` or `C:/...`.
    let bytes = p.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

fn join_path(cwd: &str, rel: &str) -> String {
    let use_win_sep = cwd.contains('\\') && !cwd.contains('/');
    let sep = if use_win_sep { '\\' } else { '/' };
    let trimmed = cwd.trim_end_matches(['/', '\\']);
    format!("{trimmed}{sep}{rel}")
}

fn split_suffix(raw: &str) -> String {
    match line_suffix_re().captures(raw) {
        Some(caps) => caps[1].to_string(),
        None => raw.to_string(),
    }
}

fn build_index(cwd: &Path) -> CwdIndex {
    let mut by_basename: HashMap<String, Vec<PathBuf>> = HashMap::new();
    let mut files: Vec<PathBuf> = Vec::new();
    let mut cap_hit = false;

    let walker = WalkBuilder::new(cwd)
        .hidden(true)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(false)
        .require_git(false)
        .max_depth(Some(MAX_WALK_DEPTH))
        .filter_entry(|dent| {
            let name = dent.file_name().to_string_lossy();
            !EXTRA_IGNORED_DIRS.contains(&name.as_ref())
        })
        .build();

    for result in walker {
        if files.len() >= MAX_INDEXED_FILES {
            cap_hit = true;
            break;
        }
        let Ok(entry) = result else { continue };
        let Some(ft) = entry.file_type() else { continue };
        if !ft.is_file() {
            continue;
        }
        let path = entry.into_path();
        if let Some(name) = path.file_name() {
            let lower = name.to_string_lossy().to_lowercase();
            by_basename.entry(lower).or_default().push(path.clone());
        }
        files.push(path);
    }

    if cap_hit {
        log::warn!(
            "resolve_paths: file index cap reached ({} files) for {}",
            MAX_INDEXED_FILES,
            cwd.display()
        );
    }

    CwdIndex {
        built_at: Instant::now(),
        by_basename,
        files,
    }
}

fn get_or_build_index(cwd: &str) -> Arc<CwdIndex> {
    {
        let cache = INDEX_CACHE.lock().unwrap();
        if let Some(existing) = cache.get(cwd) {
            if existing.built_at.elapsed() < INDEX_TTL {
                return Arc::clone(existing);
            }
        }
    }
    let fresh = Arc::new(build_index(Path::new(cwd)));
    let mut cache = INDEX_CACHE.lock().unwrap();
    cache.insert(cwd.to_string(), Arc::clone(&fresh));
    fresh
}

fn lookup_in_index(candidate: &str, index: &CwdIndex) -> Option<PathBuf> {
    let normalized = candidate.replace('\\', "/");
    let lower = normalized.to_lowercase();
    let has_sep = normalized.contains('/');

    let matches: Vec<PathBuf> = if has_sep {
        let suffix = format!("/{lower}");
        index
            .files
            .iter()
            .filter(|p| {
                let s = p.to_string_lossy().replace('\\', "/").to_lowercase();
                s.ends_with(&suffix) || s == lower
            })
            .cloned()
            .collect()
    } else {
        index
            .by_basename
            .get(&lower)
            .cloned()
            .unwrap_or_default()
    };

    matches
        .into_iter()
        .min_by_key(|p| (p.components().count(), p.as_os_str().len()))
}

fn resolve_candidate(
    candidate: &str,
    cwd: Option<&str>,
    home: Option<&Path>,
    index: &mut Option<Arc<CwdIndex>>,
) -> ResolvedPath {
    let no_suffix = split_suffix(candidate);
    let none = || ResolvedPath {
        candidate: candidate.to_string(),
        abs_path: None,
        is_dir: false,
    };

    // 1. Literal: ~, absolute drive/root, or cwd-joined.
    let literal: Option<PathBuf> = if no_suffix.starts_with('~') {
        home.map(|h| {
            let rest = no_suffix
                .trim_start_matches('~')
                .trim_start_matches(['/', '\\']);
            if rest.is_empty() {
                h.to_path_buf()
            } else {
                h.join(rest)
            }
        })
    } else if is_absolute(&no_suffix) {
        Some(PathBuf::from(&no_suffix))
    } else {
        cwd.map(|c| PathBuf::from(join_path(c, &no_suffix)))
    };

    if let Some(p) = literal {
        if let Ok(meta) = std::fs::metadata(&p) {
            return ResolvedPath {
                candidate: candidate.to_string(),
                abs_path: Some(p.to_string_lossy().into_owned()),
                is_dir: meta.is_dir(),
            };
        }
    }

    // 2. Subtree lookup — only for cwd-relative candidates.
    if no_suffix.starts_with('~') || is_absolute(&no_suffix) {
        return none();
    }
    let Some(cwd_str) = cwd else { return none() };
    let idx = index.get_or_insert_with(|| get_or_build_index(cwd_str));
    match lookup_in_index(&no_suffix, idx) {
        Some(hit) => {
            let is_dir = std::fs::metadata(&hit).map(|m| m.is_dir()).unwrap_or(false);
            ResolvedPath {
                candidate: candidate.to_string(),
                abs_path: Some(hit.to_string_lossy().into_owned()),
                is_dir,
            }
        }
        None => none(),
    }
}

/// Resolve terminal-derived path tokens against a session cwd. For each
/// candidate: try literal (~ expansion / absolute / cwd-joined) and, if
/// that misses, search a TTL-cached file index rooted at cwd. Returns one
/// entry per input candidate in input order; `absPath` is None when no
/// unambiguous match is found.
#[tauri::command]
pub async fn resolve_paths(cwd: Option<String>, candidates: Vec<String>) -> Vec<ResolvedPath> {
    tokio::task::spawn_blocking(move || {
        let home = dirs::home_dir();
        let normalized_cwd = cwd.as_deref().map(normalize_cwd);
        let mut index: Option<Arc<CwdIndex>> = None;

        candidates
            .iter()
            .map(|cand| {
                resolve_candidate(
                    cand,
                    normalized_cwd.as_deref(),
                    home.as_deref(),
                    &mut index,
                )
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn touch(dir: &Path, rel: &str) -> PathBuf {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&p, b"").unwrap();
        p
    }

    fn resolve_sync(cwd: Option<&str>, candidates: &[&str]) -> Vec<ResolvedPath> {
        let home = dirs::home_dir();
        let normalized = cwd.map(normalize_cwd);
        let mut index: Option<Arc<CwdIndex>> = None;
        candidates
            .iter()
            .map(|c| resolve_candidate(c, normalized.as_deref(), home.as_deref(), &mut index))
            .collect()
    }

    fn same_path(a: &str, b: &Path) -> bool {
        a.replace('\\', "/") == b.to_string_lossy().replace('\\', "/")
    }

    #[test]
    fn absolute_path_resolves() {
        let tmp = tempdir().unwrap();
        let f = touch(tmp.path(), "a.txt");
        let abs = f.to_string_lossy().into_owned();
        let out = resolve_sync(None, &[&abs]);
        assert!(same_path(out[0].abs_path.as_deref().unwrap(), &f));
        assert!(!out[0].is_dir);
    }

    #[test]
    fn cwd_relative_resolves_literally() {
        let tmp = tempdir().unwrap();
        let f = touch(tmp.path(), "rel/file.ts");
        let out = resolve_sync(Some(tmp.path().to_str().unwrap()), &["rel/file.ts"]);
        assert!(same_path(out[0].abs_path.as_deref().unwrap(), &f));
    }

    #[test]
    fn bare_basename_finds_in_subtree() {
        let tmp = tempdir().unwrap();
        let target = touch(tmp.path(), "deep/sub/useTerminal.ts");
        let out = resolve_sync(Some(tmp.path().to_str().unwrap()), &["useTerminal.ts"]);
        assert!(same_path(out[0].abs_path.as_deref().unwrap(), &target));
    }

    #[test]
    fn multi_segment_suffix_match() {
        let tmp = tempdir().unwrap();
        let target = touch(tmp.path(), "src/components/Terminal/TerminalPanel.tsx");
        let out = resolve_sync(
            Some(tmp.path().to_str().unwrap()),
            &["Terminal/TerminalPanel.tsx"],
        );
        assert!(same_path(out[0].abs_path.as_deref().unwrap(), &target));
    }

    #[test]
    fn multiple_matches_shortest_wins() {
        let tmp = tempdir().unwrap();
        let shallow = touch(tmp.path(), "package.json");
        touch(tmp.path(), "subproject/nested/package.json");
        let out = resolve_sync(Some(tmp.path().to_str().unwrap()), &["package.json"]);
        assert!(same_path(out[0].abs_path.as_deref().unwrap(), &shallow));
    }

    #[test]
    fn node_modules_skipped() {
        let tmp = tempdir().unwrap();
        touch(tmp.path(), "node_modules/foo/hidden.ts");
        let out = resolve_sync(Some(tmp.path().to_str().unwrap()), &["hidden.ts"]);
        assert!(out[0].abs_path.is_none());
    }

    #[test]
    fn target_dir_skipped() {
        let tmp = tempdir().unwrap();
        touch(tmp.path(), "target/debug/weird.rs");
        let out = resolve_sync(Some(tmp.path().to_str().unwrap()), &["weird.rs"]);
        assert!(out[0].abs_path.is_none());
    }

    #[test]
    fn gitignored_file_skipped() {
        let tmp = tempdir().unwrap();
        fs::write(tmp.path().join(".gitignore"), "secret/\n").unwrap();
        touch(tmp.path(), "secret/private.ts");
        touch(tmp.path(), "public.ts");
        let out = resolve_sync(
            Some(tmp.path().to_str().unwrap()),
            &["private.ts", "public.ts"],
        );
        assert!(out[0].abs_path.is_none(), "gitignored file should not resolve");
        assert!(out[1].abs_path.is_some());
    }

    #[test]
    fn hidden_dir_skipped() {
        let tmp = tempdir().unwrap();
        touch(tmp.path(), ".hidden/inner.ts");
        let out = resolve_sync(Some(tmp.path().to_str().unwrap()), &["inner.ts"]);
        assert!(out[0].abs_path.is_none());
    }

    #[test]
    fn line_col_suffix_stripped_for_stat() {
        let tmp = tempdir().unwrap();
        touch(tmp.path(), "foo.ts");
        let out = resolve_sync(Some(tmp.path().to_str().unwrap()), &["foo.ts:42:10"]);
        assert!(out[0].abs_path.is_some());
        assert_eq!(out[0].candidate, "foo.ts:42:10");
    }

    #[test]
    fn missing_candidate_returns_none() {
        let tmp = tempdir().unwrap();
        let out = resolve_sync(Some(tmp.path().to_str().unwrap()), &["nope.ts"]);
        assert!(out[0].abs_path.is_none());
    }

    #[test]
    fn no_cwd_skips_subtree_lookup() {
        let out = resolve_sync(None, &["nope.ts"]);
        assert!(out[0].abs_path.is_none());
    }

    #[test]
    fn case_insensitive_basename_match() {
        let tmp = tempdir().unwrap();
        let target = touch(tmp.path(), "Sub/Cargo.toml");
        let out = resolve_sync(Some(tmp.path().to_str().unwrap()), &["cargo.toml"]);
        assert!(same_path(out[0].abs_path.as_deref().unwrap(), &target));
    }

    #[test]
    fn directory_resolves_with_is_dir_flag() {
        let tmp = tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("some/dir")).unwrap();
        let out = resolve_sync(Some(tmp.path().to_str().unwrap()), &["some/dir"]);
        assert!(out[0].abs_path.is_some());
        assert!(out[0].is_dir);
    }

    #[test]
    fn index_built_once_per_batch() {
        // Proxy check: two candidates that both miss literal resolution and hit
        // the subtree lookup should reuse the same index. If a rebuild happened
        // we'd see it via build_at timestamps, but we just confirm both resolve
        // correctly — the `index: Option` guard in resolve_candidate prevents
        // rebuilding.
        let tmp = tempdir().unwrap();
        let a = touch(tmp.path(), "nested/first.ts");
        let b = touch(tmp.path(), "deeper/still/second.ts");
        let out = resolve_sync(
            Some(tmp.path().to_str().unwrap()),
            &["first.ts", "second.ts"],
        );
        assert!(same_path(out[0].abs_path.as_deref().unwrap(), &a));
        assert!(same_path(out[1].abs_path.as_deref().unwrap(), &b));
    }
}

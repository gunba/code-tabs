use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// Resolve the original working directory for a Claude projects folder.
///
/// Strategy (in priority order):
/// 1. Read the `cwd` field from a JSONL file in the directory — this is the real,
///    unencoded path that Claude Code wrote when the session was created. Works even
///    for sessions created on other machines.
/// 2. Fall back to filesystem-probing decode (the old heuristic). This only works
///    when the target path exists on the local machine.
pub fn resolve_project_dir(encoded_name: &str, project_dir: &Path) -> String {
    // Try reading cwd from any JSONL file in the directory
    if let Ok(entries) = std::fs::read_dir(project_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                if let Some(cwd) = extract_cwd_from_jsonl(&path) {
                    return cwd;
                }
            }
        }
    }
    // Fallback: lossy filesystem-probing decode
    decode_project_dir_heuristic(encoded_name)
}

/// Extract the working directory from a JSONL file by reading the `cwd` field
/// from early events. Returns None if not found within the first 20 lines.
fn extract_cwd_from_jsonl(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().take(20) {
        let Ok(line) = line else {
            continue;
        };
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
            if let Some(cwd) = parsed["cwd"].as_str() {
                if !cwd.is_empty() {
                    return Some(cwd.to_string());
                }
            }
        }
    }
    None
}

/// Fallback decoder: guess the original path by probing the filesystem.
///
/// Claude's encoding is lossy (periods, spaces, slashes all become '-'), so we
/// resolve ambiguity by walking the filesystem and checking which candidate paths
/// actually exist. This fails when the original path doesn't exist locally (e.g.,
/// sessions from a different machine).
fn decode_project_dir_heuristic(encoded: &str) -> String {
    // Split drive letter on Windows: "C--Users-..." → ("C:\", "Users-...")
    let (prefix, segments_str) = if let Some((drive, rest)) = encoded.split_once("--") {
        (format!("{}:\\", drive), rest)
    } else {
        ("/".to_string(), encoded)
    };

    let parts: Vec<&str> = segments_str.split('-').collect();
    if parts.is_empty() {
        return prefix;
    }

    // Greedy filesystem walk: at each position, try joining multiple parts
    // with non-slash separators (period, hyphen, space) and check if the
    // resulting directory exists. Uses longest match first to handle names
    // like "Jordan.Graham" (2 parts joined with '.') correctly.
    let mut current = PathBuf::from(&prefix);
    let mut i = 0;

    while i < parts.len() {
        let mut matched = false;

        // Try multi-part names (longest first), with each separator
        let max_j = std::cmp::min(i + 6, parts.len());
        for j in (i + 2..=max_j).rev() {
            for sep in &[".", "-", " "] {
                let candidate = current.join(parts[i..j].join(sep));
                if candidate.exists() {
                    current = candidate;
                    i = j;
                    matched = true;
                    break;
                }
            }
            if matched {
                break;
            }
        }

        if !matched {
            // Single part as path segment
            current = current.join(parts[i]);
            i += 1;
        }
    }

    current.to_string_lossy().to_string()
}

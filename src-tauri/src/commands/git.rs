/// Check whether a directory is inside a git work tree.
#[tauri::command]
pub async fn git_repo_check(working_dir: String) -> bool {
    tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("git");
        cmd.args(["rev-parse", "--is-inside-work-tree"])
            .current_dir(&working_dir);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        cmd.output().map(|o| o.status.success()).unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

#[derive(serde::Serialize, Debug, Clone)]
pub struct GitChange {
    pub path: String,
    pub status: String,
}

/// [RC-21] List uncommitted changes via `git status --porcelain=v1 -z`.
/// Returns absolute paths (joined to working_dir) plus a single-letter status:
/// M=modified, A=added, D=deleted, R=renamed, ?=untracked.
/// Empty result on error or non-repo (caller should gate via git_repo_check first).
#[tauri::command]
pub async fn git_list_changes(working_dir: String) -> Vec<GitChange> {
    tokio::task::spawn_blocking(move || -> Vec<GitChange> {
        let mut cmd = std::process::Command::new("git");
        cmd.args(["status", "--porcelain=v1", "-z"])
            .current_dir(&working_dir);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let output = match cmd.output() {
            Ok(o) if o.status.success() => o,
            _ => return Vec::new(),
        };
        parse_porcelain(&output.stdout, &working_dir)
    })
    .await
    .unwrap_or_default()
}

fn parse_porcelain(stdout: &[u8], working_dir: &str) -> Vec<GitChange> {
    let mut out = Vec::new();
    let bytes = stdout;
    let mut i = 0;
    while i < bytes.len() {
        if bytes.len() - i < 3 {
            break;
        }
        let xy = &bytes[i..i + 2];
        if bytes[i + 2] != b' ' {
            break;
        }
        let mut j = i + 3;
        while j < bytes.len() && bytes[j] != 0 {
            j += 1;
        }
        let path_bytes = &bytes[i + 3..j];
        let path = match std::str::from_utf8(path_bytes) {
            Ok(s) => s.to_string(),
            Err(_) => {
                i = j + 1;
                continue;
            }
        };
        let status = derive_status(xy);
        let mut joined = std::path::PathBuf::from(working_dir);
        joined.push(&path);
        let abs = joined.to_string_lossy().replace('\\', "/");
        out.push(GitChange { path: abs, status });
        i = j + 1;
        // Renames have a second NUL-terminated path (the source); skip it.
        if xy[0] == b'R' || xy[0] == b'C' {
            let mut k = i;
            while k < bytes.len() && bytes[k] != 0 {
                k += 1;
            }
            i = k + 1;
        }
    }
    out
}

fn derive_status(xy: &[u8]) -> String {
    let x = xy[0];
    let y = xy[1];
    let ch = match (x, y) {
        (b'?', b'?') => '?',
        (b'D', _) | (_, b'D') => 'D',
        (b'A', _) | (_, b'A') => 'A',
        (b'R', _) | (_, b'R') => 'R',
        (b'C', _) | (_, b'C') => 'C',
        (b'M', _) | (_, b'M') => 'M',
        _ => 'M',
    };
    ch.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_porcelain() {
        let stdout = b" M src/foo.rs\0?? new.txt\0 D removed.rs\0";
        let changes = parse_porcelain(stdout, "/proj");
        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0].path, "/proj/src/foo.rs");
        assert_eq!(changes[0].status, "M");
        assert_eq!(changes[1].path, "/proj/new.txt");
        assert_eq!(changes[1].status, "?");
        assert_eq!(changes[2].path, "/proj/removed.rs");
        assert_eq!(changes[2].status, "D");
    }

    #[test]
    fn parses_rename_with_second_path() {
        let stdout = b"R  new-name.rs\0old-name.rs\0 M other.rs\0";
        let changes = parse_porcelain(stdout, "/proj");
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].path, "/proj/new-name.rs");
        assert_eq!(changes[0].status, "R");
        assert_eq!(changes[1].path, "/proj/other.rs");
    }

    #[test]
    fn empty_input_returns_empty() {
        assert!(parse_porcelain(b"", "/proj").is_empty());
    }
}

// [RC-19] git worktree remove --force (always forced — dialog is the confirmation)
/// Remove a git worktree directory.
#[tauri::command]
pub async fn prune_worktree(worktree_path: String, project_root: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let args = vec!["worktree", "remove", "--force", &worktree_path];

        let mut cmd = std::process::Command::new("git");
        cmd.args(&args).current_dir(&project_root);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run git: {e}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

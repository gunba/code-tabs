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

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub path: String,
    pub kind: &'static str,
}

// [RC-21] git_list_changes: passive git-backed change detection. Replaces the old notify-based
// per-directory inotify watcher. Runs `git status --porcelain=v1 -z` in working_dir; returns
// empty Vec when not a git repo or git fails. Called on settled-idle in useTapEventProcessor,
// so any tracked-file change that TAP didn't explicitly report (bash side-effects, external
// edits) shows in the activity panel. Paths are absolutized against working_dir.
/// List uncommitted changes in a working directory via git status. Returns empty if not a
/// git repo or git is unavailable.
#[tauri::command]
pub async fn git_list_changes(working_dir: String) -> Vec<GitChange> {
    tokio::task::spawn_blocking(move || run_git_status(&working_dir))
        .await
        .unwrap_or_default()
}

fn run_git_status(working_dir: &str) -> Vec<GitChange> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(["status", "--porcelain", "-z"])
        .current_dir(working_dir);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let output = match cmd.output() {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };

    let root = std::path::Path::new(working_dir);
    let mut changes = Vec::new();
    let mut iter = output.stdout.split(|&b| b == 0).filter(|s| !s.is_empty());
    while let Some(rec) = iter.next() {
        if rec.len() < 3 {
            continue;
        }
        let xy = &rec[..2];
        // Rename: "R  new\0old" — consume and skip the old path.
        let is_rename = xy[0] == b'R' || xy[0] == b'C';
        let path_bytes = &rec[3..];
        if is_rename {
            let _ = iter.next();
        }
        let kind = classify(xy);
        if kind.is_empty() {
            continue;
        }
        let rel = match std::str::from_utf8(path_bytes) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let abs = root.join(rel).to_string_lossy().to_string();
        changes.push(GitChange { path: abs, kind });
    }
    changes
}

fn classify(xy: &[u8]) -> &'static str {
    // Porcelain XY columns: X = index status, Y = working-tree status.
    // Precedence: deletion wins (tracked file gone), then creation (staged-add — possibly
    // also modified in worktree), then modified/renamed/copied, else unknown.
    if xy == b"??" {
        return "created";
    }
    if xy.contains(&b'D') {
        return "deleted";
    }
    if xy[0] == b'A' {
        return "created";
    }
    if xy.contains(&b'M') || xy[0] == b'R' || xy[0] == b'C' {
        return "modified";
    }
    ""
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

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
        cmd.output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

/// Raw git status + numstat output for the diff panel.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusRaw {
    pub porcelain: String,
    pub numstat: String,
    pub numstat_staged: String,
}

fn run_git(working_dir: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args).current_dir(working_dir);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let output = cmd.output().map_err(|e| format!("Failed to run git: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Return porcelain status + numstat for staged and unstaged changes.
#[tauri::command]
pub async fn git_status(working_dir: String) -> Result<GitStatusRaw, String> {
    tokio::task::spawn_blocking(move || {
        let porcelain = run_git(&working_dir, &["status", "--porcelain", "-b"])?;
        let numstat = run_git(&working_dir, &["diff", "--numstat"]).unwrap_or_default();
        let numstat_staged =
            run_git(&working_dir, &["diff", "--numstat", "--cached"]).unwrap_or_default();
        Ok(GitStatusRaw {
            porcelain,
            numstat,
            numstat_staged,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

const MAX_DIFF_BYTES: usize = 500 * 1024;

/// Return unified diff for a single file. Truncated at 500 KB.
/// For untracked files, uses `--no-index` to show full content as additions.
#[tauri::command]
pub async fn git_diff_file(
    working_dir: String,
    file_path: String,
    staged: bool,
    untracked: Option<bool>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let raw = if untracked.unwrap_or(false) {
            // Untracked files: diff against /dev/null to show all lines as additions.
            // --no-index always exits 1 on diff, so ignore exit code.
            let mut cmd = std::process::Command::new("git");
            cmd.args(["diff", "--no-index", "--", "/dev/null", &file_path])
                .current_dir(&working_dir);
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000);
            }
            let output = cmd.output().map_err(|e| format!("Failed to run git: {e}"))?;
            String::from_utf8_lossy(&output.stdout).to_string()
        } else {
            let mut args = vec!["diff"];
            if staged {
                args.push("--cached");
            }
            args.push("--");
            args.push(&file_path);
            run_git(&working_dir, &args)?
        };
        if raw.len() > MAX_DIFF_BYTES {
            let mut truncated = raw[..MAX_DIFF_BYTES].to_string();
            truncated.push_str("\n[truncated]");
            Ok(truncated)
        } else {
            Ok(raw)
        }
    })
    .await
    .map_err(|e| e.to_string())?
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
        let output = cmd.output().map_err(|e| format!("Failed to run git: {e}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    }).await.map_err(|e| e.to_string())?
}

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

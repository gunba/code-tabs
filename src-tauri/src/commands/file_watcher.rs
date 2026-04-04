use std::path::PathBuf;
use tauri::{AppHandle, State};
use crate::file_watcher::FileWatcherState;

const MAX_SNAPSHOT_BYTES: usize = 500 * 1024;

#[tauri::command]
pub async fn start_file_watcher(
    app: AppHandle,
    session_id: String,
    root_dir: String,
    state: State<'_, FileWatcherState>,
) -> Result<(), String> {
    let root = PathBuf::from(&root_dir);
    if !root.is_dir() {
        return Err(format!("Directory does not exist: {root_dir}"));
    }
    crate::file_watcher::start_watcher(app, session_id, root, &state)
}

#[tauri::command]
pub async fn stop_file_watcher(
    session_id: String,
    state: State<'_, FileWatcherState>,
) -> Result<(), String> {
    crate::file_watcher::stop_watcher(&session_id, &state)
}

#[tauri::command]
pub async fn add_watch_path(
    session_id: String,
    path: String,
    state: State<'_, FileWatcherState>,
) -> Result<(), String> {
    let p = PathBuf::from(&path);
    crate::file_watcher::add_watch_path(&session_id, &p, &state)
}

#[tauri::command]
pub async fn compute_file_diff(
    file_path: String,
    before_content: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let current = std::fs::read_to_string(&file_path)
            .map_err(|e| format!("Failed to read file: {e}"))?;

        let old = before_content.as_deref().unwrap_or("");

        if old == current {
            return Ok(String::new());
        }

        let diff = similar::TextDiff::from_lines(old, &current);
        let display_path = file_path.replace('\\', "/");
        let header_a = format!("a/{display_path}");
        let header_b = format!("b/{display_path}");

        Ok(diff
            .unified_diff()
            .context_radius(3)
            .header(&header_a, &header_b)
            .to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_file_for_snapshot(file_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let metadata = std::fs::metadata(&file_path)
            .map_err(|e| format!("Failed to stat file: {e}"))?;

        if metadata.len() > MAX_SNAPSHOT_BYTES as u64 {
            return Err(format!(
                "File too large for snapshot ({} bytes, max {})",
                metadata.len(),
                MAX_SNAPSHOT_BYTES
            ));
        }

        let content = std::fs::read(&file_path)
            .map_err(|e| format!("Failed to read file: {e}"))?;

        // Check if binary (contains null bytes in first 8KB)
        let check_len = content.len().min(8192);
        if content[..check_len].contains(&0) {
            return Err("Binary file, cannot snapshot".into());
        }

        String::from_utf8(content).map_err(|_| "File is not valid UTF-8".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

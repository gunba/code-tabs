use crate::file_watcher::FileWatcherState;
use crate::observability::{
    record_backend_event, record_backend_perf_end, record_backend_perf_fail,
    record_backend_perf_start,
};
use std::path::PathBuf;
use tauri::{AppHandle, State};

const MAX_SNAPSHOT_BYTES: usize = 500 * 1024;

#[tauri::command]
pub async fn start_file_watcher(
    app: AppHandle,
    session_id: String,
    root_dir: String,
    state: State<'_, FileWatcherState>,
) -> Result<(), String> {
    let span_start = std::time::Instant::now();
    let span_data = serde_json::json!({
        "rootDir": root_dir,
    });
    record_backend_perf_start(
        &app,
        "watcher",
        Some(&session_id),
        "watcher.start",
        span_data.clone(),
    );
    let root = PathBuf::from(&root_dir);
    if !root.is_dir() {
        let err = format!("Directory does not exist: {root_dir}");
        record_backend_perf_fail(
            &app,
            "watcher",
            Some(&session_id),
            "watcher.start",
            span_start,
            span_data,
            serde_json::json!({}),
            &err,
        );
        return Err(err);
    }
    match crate::file_watcher::start_watcher(app.clone(), session_id.clone(), root, &state) {
        Ok(()) => {
            record_backend_perf_end(
                &app,
                "watcher",
                Some(&session_id),
                "watcher.start",
                span_start,
                250,
                span_data,
                serde_json::json!({}),
            );
            Ok(())
        }
        Err(err) => {
            record_backend_perf_fail(
                &app,
                "watcher",
                Some(&session_id),
                "watcher.start",
                span_start,
                span_data,
                serde_json::json!({}),
                &err,
            );
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn stop_file_watcher(
    session_id: String,
    state: State<'_, FileWatcherState>,
    app: AppHandle,
) -> Result<(), String> {
    let span_start = std::time::Instant::now();
    let span_data = serde_json::json!({});
    record_backend_perf_start(
        &app,
        "watcher",
        Some(&session_id),
        "watcher.stop",
        span_data.clone(),
    );
    match crate::file_watcher::stop_watcher(&session_id, &state) {
        Ok(()) => {
            record_backend_event(
                &app,
                "LOG",
                "watcher",
                Some(&session_id),
                "watcher.stopped",
                "Stopped file watcher",
                serde_json::json!({}),
            );
            record_backend_perf_end(
                &app,
                "watcher",
                Some(&session_id),
                "watcher.stop",
                span_start,
                250,
                span_data,
                serde_json::json!({}),
            );
            Ok(())
        }
        Err(err) => {
            record_backend_perf_fail(
                &app,
                "watcher",
                Some(&session_id),
                "watcher.stop",
                span_start,
                span_data,
                serde_json::json!({}),
                &err,
            );
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn add_watch_path(
    session_id: String,
    path: String,
    state: State<'_, FileWatcherState>,
    app: AppHandle,
) -> Result<(), String> {
    let span_start = std::time::Instant::now();
    let span_data = serde_json::json!({ "path": path });
    record_backend_perf_start(
        &app,
        "watcher",
        Some(&session_id),
        "watcher.add_path",
        span_data.clone(),
    );
    let p = PathBuf::from(&path);
    match crate::file_watcher::add_watch_path(&session_id, &p, &state) {
        Ok(()) => {
            record_backend_event(
                &app,
                "DEBUG",
                "watcher",
                Some(&session_id),
                "watcher.path_added",
                "Added explicit watch path",
                serde_json::json!({ "path": path }),
            );
            record_backend_perf_end(
                &app,
                "watcher",
                Some(&session_id),
                "watcher.add_path",
                span_start,
                250,
                span_data,
                serde_json::json!({}),
            );
            Ok(())
        }
        Err(err) => {
            record_backend_perf_fail(
                &app,
                "watcher",
                Some(&session_id),
                "watcher.add_path",
                span_start,
                span_data,
                serde_json::json!({}),
                &err,
            );
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn compute_file_diff(
    file_path: String,
    before_content: Option<String>,
    app: AppHandle,
) -> Result<String, String> {
    let span_start = std::time::Instant::now();
    let span_data = serde_json::json!({ "filePath": file_path });
    record_backend_perf_start(
        &app,
        "watcher",
        None,
        "watcher.compute_diff",
        span_data.clone(),
    );
    let result = tokio::task::spawn_blocking(move || {
        let current =
            std::fs::read_to_string(&file_path).map_err(|e| format!("Failed to read file: {e}"))?;

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
    .map_err(|e| e.to_string())?;
    match result {
        Ok(diff) => {
            record_backend_perf_end(
                &app,
                "watcher",
                None,
                "watcher.compute_diff",
                span_start,
                500,
                span_data,
                serde_json::json!({
                    "diffLength": diff.len(),
                }),
            );
            Ok(diff)
        }
        Err(err) => {
            record_backend_perf_fail(
                &app,
                "watcher",
                None,
                "watcher.compute_diff",
                span_start,
                span_data,
                serde_json::json!({}),
                &err,
            );
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn read_file_for_snapshot(file_path: String, app: AppHandle) -> Result<String, String> {
    let span_start = std::time::Instant::now();
    let span_data = serde_json::json!({ "filePath": file_path });
    record_backend_perf_start(
        &app,
        "watcher",
        None,
        "watcher.read_snapshot",
        span_data.clone(),
    );
    let result = tokio::task::spawn_blocking(move || {
        let metadata =
            std::fs::metadata(&file_path).map_err(|e| format!("Failed to stat file: {e}"))?;

        if metadata.len() > MAX_SNAPSHOT_BYTES as u64 {
            return Err(format!(
                "File too large for snapshot ({} bytes, max {})",
                metadata.len(),
                MAX_SNAPSHOT_BYTES
            ));
        }

        let content = std::fs::read(&file_path).map_err(|e| format!("Failed to read file: {e}"))?;

        // Check if binary (contains null bytes in first 8KB)
        let check_len = content.len().min(8192);
        if content[..check_len].contains(&0) {
            return Err("Binary file, cannot snapshot".into());
        }

        String::from_utf8(content).map_err(|_| "File is not valid UTF-8".into())
    })
    .await
    .map_err(|e| e.to_string())?;
    match result {
        Ok(content) => {
            record_backend_perf_end(
                &app,
                "watcher",
                None,
                "watcher.read_snapshot",
                span_start,
                500,
                span_data,
                serde_json::json!({
                    "contentLength": content.len(),
                }),
            );
            Ok(content)
        }
        Err(err) => {
            record_backend_perf_fail(
                &app,
                "watcher",
                None,
                "watcher.read_snapshot",
                span_start,
                span_data,
                serde_json::json!({}),
                &err,
            );
            Err(err)
        }
    }
}

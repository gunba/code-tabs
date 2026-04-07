use serde::Serialize;
use serde_json::{json, Value};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::data::{get_data_dir, get_session_data_dir, reveal_path};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservabilityInfo {
    debug_build: bool,
    observability_enabled: bool,
    devtools_available: bool,
    global_log_path: Option<String>,
}

fn observability_enabled() -> bool {
    cfg!(debug_assertions)
}

fn observability_path(session_id: Option<&str>) -> Result<std::path::PathBuf, String> {
    if let Some(session_id) = session_id {
        return Ok(get_session_data_dir(session_id)?.join("observability.jsonl"));
    }

    let dir = get_data_dir()?.join("observability");
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create observability dir: {e}"))?;
    }
    Ok(dir.join("app.jsonl"))
}

fn append_lines(session_id: Option<&str>, lines: &str) -> Result<u64, String> {
    let path = observability_path(session_id)?;
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open observability log: {e}"))?;
    file.write_all(lines.as_bytes())
        .map_err(|e| format!("Failed to write observability log: {e}"))?;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(meta.len())
}

#[tauri::command]
pub fn get_observability_info() -> Result<ObservabilityInfo, String> {
    let enabled = observability_enabled();
    let global_log_path = if enabled {
        Some(
            observability_path(None)?
                .to_string_lossy()
                .to_string(),
        )
    } else {
        None
    };

    Ok(ObservabilityInfo {
        debug_build: cfg!(debug_assertions),
        observability_enabled: enabled,
        devtools_available: enabled,
        global_log_path,
    })
}

#[tauri::command]
pub fn append_observability_data(
    session_id: Option<String>,
    lines: String,
) -> Result<u64, String> {
    if !observability_enabled() {
        return Ok(0);
    }
    append_lines(session_id.as_deref(), &lines)
}

#[tauri::command]
pub fn open_observability_log(app: AppHandle, session_id: Option<String>) -> Result<(), String> {
    let path = observability_path(session_id.as_deref())?;
    if !path.exists() {
        return Err("No observability log exists for this scope".into());
    }
    record_backend_event(
        &app,
        "LOG",
        "observability",
        session_id.as_deref(),
        "observability.log_revealed",
        "Revealing observability log",
        json!({
            "path": path.to_string_lossy().to_string(),
        }),
    );
    reveal_path(&path)
}

#[tauri::command]
pub fn open_main_devtools(app: AppHandle) -> Result<(), String> {
    #[cfg(not(debug_assertions))]
    {
        let _ = app;
        return Err("Devtools are only available in debug builds".into());
    }
    #[cfg(debug_assertions)]
    {
        record_backend_event(
            &app,
            "LOG",
            "app",
            None,
            "app.devtools_open",
            "Opening main webview devtools",
            json!({}),
        );
        let window = app
            .get_webview_window("main")
            .ok_or("Main window not found")?;
        window.open_devtools();
        let _ = window.set_focus();
        Ok(())
    }
}

pub fn record_backend_event(
    app: &AppHandle,
    level: &str,
    module: &str,
    session_id: Option<&str>,
    event: &str,
    message: &str,
    data: Value,
) {
    if !observability_enabled() {
        return;
    }

    let now = chrono::Utc::now();
    let entry = json!({
        "ts": now.timestamp_millis(),
        "tsIso": now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "level": level,
        "module": module,
        "source": "backend",
        "sessionId": session_id,
        "event": event,
        "message": message,
        "data": data,
    });

    if let Ok(line) = serde_json::to_string(&entry) {
        let _ = append_lines(session_id, &(line + "\n"));
    }
    let _ = app.emit("observability-entry", entry);
}

// [DP-15] Backend perf.span helpers mirror the frontend perfTrace schema so
// timings from Rust commands and proxy/watcher paths filter alongside app logs.
fn perf_payload(
    name: &str,
    status: &str,
    duration_ms: Option<u64>,
    span_data: Value,
    extra_data: Value,
    error: Option<String>,
) -> Value {
    let mut data = serde_json::Map::new();
    data.insert("name".into(), Value::String(name.to_string()));
    data.insert("status".into(), Value::String(status.to_string()));
    if let Some(duration_ms) = duration_ms {
        data.insert("durationMs".into(), Value::Number(duration_ms.into()));
    }
    if !span_data.is_null() {
        data.insert("spanData".into(), span_data);
    }
    if !extra_data.is_null() {
        data.insert("extraData".into(), extra_data);
    }
    if let Some(error) = error {
        data.insert("error".into(), Value::String(error));
    }
    Value::Object(data)
}

pub fn record_backend_perf_start(
    app: &AppHandle,
    module: &str,
    session_id: Option<&str>,
    name: &str,
    span_data: Value,
) {
    record_backend_event(
        app,
        "DEBUG",
        module,
        session_id,
        "perf.span",
        &format!("{name} [start]"),
        perf_payload(name, "start", None, span_data, Value::Null, None),
    );
}

pub fn record_backend_perf_end(
    app: &AppHandle,
    module: &str,
    session_id: Option<&str>,
    name: &str,
    start: Instant,
    warn_above_ms: u64,
    span_data: Value,
    extra_data: Value,
) -> u64 {
    let duration_ms = start.elapsed().as_millis() as u64;
    let level = if duration_ms >= warn_above_ms {
        "WARN"
    } else {
        "DEBUG"
    };
    record_backend_event(
        app,
        level,
        module,
        session_id,
        "perf.span",
        &format!("{name} [done]"),
        perf_payload(name, "done", Some(duration_ms), span_data, extra_data, None),
    );
    duration_ms
}

pub fn record_backend_perf_fail(
    app: &AppHandle,
    module: &str,
    session_id: Option<&str>,
    name: &str,
    start: Instant,
    span_data: Value,
    extra_data: Value,
    error: impl ToString,
) -> u64 {
    let duration_ms = start.elapsed().as_millis() as u64;
    record_backend_event(
        app,
        "ERR",
        module,
        session_id,
        "perf.span",
        &format!("{name} [FAIL]"),
        perf_payload(
            name,
            "fail",
            Some(duration_ms),
            span_data,
            extra_data,
            Some(error.to_string()),
        ),
    );
    duration_ms
}

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{mpsc, Once, OnceLock};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::data::{get_data_dir, get_session_data_dir, reveal_path};

pub mod codex_rollout;

const LOG_ROTATE_BYTES: u64 = 50 * 1024 * 1024;
const LOG_ROTATE_KEEP: usize = 3;
const WRITER_FLUSH_BYTES: usize = 64 * 1024;

static OBSERVABILITY_RUNTIME_ENABLED: AtomicBool = AtomicBool::new(false);
static OBSERVABILITY_INIT: Once = Once::new();
static OBSERVABILITY_MIN_LEVEL: AtomicU8 = AtomicU8::new(10);
static DEVTOOLS_RUNTIME_ENABLED: AtomicBool = AtomicBool::new(false);
static DEVTOOLS_INIT: Once = Once::new();
static WRITER_POOL: OnceLock<WriterPool> = OnceLock::new();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservabilityInfo {
    observability_enabled: bool,
    runtime_override: bool,
    devtools_enabled: bool,
    global_log_path: Option<String>,
    global_log_size: u64,
    global_rotation_count: usize,
    min_level: &'static str,
}

struct WriterPool {
    tx: mpsc::Sender<WriterMessage>,
}

enum WriterMessage {
    Append { path: PathBuf, bytes: Vec<u8> },
    Flush(mpsc::Sender<()>),
    Shutdown(mpsc::Sender<()>),
}

struct WriterState {
    writer: std::io::BufWriter<std::fs::File>,
    size: u64,
    buffered: usize,
}

impl WriterPool {
    fn new() -> Self {
        let (tx, rx) = mpsc::channel::<WriterMessage>();
        std::thread::Builder::new()
            .name("code-tabs-observability-writer".into())
            .spawn(move || writer_loop(rx))
            .expect("observability writer thread must start");
        Self { tx }
    }

    fn append(&self, path: PathBuf, bytes: Vec<u8>) -> Result<u64, String> {
        let len = bytes.len() as u64;
        self.tx
            .send(WriterMessage::Append { path, bytes })
            .map_err(|e| format!("observability writer closed: {e}"))?;
        Ok(len)
    }

    fn flush(&self) {
        let (ack_tx, ack_rx) = mpsc::channel();
        if self.tx.send(WriterMessage::Flush(ack_tx)).is_ok() {
            let _ = ack_rx.recv();
        }
    }

    fn shutdown(&self) {
        let (ack_tx, ack_rx) = mpsc::channel();
        if self.tx.send(WriterMessage::Shutdown(ack_tx)).is_ok() {
            let _ = ack_rx.recv();
        }
    }
}

fn writer_pool() -> &'static WriterPool {
    WRITER_POOL.get_or_init(WriterPool::new)
}

fn writer_loop(rx: mpsc::Receiver<WriterMessage>) {
    let mut writers: HashMap<PathBuf, WriterState> = HashMap::new();
    while let Ok(message) = rx.recv() {
        match message {
            WriterMessage::Append { path, bytes } => {
                let _ = append_with_writer(&mut writers, path, &bytes);
            }
            WriterMessage::Flush(ack) => {
                flush_writers(&mut writers);
                let _ = ack.send(());
            }
            WriterMessage::Shutdown(ack) => {
                flush_writers(&mut writers);
                writers.clear();
                let _ = ack.send(());
                break;
            }
        }
    }
}

fn flush_writers(writers: &mut HashMap<PathBuf, WriterState>) {
    for state in writers.values_mut() {
        let _ = state.writer.flush();
        state.buffered = 0;
    }
}

fn append_with_writer(
    writers: &mut HashMap<PathBuf, WriterState>,
    path: PathBuf,
    bytes: &[u8],
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create observability dir: {e}"))?;
    }

    let needs_rotation = writers
        .get(&path)
        .map(|state| state.size.saturating_add(bytes.len() as u64) > LOG_ROTATE_BYTES)
        .unwrap_or_else(|| {
            std::fs::metadata(&path)
                .map(|meta| meta.len().saturating_add(bytes.len() as u64) > LOG_ROTATE_BYTES)
                .unwrap_or(false)
        });
    if needs_rotation {
        if let Some(mut state) = writers.remove(&path) {
            let _ = state.writer.flush();
        }
        rotate_log_file(&path);
    }

    if !writers.contains_key(&path) {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("Failed to open observability log: {e}"))?;
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        writers.insert(
            path.clone(),
            WriterState {
                writer: std::io::BufWriter::new(file),
                size,
                buffered: 0,
            },
        );
    }

    let state = writers
        .get_mut(&path)
        .ok_or("observability writer missing after open")?;
    state
        .writer
        .write_all(bytes)
        .map_err(|e| format!("Failed to write observability log: {e}"))?;
    state.size = state.size.saturating_add(bytes.len() as u64);
    state.buffered = state.buffered.saturating_add(bytes.len());
    if state.buffered >= WRITER_FLUSH_BYTES {
        let _ = state.writer.flush();
        state.buffered = 0;
    }
    Ok(())
}

fn rotated_path(path: &Path, index: usize) -> PathBuf {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_default();
    path.with_file_name(format!("{file_name}.{index}"))
}

fn rotate_log_file(path: &Path) {
    let _ = std::fs::remove_file(rotated_path(path, LOG_ROTATE_KEEP));
    for index in (1..LOG_ROTATE_KEEP).rev() {
        let from = rotated_path(path, index);
        let to = rotated_path(path, index + 1);
        if from.exists() {
            let _ = std::fs::rename(from, to);
        }
    }
    if path.exists() {
        let _ = std::fs::rename(path, rotated_path(path, 1));
    }
}

fn rotated_file_count(path: &Path) -> usize {
    (1..=LOG_ROTATE_KEEP)
        .filter(|index| rotated_path(path, *index).exists())
        .count()
}

fn level_value(level: &str) -> u8 {
    match level {
        "DEBUG" => 10,
        "LOG" => 20,
        "WARN" => 30,
        "ERR" => 40,
        _ => 20,
    }
}

fn level_name(value: u8) -> &'static str {
    match value {
        10 => "DEBUG",
        20 => "LOG",
        30 => "WARN",
        40 => "ERR",
        _ => "LOG",
    }
}

fn env_observability_enabled() -> bool {
    std::env::var("CODE_TABS_OBSERVABILITY")
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "on"))
        .unwrap_or(false)
}

fn env_min_level() -> u8 {
    if let Ok(level) = std::env::var("CODE_TABS_OBSERVABILITY_LEVEL") {
        return level_value(&level.to_ascii_uppercase());
    }
    level_value("LOG")
}

fn ui_config_path() -> Result<PathBuf, String> {
    Ok(get_data_dir()?.join("ui-config.json"))
}

fn persisted_observability_enabled() -> bool {
    let Ok(path) = ui_config_path() else {
        return false;
    };
    let Ok(content) = std::fs::read_to_string(path) else {
        return false;
    };
    serde_json::from_str::<Value>(&content)
        .ok()
        .and_then(|value| {
            value
                .get("observability")
                .and_then(|v| v.get("enabled"))
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(false)
}

fn init_observability_runtime() {
    OBSERVABILITY_INIT.call_once(|| {
        OBSERVABILITY_RUNTIME_ENABLED.store(
            env_observability_enabled() || persisted_observability_enabled(),
            Ordering::Relaxed,
        );
        OBSERVABILITY_MIN_LEVEL.store(env_min_level(), Ordering::Relaxed);
    });
}

fn runtime_observability_enabled() -> bool {
    init_observability_runtime();
    OBSERVABILITY_RUNTIME_ENABLED.load(Ordering::Relaxed)
}

fn observability_enabled() -> bool {
    runtime_observability_enabled()
}

// [DP-16] Runtime-only gating: observability and DevTools each have an env-var
// override (CODE_TABS_OBSERVABILITY / CODE_TABS_DEVTOOLS) and a persisted flag
// in ui-config.json (observability.enabled / devtools.enabled). No
// cfg!(debug_assertions) anywhere in the gate.
fn env_devtools_enabled() -> bool {
    std::env::var("CODE_TABS_DEVTOOLS")
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "on"))
        .unwrap_or(false)
}

fn persisted_devtools_enabled() -> bool {
    let Ok(path) = ui_config_path() else {
        return false;
    };
    let Ok(content) = std::fs::read_to_string(path) else {
        return false;
    };
    serde_json::from_str::<Value>(&content)
        .ok()
        .and_then(|value| {
            value
                .get("devtools")
                .and_then(|v| v.get("enabled"))
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(false)
}

fn init_devtools_runtime() {
    DEVTOOLS_INIT.call_once(|| {
        DEVTOOLS_RUNTIME_ENABLED.store(
            env_devtools_enabled() || persisted_devtools_enabled(),
            Ordering::Relaxed,
        );
    });
}

fn devtools_enabled() -> bool {
    init_devtools_runtime();
    DEVTOOLS_RUNTIME_ENABLED.load(Ordering::Relaxed)
}

fn write_persisted_devtools_enabled(enabled: bool) -> Result<(), String> {
    let path = ui_config_path()?;
    let mut root = std::fs::read_to_string(&path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .unwrap_or_else(|| json!({ "version": 3 }));
    if !root.is_object() {
        root = json!({ "version": 3 });
    }
    if root.get("version").and_then(|v| v.as_u64()).unwrap_or(0) < 3 {
        root["version"] = json!(3);
    }
    if !root.get("devtools").is_some_and(Value::is_object) {
        root["devtools"] = json!({});
    }
    root["devtools"]["enabled"] = json!(enabled);
    let bytes = serde_json::to_vec_pretty(&root).map_err(|e| e.to_string())?;
    atomic_write(&path, &bytes).map_err(|e| format!("Failed to write ui-config.json: {e}"))
}

fn observability_level_enabled(level: &str) -> bool {
    level_value(level) >= OBSERVABILITY_MIN_LEVEL.load(Ordering::Relaxed)
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
    writer_pool().append(path, lines.as_bytes().to_vec())
}

fn atomic_write(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|s| s.to_str()).unwrap_or("json")
    ));
    std::fs::write(&tmp, contents)?;
    std::fs::rename(tmp, path)
}

fn write_persisted_observability_enabled(enabled: bool) -> Result<(), String> {
    let path = ui_config_path()?;
    let mut root = std::fs::read_to_string(&path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .unwrap_or_else(|| json!({ "version": 3 }));
    if !root.is_object() {
        root = json!({ "version": 3 });
    }
    if root.get("version").and_then(|v| v.as_u64()).unwrap_or(0) < 3 {
        root["version"] = json!(3);
    }
    if !root.get("observability").is_some_and(Value::is_object) {
        root["observability"] = json!({});
    }
    root["observability"]["enabled"] = json!(enabled);
    let bytes = serde_json::to_vec_pretty(&root).map_err(|e| e.to_string())?;
    atomic_write(&path, &bytes).map_err(|e| format!("Failed to write ui-config.json: {e}"))
}

#[tauri::command]
pub fn get_observability_info() -> Result<ObservabilityInfo, String> {
    let enabled = observability_enabled();
    let global_path = observability_path(None)?;
    let global_log_size = std::fs::metadata(&global_path)
        .map(|m| m.len())
        .unwrap_or(0);
    let global_rotation_count = rotated_file_count(&global_path);
    let global_log_path = if enabled {
        Some(global_path.to_string_lossy().to_string())
    } else {
        None
    };

    Ok(ObservabilityInfo {
        observability_enabled: enabled,
        runtime_override: runtime_observability_enabled(),
        devtools_enabled: devtools_enabled(),
        global_log_path,
        global_log_size,
        global_rotation_count,
        min_level: level_name(OBSERVABILITY_MIN_LEVEL.load(Ordering::Relaxed)),
    })
}

#[tauri::command]
pub fn set_observability_enabled(enabled: bool) -> Result<ObservabilityInfo, String> {
    init_observability_runtime();
    OBSERVABILITY_RUNTIME_ENABLED.store(enabled, Ordering::Relaxed);
    write_persisted_observability_enabled(enabled)?;
    if !enabled {
        writer_pool().flush();
    }
    get_observability_info()
}

#[tauri::command]
pub fn set_devtools_enabled(enabled: bool) -> Result<ObservabilityInfo, String> {
    init_devtools_runtime();
    DEVTOOLS_RUNTIME_ENABLED.store(enabled, Ordering::Relaxed);
    write_persisted_devtools_enabled(enabled)?;
    get_observability_info()
}

#[tauri::command]
pub fn append_observability_data(session_id: Option<String>, lines: String) -> Result<u64, String> {
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
    if !devtools_enabled() {
        return Err("DevTools are disabled. Enable them in Config -> Observability.".into());
    }
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

pub fn record_backend_event(
    app: &AppHandle,
    level: &str,
    module: &str,
    session_id: Option<&str>,
    event: &str,
    message: &str,
    data: Value,
) {
    if !observability_enabled() || !observability_level_enabled(level) {
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

    if let Ok(mut line) = serde_json::to_vec(&entry) {
        line.push(b'\n');
        if let Ok(path) = observability_path(session_id) {
            let _ = writer_pool().append(path, line);
        }
    }
    let _ = app.emit("observability-entry", entry);
}

pub fn shutdown_observability() {
    if let Some(pool) = WRITER_POOL.get() {
        pool.shutdown();
    }
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

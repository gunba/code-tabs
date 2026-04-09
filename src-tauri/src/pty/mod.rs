/// Direct PTY module — replaces tauri-plugin-pty with plain Tauri commands.
///
/// Provides spawn/read/write/resize/kill/exitstatus/destroy commands
/// using direct OS APIs (ConPTY on Windows, openpty on Unix).
use std::collections::BTreeMap;
use std::sync::{
    atomic::{AtomicU16, AtomicU32, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use tauri::async_runtime::{Mutex, RwLock};

use tauri::ipc::Response;

use crate::observability::record_backend_event;

#[cfg(windows)]
pub mod conpty;
#[cfg(unix)]
pub mod unix;

// ── State ────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct PtyState {
    session_id: AtomicU32,
    sessions: RwLock<BTreeMap<PtyHandler, Arc<Session>>>,
}

type PtyHandler = u32;

const TERM_PROGRAM_XTERMJS: &str = "vscode";
const TERM_PROGRAM_VERSION: &str = env!("CARGO_PKG_VERSION");
const TERM_KIND: &str = "xterm-256color";
const COLORTERM_KIND: &str = "truecolor";

struct Session {
    #[cfg(windows)]
    conpty: conpty::ConPtyHandle,
    #[cfg(unix)]
    pty: std::sync::Mutex<unix::UnixPty>,

    writer: Mutex<Box<dyn std::io::Write + Send>>,
    output_rx: Mutex<std::sync::mpsc::Receiver<Vec<u8>>>,
    cols: AtomicU16,
    rows: AtomicU16,
    process_id: u32,
}

fn with_terminal_identity(mut env: BTreeMap<String, String>) -> BTreeMap<String, String> {
    env.insert("TERM_PROGRAM".into(), TERM_PROGRAM_XTERMJS.into());
    env.insert("TERM_PROGRAM_VERSION".into(), TERM_PROGRAM_VERSION.into());
    env.insert("TERM".into(), TERM_KIND.into());
    env.insert("COLORTERM".into(), COLORTERM_KIND.into());
    env
}

// ── Commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn pty_spawn(
    app: tauri::AppHandle,
    file: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    env: BTreeMap<String, String>,
    state: tauri::State<'_, PtyState>,
) -> Result<PtyHandler, String> {
    let env = with_terminal_identity(env);
    let env_keys: Vec<String> = env.keys().cloned().collect();
    record_backend_event(
        &app,
        "LOG",
        "pty",
        None,
        "pty.spawn_requested",
        "PTY spawn requested",
        serde_json::json!({
            "file": &file,
            "args": &args,
            "cwd": &cwd,
            "cols": cols,
            "rows": rows,
            "envKeys": &env_keys,
        }),
    );

    #[cfg(windows)]
    let result = conpty::spawn(&file, &args, cols, rows, cwd.as_deref(), &env)?;

    #[cfg(unix)]
    let result = unix::spawn(&file, &args, cols, rows, cwd.as_deref(), &env)?;

    let handler = state.session_id.fetch_add(1, Ordering::Relaxed);

    let session = Arc::new(Session {
        #[cfg(windows)]
        conpty: result.handle,
        #[cfg(unix)]
        pty: std::sync::Mutex::new(result.pty),

        writer: Mutex::new(Box::new(result.writer)),
        output_rx: Mutex::new(result.output_rx),
        cols: AtomicU16::new(cols),
        rows: AtomicU16::new(rows),
        process_id: result.process_id,
    });

    state.sessions.write().await.insert(handler, session);
    record_backend_event(
        &app,
        "LOG",
        "pty",
        None,
        "pty.spawned",
        "PTY spawned",
        serde_json::json!({
            "handler": handler,
            "childPid": result.process_id,
            "cols": cols,
            "rows": rows,
        }),
    );
    Ok(handler)
}

#[tauri::command]
pub async fn pty_write(
    pid: PtyHandler,
    data: String,
    state: tauri::State<'_, PtyState>,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();
    use std::io::Write;
    session
        .writer
        .lock()
        .await
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// [PT-16] Read output from a PTY session.
///
/// Pipeline: ConPTY/PTY pipe -> background reader thread -> channel ->
/// IPC response (raw binary).
///
/// Returns `tauri::ipc::Response` for zero-copy binary transfer —
/// bypasses JSON serialization (Vec<u8> would serialize as number[]).
#[tauri::command]
pub async fn pty_read(
    pid: PtyHandler,
    state: tauri::State<'_, PtyState>,
) -> Result<Response, String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();

    tauri::async_runtime::spawn_blocking(move || {
        let output_rx = session.output_rx.blocking_lock();

        // Block until first chunk arrives (or channel disconnects = EOF).
        let data = output_rx.recv().map_err(|_| "EOF".to_string())?;
        Ok(Response::new(data))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pty_resize(
    pid: PtyHandler,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, PtyState>,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();

    session.cols.store(cols, Ordering::Release);
    session.rows.store(rows, Ordering::Release);

    #[cfg(windows)]
    session.conpty.resize(cols, rows)?;

    #[cfg(unix)]
    session.pty.lock().unwrap().resize(cols, rows)?;

    Ok(())
}

#[tauri::command]
pub async fn pty_kill(
    app: tauri::AppHandle,
    pid: PtyHandler,
    state: tauri::State<'_, PtyState>,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();

    record_backend_event(
        &app,
        "LOG",
        "pty",
        None,
        "pty.kill_requested",
        "PTY kill requested",
        serde_json::json!({
            "handler": pid,
            "childPid": session.process_id,
        }),
    );

    #[cfg(windows)]
    session.conpty.kill()?;

    #[cfg(unix)]
    session.pty.lock().unwrap().kill()?;

    record_backend_event(
        &app,
        "LOG",
        "pty",
        None,
        "pty.killed",
        "PTY kill completed",
        serde_json::json!({
            "handler": pid,
            "childPid": session.process_id,
        }),
    );
    Ok(())
}

#[tauri::command]
pub async fn pty_exitstatus(
    pid: PtyHandler,
    state: tauri::State<'_, PtyState>,
) -> Result<u32, String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();

    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        {
            session.conpty.wait()
        }
        #[cfg(unix)]
        {
            session.pty.lock().unwrap().wait()
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pty_destroy(pid: PtyHandler, state: tauri::State<'_, PtyState>) -> Result<(), String> {
    state.sessions.write().await.remove(&pid);
    Ok(())
}

#[tauri::command]
pub async fn pty_get_child_pid(
    pid: PtyHandler,
    state: tauri::State<'_, PtyState>,
) -> Result<Option<u32>, String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();
    Ok(Some(session.process_id))
}

/// [PT-18] Drain remaining output from the channel before destroying a session.
/// Prevents the background reader thread from blocking on a full channel
/// after the child process exits.
#[tauri::command]
pub async fn pty_drain_output(
    pid: PtyHandler,
    state: tauri::State<'_, PtyState>,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();

    tauri::async_runtime::spawn_blocking(move || {
        let output_rx = session.output_rx.blocking_lock();
        let deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < deadline {
            match output_rx.recv_timeout(Duration::from_millis(10)) {
                Ok(_) => continue,
                Err(_) => break,
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

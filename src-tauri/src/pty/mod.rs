/// Direct PTY module — replaces tauri-plugin-pty with plain Tauri commands.
///
/// Provides spawn/read/write/resize/kill/exitstatus/destroy commands
/// using direct OS APIs (ConPTY on Windows, openpty on Unix).
use std::collections::BTreeMap;
use std::fmt;
use std::io::Write;
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    Arc,
};

use serde::Serialize;
use tauri::async_runtime::{Mutex, RwLock};

use tauri::ipc::Response;
use tokio::sync::watch;

use crate::observability::record_backend_event;
use crate::session::types::CliKind;

#[cfg(windows)]
pub mod conpty;
#[cfg(unix)]
pub mod unix;
#[cfg(windows)]
use conpty as platform;
#[cfg(unix)]
use unix as platform;

const PTY_READ_BATCH_MAX_BYTES: usize = 256 * 1024;

type ReaderMessage = Result<Vec<u8>, String>;
type ExitState = Option<Result<u32, String>>;

trait PtyBackend: Send + Sync + 'static {
    fn resize(&self, cols: u16, rows: u16) -> Result<(), String>;
    fn kill(&self) -> Result<(), String>;
    fn wait(&self) -> Result<u32, String>;
}

#[cfg(windows)]
impl PtyBackend for conpty::ConPtyHandle {
    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.resize(cols, rows)
    }

    fn kill(&self) -> Result<(), String> {
        self.kill()
    }

    fn wait(&self) -> Result<u32, String> {
        self.wait()
    }
}

#[cfg(unix)]
impl PtyBackend for unix::UnixPty {
    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.resize(cols, rows)
    }

    fn kill(&self) -> Result<(), String> {
        self.kill()
    }

    fn wait(&self) -> Result<u32, String> {
        self.wait()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PtyError {
    SessionNotFound { pid: PtyHandler },
    Spawn { message: String },
    Write { message: String },
    Read { message: String },
    Resize { message: String },
    Kill { message: String },
    Wait { message: String },
    Eof,
    JoinFailed { message: String },
}

impl PtyError {
    fn session_not_found(pid: PtyHandler) -> Self {
        Self::SessionNotFound { pid }
    }

    fn spawn(message: impl ToString) -> Self {
        Self::Spawn {
            message: message.to_string(),
        }
    }

    fn write(message: impl ToString) -> Self {
        Self::Write {
            message: message.to_string(),
        }
    }

    fn read(message: impl ToString) -> Self {
        Self::Read {
            message: message.to_string(),
        }
    }

    fn resize(message: impl ToString) -> Self {
        Self::Resize {
            message: message.to_string(),
        }
    }

    fn kill(message: impl ToString) -> Self {
        Self::Kill {
            message: message.to_string(),
        }
    }

    fn wait(message: impl ToString) -> Self {
        Self::Wait {
            message: message.to_string(),
        }
    }

    fn join_failed(message: impl ToString) -> Self {
        Self::JoinFailed {
            message: message.to_string(),
        }
    }
}

impl fmt::Display for PtyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SessionNotFound { pid } => write!(f, "Unavailable pid {pid}"),
            Self::Spawn { message } => write!(f, "PTY spawn failed: {message}"),
            Self::Write { message } => write!(f, "PTY write failed: {message}"),
            Self::Read { message } => write!(f, "PTY read failed: {message}"),
            Self::Resize { message } => write!(f, "PTY resize failed: {message}"),
            Self::Kill { message } => write!(f, "PTY kill failed: {message}"),
            Self::Wait { message } => write!(f, "PTY wait failed: {message}"),
            Self::Eof => write!(f, "EOF"),
            Self::JoinFailed { message } => write!(f, "PTY blocking task failed: {message}"),
        }
    }
}

impl std::error::Error for PtyError {}

fn pty_spawn_env(env: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    // [PT-19] TERM/COLORTERM defaults injected before caller env so caller wins on conflict.
    // [PT-23] Advertise as xterm-ghostty so Claude Code's TUI uses sync output.
    let mut merged = BTreeMap::from([
        ("TERM".to_string(), "xterm-ghostty".to_string()),
        ("TERM_PROGRAM".to_string(), "ghostty".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
    ]);
    for (k, v) in env {
        merged.insert(k.clone(), v.clone());
    }
    merged
}

/// Windows-only workaround for Codex cursor flicker.
///
/// Codex's TUI wraps every frame in DECSET 2026 (synchronized output) via
/// crossterm::SynchronizedUpdate at ~31 fps. The shimmer/elapsed-time animation
/// rewrites many cells per frame; without atomic rendering, the host terminal
/// shows intermediate cursor positions and the cursor visibly bounces between
/// the input prompt and the animated cells.
///
/// On Unix the BSU/ESU pair reaches xterm.js intact, which buffers and renders
/// the frame atomically. Windows ConPTY (at least through conhost 26100.x)
/// strips DEC private-mode sequences from the host-bound stream — the same
/// behaviour `useXtermLifecycle.ts` already documents for `\e[?1003h` mouse
/// tracking. So xterm.js never sees the sync wrapper and the flicker is
/// constant. OpenAI declines to fix this in Codex (openai/codex#9081, closed
/// not-planned). To compensate, we wrap synthetic BSU/ESU around each Codex
/// frame so xterm.js 6.0's synchronized-output handler renders it atomically.
///
/// [PT-28] Frame-aware (cross-batch) sync wrapping. The previous per-batch
/// wrapper closed every read with ESU, which produced a visible half-frame
/// when Codex emitted a single frame across two ConPTY reads (256KB drain
/// boundary) — the first batch's synthetic ESU forced an early paint, then
/// the second batch's BSU/ESU painted the rest. The per-session `inside_sync`
/// bit tracks whether the previous batch ended mid-frame; if it did, we
/// suppress the leading BSU on the next batch and continue the synchronised
/// region. We also detect any *unmatched* inner DEC-2026 toggle in the batch
/// so a frame that genuinely spans batches stays inside one continuous sync
/// region.
fn maybe_wrap_sync_output(
    data: Vec<u8>,
    cli_kind: Option<CliKind>,
    inside_sync: &AtomicBool,
) -> Vec<u8> {
    #[cfg(windows)]
    {
        if cli_kind == Some(CliKind::Codex) && !data.is_empty() {
            const BSU: &[u8] = b"\x1b[?2026h";
            const ESU: &[u8] = b"\x1b[?2026l";
            let started_inside = inside_sync.load(Ordering::Relaxed);
            // Net toggle inside this batch: scan the body for raw BSU/ESU
            // sequences (Codex emits them; ConPTY strips outer but inner can
            // survive). Each BSU pushes +1, each ESU pops -1; final balance
            // tells us whether the batch ends mid-frame.
            let mut balance: i32 = if started_inside { 1 } else { 0 };
            let mut i = 0;
            while i + BSU.len() <= data.len() {
                if &data[i..i + BSU.len()] == BSU {
                    balance += 1;
                    i += BSU.len();
                    continue;
                }
                if &data[i..i + ESU.len()] == ESU {
                    balance = balance.saturating_sub(1);
                    i += ESU.len();
                    continue;
                }
                i += 1;
            }
            let ends_inside = balance > 0;
            inside_sync.store(ends_inside, Ordering::Relaxed);

            let prepend = !started_inside;
            let append = !ends_inside;
            let mut wrapped = Vec::with_capacity(
                if prepend { BSU.len() } else { 0 } + data.len() + if append { ESU.len() } else { 0 },
            );
            if prepend {
                wrapped.extend_from_slice(BSU);
            }
            wrapped.extend_from_slice(&data);
            if append {
                wrapped.extend_from_slice(ESU);
            }
            return wrapped;
        }
    }
    #[cfg(not(windows))]
    {
        let _ = cli_kind;
        let _ = inside_sync;
    }
    data
}

// ── State ────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct PtyState {
    session_id: AtomicU32,
    sessions: RwLock<BTreeMap<PtyHandler, Arc<Session>>>,
}

type PtyHandler = u32;

struct Session {
    session_id: Option<String>,
    cli_kind: Option<CliKind>,
    backend: Arc<dyn PtyBackend>,
    writer: Mutex<Box<dyn Write + Send>>,
    output_rx: Mutex<tokio::sync::mpsc::Receiver<ReaderMessage>>,
    exit_tx: watch::Sender<ExitState>,
    shutdown_tx: watch::Sender<bool>,
    process_id: u32,
    // [PT-28] Frame-aware sync wrapping state (Windows + Codex only). True
    // when the previous pty_read batch ended inside an unmatched DEC-2026
    // synchronized-output region. maybe_wrap_sync_output consults and updates
    // this so a single Codex frame split across two ConPTY reads stays in one
    // continuous synchronised region in the host stream.
    inside_sync: AtomicBool,
}

// ── Commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn pty_spawn(
    app: tauri::AppHandle,
    session_id: Option<String>,
    cli_kind: Option<CliKind>,
    file: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    env: BTreeMap<String, String>,
    state: tauri::State<'_, PtyState>,
) -> Result<PtyHandler, PtyError> {
    let env_keys: Vec<String> = env.keys().cloned().collect();
    record_backend_event(
        &app,
        "LOG",
        "pty",
        session_id.as_deref(),
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

    let spawn_env = pty_spawn_env(&env);
    let result = platform::spawn(&file, &args, cols, rows, cwd.as_deref(), &spawn_env)
        .map_err(PtyError::spawn)?;

    let handler = state.session_id.fetch_add(1, Ordering::Relaxed);
    let backend: Arc<dyn PtyBackend> = Arc::new(result.backend);
    let (exit_tx, _) = watch::channel::<ExitState>(None);
    let wait_backend = backend.clone();
    let wait_tx = exit_tx.clone();
    tauri::async_runtime::spawn(async move {
        let wait_result = tauri::async_runtime::spawn_blocking(move || wait_backend.wait())
            .await
            .map_err(|e| format!("join error: {e}"))
            .and_then(|result| result);
        let _ = wait_tx.send(Some(wait_result));
    });
    let (shutdown_tx, _) = watch::channel(false);

    let session = Arc::new(Session {
        session_id: session_id.clone(),
        cli_kind,
        backend,
        writer: Mutex::new(Box::new(result.writer)),
        output_rx: Mutex::new(result.output_rx),
        exit_tx,
        shutdown_tx,
        process_id: result.process_id,
        inside_sync: AtomicBool::new(false),
    });

    state.sessions.write().await.insert(handler, session);
    record_backend_event(
        &app,
        "LOG",
        "pty",
        session_id.as_deref(),
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
) -> Result<(), PtyError> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or_else(|| PtyError::session_not_found(pid))?
        .clone();
    session
        .writer
        .lock()
        .await
        .write_all(data.as_bytes())
        .map_err(PtyError::write)?;
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
) -> Result<Response, PtyError> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or_else(|| PtyError::session_not_found(pid))?
        .clone();

    let mut shutdown_rx = session.shutdown_tx.subscribe();
    if *shutdown_rx.borrow() {
        return Err(PtyError::Eof);
    }
    let mut output_rx = session.output_rx.lock().await;

    // [PT-27] Drain queued chunks after the awaited recv to cut IPC round-trips during high-throughput output (try_recv until Empty/Disconnected; bound: PTY_READ_BATCH_MAX_BYTES=256KB).
    let first = tokio::select! {
        item = output_rx.recv() => item.ok_or(PtyError::Eof)?,
        _ = shutdown_rx.changed() => return Err(PtyError::Eof),
    };
    let mut data = first.map_err(PtyError::read)?;
    while data.len() < PTY_READ_BATCH_MAX_BYTES {
        match output_rx.try_recv() {
            Ok(Ok(mut next)) => data.append(&mut next),
            Ok(Err(err)) => return Err(PtyError::read(err)),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => break,
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => break,
        }
    }
    let data = maybe_wrap_sync_output(data, session.cli_kind, &session.inside_sync);
    Ok(Response::new(data))
}

#[tauri::command]
pub async fn pty_resize(
    pid: PtyHandler,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, PtyState>,
) -> Result<(), PtyError> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or_else(|| PtyError::session_not_found(pid))?
        .clone();

    session
        .backend
        .resize(cols, rows)
        .map_err(PtyError::resize)?;

    Ok(())
}

#[tauri::command]
pub async fn pty_kill(
    app: tauri::AppHandle,
    pid: PtyHandler,
    state: tauri::State<'_, PtyState>,
) -> Result<(), PtyError> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or_else(|| PtyError::session_not_found(pid))?
        .clone();

    record_backend_event(
        &app,
        "LOG",
        "pty",
        session.session_id.as_deref(),
        "pty.kill_requested",
        "PTY kill requested",
        serde_json::json!({
            "handler": pid,
            "childPid": session.process_id,
        }),
    );

    let backend = session.backend.clone();
    tauri::async_runtime::spawn_blocking(move || backend.kill())
        .await
        .map_err(PtyError::join_failed)?
        .map_err(PtyError::kill)?;

    record_backend_event(
        &app,
        "LOG",
        "pty",
        session.session_id.as_deref(),
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
) -> Result<u32, PtyError> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or_else(|| PtyError::session_not_found(pid))?
        .clone();

    let mut exit_rx = session.exit_tx.subscribe();
    loop {
        if let Some(result) = exit_rx.borrow().clone() {
            return result.map_err(PtyError::wait);
        }
        exit_rx
            .changed()
            .await
            .map_err(|_| PtyError::wait("exit watcher closed"))?;
    }
}

#[tauri::command]
pub async fn pty_destroy(
    pid: PtyHandler,
    state: tauri::State<'_, PtyState>,
) -> Result<(), PtyError> {
    if let Some(session) = state.sessions.write().await.remove(&pid) {
        let _ = session.shutdown_tx.send(true);
        let backend = session.backend.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || backend.kill()).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn pty_get_child_pid(
    pid: PtyHandler,
    state: tauri::State<'_, PtyState>,
) -> Result<Option<u32>, PtyError> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or_else(|| PtyError::session_not_found(pid))?
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
) -> Result<(), PtyError> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or_else(|| PtyError::session_not_found(pid))?
        .clone();

    let mut output_rx = session.output_rx.lock().await;
    while output_rx.try_recv().is_ok() {}
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pty_spawn_env_sets_term_defaults_and_allows_overrides() {
        let env = BTreeMap::from([
            ("TERM".to_string(), "xterm-256color".to_string()),
            ("CUSTOM".to_string(), "1".to_string()),
        ]);

        let merged = pty_spawn_env(&env);

        assert_eq!(
            merged.get("TERM").map(String::as_str),
            Some("xterm-256color")
        );
        assert_eq!(
            merged.get("TERM_PROGRAM").map(String::as_str),
            Some("ghostty")
        );
        assert_eq!(
            merged.get("COLORTERM").map(String::as_str),
            Some("truecolor")
        );
        assert_eq!(merged.get("CUSTOM").map(String::as_str), Some("1"));
    }

    #[test]
    fn pty_error_serializes_discriminated_kind() {
        let value = serde_json::to_value(PtyError::session_not_found(42)).unwrap();

        assert_eq!(value["kind"], "sessionNotFound");
        assert_eq!(value["pid"], 42);
    }

    #[cfg(windows)]
    #[test]
    fn wrap_sync_output_brackets_codex_batches_on_windows() {
        let state = AtomicBool::new(false);
        let wrapped = maybe_wrap_sync_output(b"hello".to_vec(), Some(CliKind::Codex), &state);
        assert_eq!(&wrapped[..8], b"\x1b[?2026h");
        assert_eq!(&wrapped[8..13], b"hello");
        assert_eq!(&wrapped[13..], b"\x1b[?2026l");
        assert!(!state.load(Ordering::Relaxed));
    }

    #[cfg(windows)]
    #[test]
    fn wrap_sync_output_skips_claude_empty_and_unknown() {
        let state = AtomicBool::new(false);
        assert_eq!(
            maybe_wrap_sync_output(b"hello".to_vec(), Some(CliKind::Claude), &state),
            b"hello".to_vec()
        );
        assert_eq!(
            maybe_wrap_sync_output(b"hello".to_vec(), None, &state),
            b"hello".to_vec()
        );
        assert_eq!(
            maybe_wrap_sync_output(Vec::new(), Some(CliKind::Codex), &state),
            Vec::<u8>::new()
        );
    }

    #[cfg(windows)]
    #[test]
    fn wrap_sync_output_holds_open_across_batches_when_frame_straddles() {
        // [PT-28] A Codex frame can straddle two ConPTY read batches. The
        // first batch contains an inner BSU (Codex's own) with no matching
        // ESU; the second batch contains the matching ESU. With the per-batch
        // wrapper we used to close-and-reopen the sync region in between,
        // forcing xterm.js to paint a half-frame. With cross-batch state,
        // the leading BSU is only emitted once and the trailing ESU only
        // once when the frame truly ends.
        let state = AtomicBool::new(false);
        let batch_a = {
            let mut v = Vec::new();
            v.extend_from_slice(b"\x1b[?2026h"); // inner BSU
            v.extend_from_slice(b"part-a");
            v
        };
        let wrapped_a = maybe_wrap_sync_output(batch_a.clone(), Some(CliKind::Codex), &state);
        // Leading synthetic BSU prepended; no trailing ESU because we're mid-frame.
        assert_eq!(&wrapped_a[..8], b"\x1b[?2026h");
        assert!(state.load(Ordering::Relaxed));
        assert!(!wrapped_a.ends_with(b"\x1b[?2026l"));

        let batch_b = {
            let mut v = Vec::new();
            v.extend_from_slice(b"part-b");
            v.extend_from_slice(b"\x1b[?2026l"); // inner ESU closes the frame
            v
        };
        let wrapped_b = maybe_wrap_sync_output(batch_b.clone(), Some(CliKind::Codex), &state);
        // No leading BSU prepended (continuing the frame); inner ESU left intact;
        // no synthetic trailing ESU because the inner ESU already closed it.
        assert!(!wrapped_b.starts_with(b"\x1b[?2026h"));
        assert!(!state.load(Ordering::Relaxed));
        assert!(wrapped_b.ends_with(b"\x1b[?2026l"));
    }

    #[cfg(not(windows))]
    #[test]
    fn wrap_sync_output_is_passthrough_off_windows() {
        let state = AtomicBool::new(false);
        let data = b"hello".to_vec();
        assert_eq!(
            maybe_wrap_sync_output(data.clone(), Some(CliKind::Codex), &state),
            data
        );
    }
}

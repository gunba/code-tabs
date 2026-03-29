use std::{
    collections::BTreeMap,
    ffi::OsString,
    io::{Read, Write as IoWrite, BufWriter},
    fs::File,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, PtyPair, PtySize};
use tauri::{
    async_runtime::{Mutex, RwLock},
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime,
};

mod output_filter;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

use output_filter::OutputFilter;

/// NDJSON PTY recorder — captures raw and filtered output with timestamps
/// plus resize and input events for terminal debugging.
struct PtyRecorder {
    writer: BufWriter<File>,
    start: Instant,
}

impl PtyRecorder {
    fn new(path: &str, cols: u16, rows: u16) -> std::io::Result<Self> {
        // Create parent directory if needed (for auto-generated recording paths)
        if let Some(parent) = std::path::Path::new(path).parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let file = File::create(path)?;
        let mut writer = BufWriter::new(file);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let header = format!(
            r#"{{"version":1,"cols":{},"rows":{},"timestamp":{}}}"#,
            cols, rows, timestamp
        );
        writeln!(writer, "{}", header)?;
        writer.flush()?;
        Ok(Self { writer, start: Instant::now() })
    }

    fn record(&mut self, phase: &str, data: &[u8]) {
        let t = self.start.elapsed().as_secs_f64();
        let b64 = BASE64.encode(data);
        let _ = writeln!(
            self.writer,
            r#"{{"t":{:.6},"phase":"{}","base64":"{}"}}"#,
            t, phase, b64
        );
    }

    fn record_resize(&mut self, cols: u16, rows: u16) {
        let t = self.start.elapsed().as_secs_f64();
        let _ = writeln!(
            self.writer,
            r#"{{"t":{:.6},"phase":"resize","cols":{},"rows":{}}}"#,
            t, cols, rows
        );
    }

    fn flush(&mut self) {
        let _ = self.writer.flush();
    }
}

#[derive(Default)]
struct PluginState {
    session_id: AtomicU32,
    sessions: RwLock<BTreeMap<PtyHandler, Arc<Session>>>,
}

struct Session {
    pair: Mutex<PtyPair>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    child_killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    output_rx: Mutex<std::sync::mpsc::Receiver<Vec<u8>>>,
    output_filter: Mutex<OutputFilter>,
    recorder: std::sync::Mutex<Option<PtyRecorder>>,
    /// When true, the next read() discards ConPTY's broken reflow output.
    /// Set by resize() before the PTY resize call so the flag is visible
    /// by the time reflow data arrives in the channel.
    drain_after_resize: AtomicBool,
}

type PtyHandler = u32;

#[tauri::command]
async fn spawn<R: Runtime>(
    file: String,
    args: Vec<String>,
    term_name: Option<String>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    env: BTreeMap<String, String>,
    encoding: Option<String>,
    handle_flow_control: Option<bool>,
    flow_control_pause: Option<String>,
    flow_control_resume: Option<String>,

    state: tauri::State<'_, PluginState>,
    _app_handle: AppHandle<R>,
) -> Result<PtyHandler, String> {
    let _ = term_name;
    let _ = encoding;
    let _ = handle_flow_control;
    let _ = flow_control_pause;
    let _ = flow_control_resume;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(file);
    cmd.args(args);
    if let Some(cwd) = cwd {
        cmd.cwd(OsString::from(cwd));
    }
    for (k, v) in env.iter() {
        cmd.env(OsString::from(k), OsString::from(v));
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let child_killer = child.clone_killer();
    let handler = state.session_id.fetch_add(1, Ordering::Relaxed);

    // Spawn background reader thread: reads from ConPTY pipe into a bounded channel.
    // This decouples the blocking pipe read from the IPC read command.
    let (output_tx, output_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = vec![0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if output_tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let session = Arc::new(Session {
        pair: Mutex::new(pair),
        child: Mutex::new(child),
        child_killer: Mutex::new(child_killer),
        writer: Mutex::new(writer),
        output_rx: Mutex::new(output_rx),
        output_filter: Mutex::new(OutputFilter::new()),
        recorder: std::sync::Mutex::new(None),
        drain_after_resize: AtomicBool::new(false),
    });
    state.sessions.write().await.insert(handler, session);
    Ok(handler)
}

#[tauri::command]
async fn write(
    pid: PtyHandler,
    data: String,
    state: tauri::State<'_, PluginState>,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavaliable pid")?
        .clone();
    let bytes = data.as_bytes();
    session
        .writer
        .lock()
        .await
        .write_all(bytes)
        .map_err(|e| e.to_string())?;
    // Record input if recording is active
    if let Some(rec) = session.recorder.lock().unwrap().as_mut() {
        rec.record("input", bytes);
    }
    Ok(())
}

/// Read filtered output from a PTY session.
///
/// Pipeline: ConPTY pipe → background reader thread → channel →
/// OutputFilter (scrollback fix + security) → IPC response.
///
/// Blocks on the first chunk, then returns immediately. The frontend
/// polls read() repeatedly, and xterm.js 6.0 handles DEC 2026 sync
/// updates natively.
#[tauri::command]
async fn read(pid: PtyHandler, state: tauri::State<'_, PluginState>) -> Result<Vec<u8>, String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavaliable pid")?
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        let output_rx = session.output_rx.blocking_lock();
        let mut output_filter = session.output_filter.blocking_lock();

        // Block until first chunk arrives (or channel disconnects = EOF).
        let first = output_rx.recv().map_err(|_| "EOF".to_string())?;

        // If resize set the drain flag, discard ConPTY's broken reflow output
        // and wait for the application's proper redraw after SIGWINCH.
        let data = if session.drain_after_resize.load(Ordering::Acquire) {
            // Drain all reflow chunks. ConPTY reflow arrives in rapid
            // succession; a 5ms gap indicates reflow is complete.
            loop {
                match output_rx.recv_timeout(Duration::from_millis(5)) {
                    Ok(_) => continue,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        session.drain_after_resize.store(false, Ordering::Release);
                        return Err("EOF".to_string());
                    }
                }
            }
            session.drain_after_resize.store(false, Ordering::Release);
            // Wait for the application's proper redraw after SIGWINCH.
            output_rx.recv().map_err(|_| "EOF".to_string())?
        } else {
            first
        };

        // Acquire recorder lock after data arrives — scoped block ensures
        // the MutexGuard drops immediately after processing + flush.
        let mut recorder = session.recorder.lock().unwrap();

        if let Some(rec) = recorder.as_mut() { rec.record("raw", &data); }

        // Filter for scrollback fix and security
        let filtered = output_filter.filter(&data);
        if let Some(rec) = recorder.as_mut() { rec.record("filtered", filtered); }
        if let Some(rec) = recorder.as_mut() { rec.flush(); }
        drop(recorder);

        Ok(filtered.to_vec())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn resize(
    pid: PtyHandler,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, PluginState>,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavaliable pid")?
        .clone();
    // Set drain flag BEFORE PTY resize so read() discards ConPTY reflow.
    // The flag must be visible before the resize call produces reflow data.
    session.drain_after_resize.store(true, Ordering::Release);

    session
        .pair
        .lock()
        .await
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    // Record resize event if recording is active
    if let Some(rec) = session.recorder.lock().unwrap().as_mut() {
        rec.record_resize(cols, rows);
    }
    Ok(())
}

#[tauri::command]
async fn start_pty_recording(
    pid: PtyHandler,
    path: String,
    state: tauri::State<'_, PluginState>,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavaliable pid")?
        .clone();
    let cols = {
        let pair = session.pair.lock().await;
        let size = pair.master.get_size().map_err(|e| e.to_string())?;
        (size.cols, size.rows)
    };
    let recorder = PtyRecorder::new(&path, cols.0, cols.1).map_err(|e| e.to_string())?;
    *session.recorder.lock().unwrap_or_else(|e| e.into_inner()) = Some(recorder);
    Ok(())
}

#[tauri::command]
async fn stop_pty_recording(
    pid: PtyHandler,
    state: tauri::State<'_, PluginState>,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavaliable pid")?
        .clone();
    if let Some(mut rec) = session.recorder.lock().unwrap_or_else(|e| e.into_inner()).take() {
        rec.flush();
    }
    Ok(())
}

#[tauri::command]
async fn kill(pid: PtyHandler, state: tauri::State<'_, PluginState>) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavaliable pid")?
        .clone();
    session
        .child_killer
        .lock()
        .await
        .kill()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// FIX: wrap blocking child.wait() in spawn_blocking
#[tauri::command]
async fn exitstatus(pid: PtyHandler, state: tauri::State<'_, PluginState>) -> Result<u32, String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavaliable pid")?
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        let exitstatus = session
            .child
            .blocking_lock()
            .wait()
            .map_err(|e| e.to_string())?
            .exit_code();
        Ok(exitstatus)
    })
    .await
    .map_err(|e| e.to_string())?
}

// NEW: remove session from BTreeMap, triggering Drop chain (closes ConPTY, pipes, etc.)
#[tauri::command]
async fn destroy(pid: PtyHandler, state: tauri::State<'_, PluginState>) -> Result<(), String> {
    state.sessions.write().await.remove(&pid);
    Ok(())
}

// NEW: get the OS process ID of the child (needed for process tree kill fallback)
#[tauri::command]
async fn get_child_pid(
    pid: PtyHandler,
    state: tauri::State<'_, PluginState>,
) -> Result<Option<u32>, String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavaliable pid")?
        .clone();
    let child_pid = session.child.lock().await.process_id();
    Ok(child_pid)
}

/// Drain remaining output from the channel before destroying a session.
/// Prevents the background reader thread from blocking on a full channel
/// after the child process exits.
#[tauri::command]
async fn drain_output(pid: PtyHandler, state: tauri::State<'_, PluginState>) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavaliable pid")?
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        let output_rx = session.output_rx.blocking_lock();
        let deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < deadline {
            match output_rx.recv_timeout(Duration::from_millis(10)) {
                Ok(_) => continue,  // Discard, keep draining
                Err(_) => break,    // Empty or disconnected
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("pty")
        .invoke_handler(tauri::generate_handler![
            spawn,
            write,
            read,
            resize,
            kill,
            exitstatus,
            destroy,
            get_child_pid,
            drain_output,
            start_pty_recording,
            stop_pty_recording
        ])
        .setup(|app_handle, _api| {
            app_handle.manage(PluginState::default());
            Ok(())
        })
        .build()
}

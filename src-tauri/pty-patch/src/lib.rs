use std::{
    collections::BTreeMap,
    ffi::OsString,
    io::Read,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, PtyPair, PtySize};
use tauri::{
    async_runtime::{Mutex, RwLock},
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime,
};

mod output_filter;
mod sync_detector;

use output_filter::OutputFilter;
use sync_detector::{SyncBlockDetector, SyncEvent};

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
    sync_detector: Mutex<SyncBlockDetector>,
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
    // This decouples the blocking pipe read from the IPC read command, enabling
    // timeout-based sync block coalescing.
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
        sync_detector: Mutex::new(SyncBlockDetector::new()),
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
    session
        .writer
        .lock()
        .await
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Read filtered, sync-coalesced output from a PTY session.
///
/// Pipeline: ConPTY pipe → background reader thread → channel →
/// OutputFilter (security) → SyncBlockDetector (coalescing) → IPC response.
///
/// Blocks on the first chunk, then if mid-sync-block, continues reading
/// with a 50ms timeout to coalesce the complete synchronized update.
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
        let mut sync_detector = session.sync_detector.blocking_lock();

        // Block until first chunk arrives (or channel disconnects = EOF)
        let first = output_rx.recv().map_err(|_| "EOF".to_string())?;

        let mut result = Vec::new();

        // Filter for security, then detect sync blocks
        let filtered = output_filter.filter(&first);
        for event in sync_detector.process(filtered) {
            match event {
                SyncEvent::PassThrough(data) => result.extend_from_slice(data),
                SyncEvent::SyncBlock { data, .. } => result.extend_from_slice(&data),
            }
        }

        // If we're mid-sync-block, keep reading with timeout to coalesce
        // the complete DEC 2026 synchronized update into a single IPC response
        if sync_detector.in_sync_block() {
            let deadline = Instant::now() + Duration::from_millis(50);
            while sync_detector.in_sync_block() {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match output_rx.recv_timeout(remaining) {
                    Ok(chunk) => {
                        let filtered = output_filter.filter(&chunk);
                        for event in sync_detector.process(filtered) {
                            match event {
                                SyncEvent::PassThrough(data) => {
                                    result.extend_from_slice(data);
                                }
                                SyncEvent::SyncBlock { data, .. } => {
                                    result.extend_from_slice(&data);
                                }
                            }
                        }
                    }
                    Err(_) => break, // Timeout or disconnected
                }
            }
        }

        Ok(result)
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
            drain_output
        ])
        .setup(|app_handle, _api| {
            app_handle.manage(PluginState::default());
            Ok(())
        })
        .build()
}

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::observability::record_backend_event;

pub struct TapServerState {
    active: HashMap<String, bool>, // session_id -> should_stop
}

impl TapServerState {
    pub fn new() -> Self {
        Self {
            active: HashMap::new(),
        }
    }

    /// Set stop flag for all active servers (used on app exit).
    pub fn stop_all(&mut self) {
        for v in self.active.values_mut() {
            *v = true;
        }
    }
}

/// Start a per-session TCP listener. Returns the OS-assigned port.
/// The background thread accepts one connection at a time, reads JSONL lines,
/// and emits each line as a session-scoped Tauri event.
#[tauri::command]
pub fn start_tap_server(
    app: AppHandle,
    session_id: String,
    tap_state: tauri::State<'_, Arc<Mutex<TapServerState>>>,
) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("TCP bind failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr failed: {e}"))?
        .port();

    listener
        .set_nonblocking(true)
        .map_err(|e| format!("set_nonblocking failed: {e}"))?;

    let sid = session_id.clone();
    let state = tap_state.inner().clone();

    // Mark as active
    if let Ok(mut s) = state.lock() {
        s.active.insert(sid.clone(), false);
    }

    record_backend_event(
        &app,
        "LOG",
        "tap-server",
        Some(&sid),
        "tap.server.start",
        "Tap TCP server started",
        serde_json::json!({ "port": port }),
    );

    let event_name = format!("tap-entry-{sid}");
    let sid_for_thread = sid.clone();
    let app_for_thread = app.clone();

    std::thread::spawn(move || {
        // Accept loop — one connection at a time, re-accept on disconnect
        loop {
            // Check stop flag
            if let Ok(s) = state.lock() {
                if s.active.get(&sid).copied().unwrap_or(true) {
                    break;
                }
            }

            // Non-blocking accept
            match listener.accept() {
                Ok((stream, addr)) => {
                    record_backend_event(
                        &app_for_thread,
                        "LOG",
                        "tap-server",
                        Some(&sid_for_thread),
                        "tap.server.client_connected",
                        "Tap client connected",
                        serde_json::json!({ "remoteAddr": addr.to_string() }),
                    );
                    // Set blocking with read timeout for the data stream
                    stream.set_nonblocking(false).ok();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .ok();

                    let mut reader = BufReader::new(stream);
                    let mut line = String::new();

                    // Read loop — process JSONL lines until EOF or stop
                    loop {
                        if let Ok(s) = state.lock() {
                            if s.active.get(&sid).copied().unwrap_or(true) {
                                break;
                            }
                        }

                        match reader.read_line(&mut line) {
                            Ok(0) => break, // EOF — client disconnected
                            Ok(_) => {
                                let trimmed = line.trim();
                                if !trimmed.is_empty() {
                                    app.emit(&event_name, trimmed).ok();
                                }
                                line.clear();
                            }
                            Err(ref e)
                                if e.kind() == std::io::ErrorKind::WouldBlock
                                    || e.kind() == std::io::ErrorKind::TimedOut =>
                            {
                                // Read timeout — check stop flag and continue
                                line.clear();
                                continue;
                            }
                            Err(err) => {
                                record_backend_event(
                                    &app_for_thread,
                                    "WARN",
                                    "tap-server",
                                    Some(&sid_for_thread),
                                    "tap.server.read_error",
                                    "Tap client read error",
                                    serde_json::json!({ "error": err.to_string() }),
                                );
                                break; // Connection error — re-accept
                            }
                        }
                    }

                    record_backend_event(
                        &app_for_thread,
                        "LOG",
                        "tap-server",
                        Some(&sid_for_thread),
                        "tap.server.client_disconnected",
                        "Tap client disconnected",
                        serde_json::json!({}),
                    );
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    // No connection yet — sleep and retry
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(_) => {
                    record_backend_event(
                        &app_for_thread,
                        "ERR",
                        "tap-server",
                        Some(&sid_for_thread),
                        "tap.server.accept_error",
                        "Tap listener accept failed",
                        serde_json::json!({}),
                    );
                    // Listener error — exit thread
                    break;
                }
            }
        }

        // Cleanup
        if let Ok(mut s) = state.lock() {
            s.active.remove(&sid_for_thread);
        }
        record_backend_event(
            &app_for_thread,
            "LOG",
            "tap-server",
            Some(&sid_for_thread),
            "tap.server.stop",
            "Tap TCP server stopped",
            serde_json::json!({}),
        );
    });

    Ok(port)
}

/// Signal a session's TCP server thread to stop.
#[tauri::command]
pub fn stop_tap_server(
    app: AppHandle,
    session_id: String,
    tap_state: tauri::State<'_, Arc<Mutex<TapServerState>>>,
) {
    if let Ok(mut s) = tap_state.lock() {
        if let Some(flag) = s.active.get_mut(&session_id) {
            *flag = true;
        }
    }
    record_backend_event(
        &app,
        "DEBUG",
        "tap-server",
        Some(&session_id),
        "tap.server.stop_requested",
        "Tap TCP server stop requested",
        serde_json::json!({}),
    );
}

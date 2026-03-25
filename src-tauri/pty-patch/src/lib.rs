use std::{
    collections::BTreeMap,
    ffi::OsString,
    io::Read,
    sync::{
        atomic::{AtomicU16, AtomicU32, Ordering},
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

/// Copy `src` into `dst`, skipping all occurrences of ESC[2J (Clear Screen).
/// Uses SIMD-accelerated memchr::memmem for efficient scanning.
fn strip_clear_screen_into(src: &[u8], dst: &mut Vec<u8>) {
    const CLEAR_SCREEN: &[u8] = b"\x1b[2J";
    let finder = memchr::memmem::Finder::new(CLEAR_SCREEN);
    let mut pos = 0;
    while let Some(found) = finder.find(&src[pos..]) {
        dst.extend_from_slice(&src[pos..pos + found]);
        pos += found + CLEAR_SCREEN.len();
    }
    dst.extend_from_slice(&src[pos..]);
}

/// Re-wrap a completed sync block with BSU/ESU for xterm.js.
/// Full-redraw blocks replace ESC[2J with ESC[H ESC[J (viewport overwrite).
/// ESC[3J is only added when content exceeds terminal height — this prevents
/// scrollback duplication from overflow while preserving scrollback (and thus
/// scroll position) for redraws that fit within the viewport.
fn emit_sync_block(data: &[u8], is_full_redraw: bool, rows: u16, result: &mut Vec<u8>) {
    result.extend_from_slice(b"\x1b[?2026h"); // BSU
    if is_full_redraw {
        let line_count = memchr::memchr_iter(b'\n', data).count();
        if line_count >= rows as usize {
            result.extend_from_slice(b"\x1b[3J"); // Overflow prevention
        }
        result.extend_from_slice(b"\x1b[H\x1b[J");  // Cursor home + clear viewport
        strip_clear_screen_into(data, result);
    } else {
        result.extend_from_slice(data);
    }
    result.extend_from_slice(b"\x1b[?2026l"); // ESU
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
    sync_detector: Mutex<SyncBlockDetector>,
    rows: AtomicU16,
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
        rows: AtomicU16::new(rows),
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
        let rows = session.rows.load(Ordering::Relaxed);

        // Block until first chunk arrives (or channel disconnects = EOF)
        let first = output_rx.recv().map_err(|_| "EOF".to_string())?;

        let mut result = Vec::new();

        // Filter for security, then detect sync blocks
        let filtered = output_filter.filter(&first);
        for event in sync_detector.process(filtered) {
            match event {
                SyncEvent::PassThrough(data) => result.extend_from_slice(data),
                SyncEvent::SyncBlock { data, is_full_redraw } => {
                    emit_sync_block(&data, is_full_redraw, rows, &mut result);
                }
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
                                SyncEvent::SyncBlock { data, is_full_redraw } => {
                                    emit_sync_block(&data, is_full_redraw, rows, &mut result);
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
    session.rows.store(rows, Ordering::Relaxed);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_clear_screen_no_occurrences() {
        let src = b"hello world";
        let mut dst = Vec::new();
        strip_clear_screen_into(src, &mut dst);
        assert_eq!(dst, b"hello world");
    }

    #[test]
    fn test_strip_clear_screen_single() {
        let mut src = Vec::new();
        src.extend_from_slice(b"before\x1b[2Jafter");
        let mut dst = Vec::new();
        strip_clear_screen_into(&src, &mut dst);
        assert_eq!(dst, b"beforeafter");
    }

    #[test]
    fn test_strip_clear_screen_multiple() {
        let mut src = Vec::new();
        src.extend_from_slice(b"\x1b[2J\x1b[Hcontent\x1b[2J");
        let mut dst = Vec::new();
        strip_clear_screen_into(&src, &mut dst);
        assert_eq!(dst, b"\x1b[Hcontent");
    }

    #[test]
    fn test_strip_clear_screen_preserves_other_escapes() {
        let mut src = Vec::new();
        src.extend_from_slice(b"\x1b[2J\x1b[H\x1b[1;31mred\x1b[0m");
        let mut dst = Vec::new();
        strip_clear_screen_into(&src, &mut dst);
        assert_eq!(dst, b"\x1b[H\x1b[1;31mred\x1b[0m");
    }

    #[test]
    fn test_strip_clear_screen_empty() {
        let mut dst = Vec::new();
        strip_clear_screen_into(b"", &mut dst);
        assert!(dst.is_empty());
    }

    #[test]
    fn test_emit_sync_block_non_full_redraw() {
        let mut result = Vec::new();
        emit_sync_block(b"content", false, 40, &mut result);
        // Should wrap with BSU/ESU, no ESC[2J replacement
        let mut expected = Vec::new();
        expected.extend_from_slice(b"\x1b[?2026h");
        expected.extend_from_slice(b"content");
        expected.extend_from_slice(b"\x1b[?2026l");
        assert_eq!(result, expected);
    }

    #[test]
    fn test_emit_sync_block_full_redraw_strips_clear() {
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[2J\x1b[Hscreen content");
        let mut result = Vec::new();
        // Short content (0 newlines < 40 rows) — no ESC[3J
        emit_sync_block(&data, true, 40, &mut result);
        let mut expected = Vec::new();
        expected.extend_from_slice(b"\x1b[?2026h");
        expected.extend_from_slice(b"\x1b[H\x1b[J");
        expected.extend_from_slice(b"\x1b[Hscreen content"); // ESC[2J removed
        expected.extend_from_slice(b"\x1b[?2026l");
        assert_eq!(result, expected);
    }

    #[test]
    fn test_emit_sync_block_full_redraw_no_clear_in_data() {
        // Full redraw flagged but data happens to not contain ESC[2J
        // Short content (0 newlines < 40 rows) — no ESC[3J
        let mut result = Vec::new();
        emit_sync_block(b"\x1b[Hcontent", true, 40, &mut result);
        let mut expected = Vec::new();
        expected.extend_from_slice(b"\x1b[?2026h");
        expected.extend_from_slice(b"\x1b[H\x1b[J");
        expected.extend_from_slice(b"\x1b[Hcontent");
        expected.extend_from_slice(b"\x1b[?2026l");
        assert_eq!(result, expected);
    }

    // --- Edge case: input is exactly ESC[2J with nothing else ---
    #[test]
    fn test_strip_clear_screen_only_clear() {
        let src = b"\x1b[2J";
        let mut dst = Vec::new();
        strip_clear_screen_into(src, &mut dst);
        assert!(dst.is_empty(), "stripping sole ESC[2J should produce empty output");
    }

    // --- Edge case: adjacent ESC[2J sequences with no bytes between them ---
    #[test]
    fn test_strip_clear_screen_adjacent() {
        let src = b"\x1b[2J\x1b[2J";
        let mut dst = Vec::new();
        strip_clear_screen_into(src, &mut dst);
        assert!(dst.is_empty(), "two adjacent ESC[2J should both be stripped");
    }

    // --- Sync block has ESC[2J but is NOT a full redraw (no cursor-home) ---
    // Verifies SyncBlockDetector returns is_full_redraw=false and preserves ESC[2J
    #[test]
    fn test_sync_block_clear_screen_without_cursor_home_not_full_redraw() {
        let mut detector = SyncBlockDetector::new();
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[?2026h"); // BSU
        data.extend_from_slice(b"\x1b[2J");     // Clear screen, no cursor-home
        data.extend_from_slice(b"new content");
        data.extend_from_slice(b"\x1b[?2026l"); // ESU

        let events = detector.process(&data);
        assert_eq!(events.len(), 1);
        match &events[0] {
            SyncEvent::SyncBlock { data, is_full_redraw } => {
                assert!(!is_full_redraw,
                    "ESC[2J without cursor-home should NOT be a full redraw");
                // Block data must still contain ESC[2J unchanged
                assert!(data.windows(4).any(|w| w == b"\x1b[2J"),
                    "block data must preserve ESC[2J when is_full_redraw=false");
            }
            _ => panic!("expected SyncBlock"),
        }
    }

    // --- emit_sync_block: non-full-redraw preserves ESC[2J in data ---
    #[test]
    fn test_emit_sync_block_non_full_redraw_preserves_clear_screen() {
        let block_data = b"\x1b[2Jsome content";
        let mut result = Vec::new();
        emit_sync_block(block_data, false, 40, &mut result);

        assert!(result.starts_with(b"\x1b[?2026h"), "must start with BSU");
        assert!(result.ends_with(b"\x1b[?2026l"), "must end with ESU");
        // Inner content must match block_data exactly -- ESC[2J NOT stripped
        let inner = &result[8..result.len() - 8];
        assert_eq!(inner, block_data,
            "non-full-redraw must pass ESC[2J through unchanged");
    }

    // --- emit_sync_block: full redraw with multiple ESC[2J strips all ---
    #[test]
    fn test_emit_sync_block_full_redraw_strips_all_clears() {
        let mut block_data = Vec::new();
        block_data.extend_from_slice(b"\x1b[2J\x1b[Hscreen\x1b[2Jmore\x1b[2J");
        let mut result = Vec::new();
        // Short content (0 newlines < 40 rows) — no ESC[3J
        emit_sync_block(&block_data, true, 40, &mut result);

        // No ESC[2J should remain anywhere in the output
        assert!(!result.windows(4).any(|w| w == b"\x1b[2J"),
            "all ESC[2J must be stripped from full redraw output");
        // Structure: BSU + ESC[H ESC[J + stripped content + ESU (no ESC[3J)
        assert!(result.starts_with(b"\x1b[?2026h\x1b[H\x1b[J"),
            "full redraw must have BSU + ESC[H + ESC[J prefix");
        assert!(!result.windows(4).any(|w| w == b"\x1b[3J"),
            "short content must NOT emit ESC[3J");
        assert!(result.ends_with(b"\x1b[?2026l"), "must end with ESU");
        // Verify content survived (only ESC[2J removed)
        let inner = &result[8..result.len() - 8]; // skip BSU and ESU
        assert!(inner.windows(6).any(|w| w == b"screen"),
            "screen content must be preserved");
        assert!(inner.windows(4).any(|w| w == b"more"),
            "more content must be preserved");
    }

    // --- emit_sync_block: non-full-redraw must NOT contain ESC[3J ---
    #[test]
    fn test_emit_sync_block_non_full_redraw_no_scrollback_clear() {
        let mut result = Vec::new();
        emit_sync_block(b"some update", false, 40, &mut result);
        assert!(!result.windows(4).any(|w| w == b"\x1b[3J"),
            "non-full-redraw must NOT emit ESC[3J (scrollback clear)");
    }

    // --- emit_sync_block: ESC[3J is conditional on content height ---
    #[test]
    fn test_emit_sync_block_short_content_no_scrollback_clear() {
        let mut result = Vec::new();
        // 0 newlines < 40 rows — no ESC[3J
        emit_sync_block(b"\x1b[2Jcontent", true, 40, &mut result);

        assert!(!result.windows(4).any(|w| w == b"\x1b[3J"),
            "short content must NOT emit ESC[3J");
        assert!(result.windows(3).any(|w| w == b"\x1b[H"),
            "ESC[H must be present in full redraw");
        assert!(result.windows(3).any(|w| w == b"\x1b[J"),
            "ESC[J must be present in full redraw");
    }

    #[test]
    fn test_emit_sync_block_long_content_has_scrollback_clear() {
        // Build content with 41 newlines (>= 40 rows) — triggers ESC[3J
        let mut data = Vec::new();
        for i in 0..41 {
            data.extend_from_slice(format!("line{}\n", i).as_bytes());
        }
        let mut result = Vec::new();
        emit_sync_block(&data, true, 40, &mut result);

        assert!(result.windows(4).any(|w| w == b"\x1b[3J"),
            "long content (>= rows newlines) MUST emit ESC[3J");
        assert!(result.windows(3).any(|w| w == b"\x1b[H"),
            "ESC[H must be present in full redraw");
    }

    // --- Boundary tests: exactly rows-1 vs exactly rows newlines ---
    #[test]
    fn test_emit_sync_block_boundary_below_no_scrollback_clear() {
        // Exactly 39 newlines (rows-1) — should NOT emit ESC[3J
        let mut data = Vec::new();
        for i in 0..39 {
            data.extend_from_slice(format!("l{}\n", i).as_bytes());
        }
        let mut result = Vec::new();
        emit_sync_block(&data, true, 40, &mut result);
        assert!(!result.windows(4).any(|w| w == b"\x1b[3J"),
            "exactly rows-1 newlines must NOT emit ESC[3J");
    }

    #[test]
    fn test_emit_sync_block_boundary_at_rows_has_scrollback_clear() {
        // Exactly 40 newlines (== rows) — should emit ESC[3J
        let mut data = Vec::new();
        for i in 0..40 {
            data.extend_from_slice(format!("l{}\n", i).as_bytes());
        }
        let mut result = Vec::new();
        emit_sync_block(&data, true, 40, &mut result);
        assert!(result.windows(4).any(|w| w == b"\x1b[3J"),
            "exactly rows newlines MUST emit ESC[3J");
    }

    // --- emit_sync_block: empty data with full redraw ---
    // Edge case: is_full_redraw=true but no content at all
    #[test]
    fn test_emit_sync_block_full_redraw_empty_data() {
        let mut result = Vec::new();
        // Empty data (0 newlines < 40 rows) — no ESC[3J
        emit_sync_block(b"", true, 40, &mut result);
        let mut expected = Vec::new();
        expected.extend_from_slice(b"\x1b[?2026h");
        expected.extend_from_slice(b"\x1b[H\x1b[J");
        expected.extend_from_slice(b"\x1b[?2026l");
        assert_eq!(result, expected);
    }

    // --- End-to-end pipeline: short full redraw preserves scrollback ---
    #[test]
    fn test_pipeline_short_full_redraw_preserves_scrollback() {
        let mut detector = SyncBlockDetector::new();
        let mut input = Vec::new();
        input.extend_from_slice(b"\x1b[?2026h"); // BSU
        input.extend_from_slice(b"\x1b[2J");     // Clear screen
        input.extend_from_slice(b"\x1b[H");      // Cursor home → full redraw
        input.extend_from_slice(b"full conversation re-render");
        input.extend_from_slice(b"\x1b[?2026l"); // ESU

        let events = detector.process(&input);
        let mut result = Vec::new();
        for event in &events {
            match event {
                SyncEvent::PassThrough(data) => result.extend_from_slice(data),
                SyncEvent::SyncBlock { data, is_full_redraw } => {
                    emit_sync_block(data, *is_full_redraw, 40, &mut result);
                }
            }
        }

        // Short content — no ESC[3J (scrollback preserved)
        assert!(!result.windows(4).any(|w| w == b"\x1b[3J"),
            "short full redraw must NOT emit ESC[3J");
        // Must NOT contain ESC[2J (original clear screen should be stripped)
        assert!(!result.windows(4).any(|w| w == b"\x1b[2J"),
            "full redraw pipeline must strip ESC[2J");
        // Content must survive
        assert!(result.windows(10).any(|w| w == b"full conve"),
            "content must be preserved through pipeline");
    }

    // --- End-to-end pipeline: long full redraw clears scrollback ---
    #[test]
    fn test_pipeline_long_full_redraw_clears_scrollback() {
        let mut detector = SyncBlockDetector::new();
        let mut input = Vec::new();
        input.extend_from_slice(b"\x1b[?2026h"); // BSU
        input.extend_from_slice(b"\x1b[2J");     // Clear screen
        input.extend_from_slice(b"\x1b[H");      // Cursor home → full redraw
        for i in 0..50 {
            input.extend_from_slice(format!("line {}\n", i).as_bytes());
        }
        input.extend_from_slice(b"\x1b[?2026l"); // ESU

        let events = detector.process(&input);
        let mut result = Vec::new();
        for event in &events {
            match event {
                SyncEvent::PassThrough(data) => result.extend_from_slice(data),
                SyncEvent::SyncBlock { data, is_full_redraw } => {
                    emit_sync_block(data, *is_full_redraw, 40, &mut result);
                }
            }
        }

        // Long content (50 newlines >= 40 rows) — ESC[3J present
        assert!(result.windows(4).any(|w| w == b"\x1b[3J"),
            "long full redraw MUST emit ESC[3J");
        assert!(!result.windows(4).any(|w| w == b"\x1b[2J"),
            "full redraw pipeline must strip ESC[2J");
    }

    // --- End-to-end: non-full-redraw sync block through detector + emit ---
    // Verifies the full pipeline: detector identifies is_full_redraw=false,
    // then emit_sync_block wraps without stripping ESC[2J.
    #[test]
    fn test_pipeline_non_full_redraw_preserves_clear_screen() {
        let mut detector = SyncBlockDetector::new();
        let mut input = Vec::new();
        input.extend_from_slice(b"\x1b[?2026h"); // BSU
        input.extend_from_slice(b"\x1b[2J");     // Clear screen, no cursor-home
        input.extend_from_slice(b"partial update");
        input.extend_from_slice(b"\x1b[?2026l"); // ESU

        let events = detector.process(&input);
        // Now run through emit_sync_block (as read() would)
        let mut result = Vec::new();
        for event in &events {
            match event {
                SyncEvent::PassThrough(data) => result.extend_from_slice(data),
                SyncEvent::SyncBlock { data, is_full_redraw } => {
                    emit_sync_block(data, *is_full_redraw, 40, &mut result);
                }
            }
        }

        // BSU + block_data + ESU
        assert!(result.starts_with(b"\x1b[?2026h"), "must start with BSU");
        assert!(result.ends_with(b"\x1b[?2026l"), "must end with ESU");
        // ESC[2J must survive -- not stripped because is_full_redraw=false
        let inner = &result[8..result.len() - 8];
        assert!(inner.windows(4).any(|w| w == b"\x1b[2J"),
            "ESC[2J must pass through unchanged for non-full-redraw");
        // No ESC[H ESC[J prepended
        assert!(!inner.starts_with(b"\x1b[H\x1b[J"),
            "non-full-redraw must NOT prepend ESC[H ESC[J");
    }
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

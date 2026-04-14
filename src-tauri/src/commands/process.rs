use tauri::State;

use crate::ActivePids;

// ── Active PID registry (for cleanup on app close) ────────────────

// [RC-11] PID registry: frontend registers PTY child PIDs; lib.rs kills on exit
#[tauri::command]
pub fn register_active_pid(pid: u32, pids: State<'_, ActivePids>) -> Result<(), String> {
    pids.0.lock().unwrap().insert(pid);
    Ok(())
}

#[tauri::command]
pub fn unregister_active_pid(pid: u32, pids: State<'_, ActivePids>) -> Result<(), String> {
    pids.0.lock().unwrap().remove(&pid);
    Ok(())
}

// ── Process tree kill (Windows) ────────────────────────────────────

/// Kill a process and all its descendants by PID.
/// Uses CreateToolhelp32Snapshot to walk the process tree via BFS,
/// then terminates children first, then the root.
#[tauri::command]
pub async fn kill_process_tree(pid: u32) -> Result<(), String> {
    tokio::task::spawn_blocking(move || kill_process_tree_sync(pid))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(target_os = "windows")]
pub(crate) fn kill_process_tree_sync(root_pid: u32) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return Err("CreateToolhelp32Snapshot failed".into());
        }

        // Collect all processes
        let mut entries: Vec<(u32, u32)> = Vec::new(); // (pid, parent_pid)
        let mut entry: PROCESSENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32>() as u32;

        if Process32First(snap, &mut entry) != 0 {
            loop {
                entries.push((entry.th32ProcessID, entry.th32ParentProcessID));
                if Process32Next(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);

        // BFS to find all descendants
        let mut to_kill = Vec::new();
        let mut queue = std::collections::VecDeque::new();
        queue.push_back(root_pid);
        while let Some(parent) = queue.pop_front() {
            for &(pid, ppid) in &entries {
                if ppid == parent && pid != root_pid {
                    to_kill.push(pid);
                    queue.push_back(pid);
                }
            }
        }
        // Kill children first, then root
        to_kill.reverse();
        to_kill.push(root_pid);

        for pid in to_kill {
            let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !handle.is_null() {
                TerminateProcess(handle, 1);
                CloseHandle(handle);
            }
        }
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn kill_process_tree_sync(root_pid: u32) -> Result<(), String> {
    // On non-Windows, just send SIGKILL to the process group
    unsafe {
        libc::kill(-(root_pid as i32), libc::SIGKILL);
    }
    Ok(())
}

// ── Kill session holder ────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct SessionHolderResult {
    /// Number of our own descendant processes killed (safe — stale orphans).
    killed: u32,
    /// PIDs of external processes holding the session (NOT killed).
    external: Vec<u32>,
}

/// Find processes holding a specific session ID. Kills our own descendants
/// automatically (stale orphans from crashed tabs). Returns external holder
/// PIDs so the frontend can prompt the user before killing those.
#[tauri::command]
pub async fn kill_session_holder(session_id: String) -> Result<SessionHolderResult, String> {
    tokio::task::spawn_blocking(move || kill_session_holder_sync(&session_id))
        .await
        .map_err(|e| e.to_string())?
}

/// Force-kill a specific external process by PID (user confirmed).
#[tauri::command]
pub async fn force_kill_session_holder(pid: u32) -> Result<(), String> {
    tokio::task::spawn_blocking(move || kill_process_tree_sync(pid))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(target_os = "windows")]
fn kill_session_holder_sync(session_id: &str) -> Result<SessionHolderResult, String> {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };

    // 1. Find PIDs whose command line contains this session ID
    let output = std::process::Command::new("wmic")
        .args([
            "process",
            "where",
            &format!("CommandLine like '%{}%'", session_id),
            "get",
            "ProcessId",
            "/value",
        ])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| format!("Failed to enumerate processes: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let my_pid = std::process::id();
    let mut matching_pids = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if let Some(pid_str) = line.strip_prefix("ProcessId=") {
            if let Ok(pid) = pid_str.trim().parse::<u32>() {
                if pid != my_pid && pid != 0 {
                    matching_pids.push(pid);
                }
            }
        }
    }

    if matching_pids.is_empty() {
        return Ok(SessionHolderResult {
            killed: 0,
            external: vec![],
        });
    }

    // 2. Build process tree to check ancestry
    let process_tree = unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return Err("CreateToolhelp32Snapshot failed".into());
        }
        let mut entries: Vec<(u32, u32)> = Vec::new();
        let mut entry: PROCESSENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32>() as u32;
        if Process32First(snap, &mut entry) != 0 {
            loop {
                entries.push((entry.th32ProcessID, entry.th32ParentProcessID));
                if Process32Next(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
        entries
    };

    // 3. For each matching PID, walk parent chain to see if it's our descendant
    let mut result = SessionHolderResult {
        killed: 0,
        external: vec![],
    };

    for pid in matching_pids {
        if is_descendant_of(pid, my_pid, &process_tree) {
            if kill_process_tree_sync(pid).is_ok() {
                result.killed += 1;
            }
        } else {
            result.external.push(pid);
        }
    }

    Ok(result)
}

#[cfg(not(target_os = "windows"))]
fn kill_session_holder_sync(session_id: &str) -> Result<SessionHolderResult, String> {
    let output = std::process::Command::new("pgrep")
        .args(["-f", session_id])
        .output()
        .map_err(|e| format!("Failed to enumerate processes: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let my_pid = std::process::id();

    // On Unix, read /proc/<pid>/stat for parent PID
    let process_tree: Vec<(u32, u32)> = std::fs::read_dir("/proc")
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter_map(|e| {
                    let pid: u32 = e.file_name().to_str()?.parse().ok()?;
                    let stat = std::fs::read_to_string(format!("/proc/{}/stat", pid)).ok()?;
                    let ppid: u32 = stat.split_whitespace().nth(3)?.parse().ok()?;
                    Some((pid, ppid))
                })
                .collect()
        })
        .unwrap_or_default();

    let mut result = SessionHolderResult {
        killed: 0,
        external: vec![],
    };

    for line in stdout.lines() {
        if let Ok(pid) = line.trim().parse::<u32>() {
            if pid != my_pid && pid != 0 {
                if is_descendant_of(pid, my_pid, &process_tree) {
                    if kill_process_tree_sync(pid).is_ok() {
                        result.killed += 1;
                    }
                } else {
                    result.external.push(pid);
                }
            }
        }
    }

    Ok(result)
}

/// Walk parent chain to check if `pid` is a descendant of `ancestor`.
fn is_descendant_of(pid: u32, ancestor: u32, tree: &[(u32, u32)]) -> bool {
    let mut current = pid;
    let mut visited = std::collections::HashSet::new();
    while visited.insert(current) {
        if let Some(&(_, ppid)) = tree.iter().find(|&&(p, _)| p == current) {
            if ppid == ancestor {
                return true;
            }
            if ppid == 0 || ppid == current {
                return false;
            }
            current = ppid;
        } else {
            return false;
        }
    }
    false
}

// ── Kill orphan sessions (startup cleanup) ─────────────────────────

// [RC-13] Kill orphans: ancestry check skips processes managed by other instances
/// Kill orphaned processes holding any of the given session IDs.
/// Checks for other running claude-tabs instances first — processes that
/// are descendants of another instance are skipped (they're managed, not
/// orphaned). Only kills true orphans from crashed/force-closed instances.
#[tauri::command]
pub async fn kill_orphan_sessions(session_ids: Vec<String>) -> Result<u32, String> {
    tokio::task::spawn_blocking(move || kill_orphan_sessions_sync(&session_ids))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(target_os = "windows")]
fn kill_orphan_sessions_sync(session_ids: &[String]) -> Result<u32, String> {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };

    if session_ids.is_empty() {
        return Ok(0);
    }

    // Build a single WQL WHERE clause: CommandLine like '%id1%' or CommandLine like '%id2%'
    let where_clause = session_ids
        .iter()
        .map(|id| format!("CommandLine like '%{}%'", id))
        .collect::<Vec<_>>()
        .join(" or ");

    let output = std::process::Command::new("wmic")
        .args([
            "process",
            "where",
            &where_clause,
            "get",
            "ProcessId",
            "/value",
        ])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| format!("Failed to enumerate processes: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let my_pid = std::process::id();
    let mut matching_pids = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if let Some(pid_str) = line.strip_prefix("ProcessId=") {
            if let Ok(pid) = pid_str.trim().parse::<u32>() {
                if pid != my_pid && pid != 0 {
                    matching_pids.push(pid);
                }
            }
        }
    }

    if matching_pids.is_empty() {
        return Ok(0);
    }

    // Find other running instances of our executable to avoid killing their sessions.
    // Uses our own exe filename so it works for debug/release/renamed binaries.
    let other_instances: Vec<u32> = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .and_then(|name| {
            std::process::Command::new("wmic")
                .args([
                    "process",
                    "where",
                    &format!("Name='{}'", name),
                    "get",
                    "ProcessId",
                    "/value",
                ])
                .creation_flags(0x08000000)
                .output()
                .ok()
        })
        .map(|out| {
            let s = String::from_utf8_lossy(&out.stdout);
            s.lines()
                .filter_map(|l| l.trim().strip_prefix("ProcessId="))
                .filter_map(|s| s.trim().parse::<u32>().ok())
                .filter(|&pid| pid != my_pid && pid != 0)
                .collect()
        })
        .unwrap_or_default();

    let mut killed = 0u32;

    if other_instances.is_empty() {
        // No other instances — all matches are orphans (original fast path)
        for pid in matching_pids {
            if kill_process_tree_sync(pid).is_ok() {
                killed += 1;
            }
        }
    } else {
        // Other instance(s) running — only kill processes NOT managed by them
        let process_tree = unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                // Snapshot failed — fall back to killing nothing (safe default)
                return Ok(0);
            }
            let mut entries: Vec<(u32, u32)> = Vec::new();
            let mut entry: PROCESSENTRY32 = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32>() as u32;
            if Process32First(snap, &mut entry) != 0 {
                loop {
                    entries.push((entry.th32ProcessID, entry.th32ParentProcessID));
                    if Process32Next(snap, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snap);
            entries
        };

        for pid in matching_pids {
            let managed = other_instances
                .iter()
                .any(|&inst| is_descendant_of(pid, inst, &process_tree));
            if !managed {
                if kill_process_tree_sync(pid).is_ok() {
                    killed += 1;
                }
            }
        }
    }

    Ok(killed)
}

#[cfg(not(target_os = "windows"))]
fn kill_orphan_sessions_sync(session_ids: &[String]) -> Result<u32, String> {
    if session_ids.is_empty() {
        return Ok(0);
    }

    // Build a single regex alternation: id1|id2|id3
    let pattern = session_ids.join("|");

    let output = std::process::Command::new("pgrep")
        .args(["-f", &pattern])
        .output()
        .map_err(|e| format!("Failed to enumerate processes: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let my_pid = std::process::id();
    let mut matching_pids = Vec::new();

    for line in stdout.lines() {
        if let Ok(pid) = line.trim().parse::<u32>() {
            if pid != my_pid && pid != 0 {
                matching_pids.push(pid);
            }
        }
    }

    if matching_pids.is_empty() {
        return Ok(0);
    }

    // Find other running instances of our executable to avoid killing their sessions
    let other_instances: Vec<u32> = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .and_then(|name| {
            std::process::Command::new("pgrep")
                .args(["-x", &name])
                .output()
                .ok()
        })
        .map(|out| {
            let s = String::from_utf8_lossy(&out.stdout);
            s.lines()
                .filter_map(|l| l.trim().parse::<u32>().ok())
                .filter(|&pid| pid != my_pid && pid != 0)
                .collect()
        })
        .unwrap_or_default();

    let mut killed = 0u32;

    if other_instances.is_empty() {
        // No other instances — all matches are orphans (original fast path)
        for pid in matching_pids {
            if kill_process_tree_sync(pid).is_ok() {
                killed += 1;
            }
        }
    } else {
        // Other instance(s) running — only kill processes NOT managed by them
        let process_tree: Vec<(u32, u32)> = std::fs::read_dir("/proc")
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .filter_map(|e| {
                        let pid: u32 = e.file_name().to_str()?.parse().ok()?;
                        let stat = std::fs::read_to_string(format!("/proc/{}/stat", pid)).ok()?;
                        let ppid: u32 = stat.split_whitespace().nth(3)?.parse().ok()?;
                        Some((pid, ppid))
                    })
                    .collect()
            })
            .unwrap_or_default();

        for pid in matching_pids {
            let managed = other_instances
                .iter()
                .any(|&inst| is_descendant_of(pid, inst, &process_tree));
            if !managed {
                if kill_process_tree_sync(pid).is_ok() {
                    killed += 1;
                }
            }
        }
    }

    Ok(killed)
}

// [RC-14] WinRT toast with on_activated callback emitting notification-clicked event
#[tauri::command]
pub async fn send_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
    session_id: String,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        tokio::task::spawn_blocking(move || {
            use tauri::Emitter;
            use tauri_winrt_notification::Toast;

            // Debug builds use PowerShell app ID (matches notification plugin behavior);
            // release builds use the bundle identifier
            let app_id = if cfg!(debug_assertions) {
                Toast::POWERSHELL_APP_ID.to_string()
            } else {
                app.config().identifier.clone()
            };

            let app_for_cb = app.clone();

            Toast::new(&app_id)
                .title(&title)
                .text1(&body)
                .on_activated(move |_action| {
                    let _ = app_for_cb.emit("notification-clicked", session_id.clone());
                    Ok(())
                })
                .show()
                .map_err(|e| format!("Toast failed: {e}"))
        })
        .await
        .map_err(|e| e.to_string())?
    }

    // [RT-01] Linux notifications use notify-rust directly so a default-action
    // click can emit notification-clicked with session_id, matching the
    // Windows WinRT Toast path. The FreeDesktop spec invokes an action named
    // "default" when the notification body is clicked (KDE Plasma, GNOME
    // Shell). wait_for_action blocks until the user clicks, dismisses, or the
    // server times out — spawn_blocking keeps it off the async runtime.
    #[cfg(target_os = "linux")]
    {
        tokio::task::spawn_blocking(move || {
            use tauri::Emitter;
            let app_for_cb = app.clone();
            let handle = notify_rust::Notification::new()
                .summary(&title)
                .body(&body)
                .action("default", "default")
                .show()
                .map_err(|e| format!("Notification failed: {e}"))?;
            handle.wait_for_action(move |action| {
                // "__closed" is emitted on dismiss/timeout; only emit the
                // click event when the user actively invoked the default
                // action.
                if action != "__closed" {
                    let _ = app_for_cb.emit("notification-clicked", session_id.clone());
                }
            });
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    // Non-Windows, non-Linux (macOS, BSD, etc.) — fall back to the Tauri
    // plugin's basic show without click-to-switch.
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = session_id;
        app.notification()
            .builder()
            .title(&title)
            .body(&body)
            .show()
            .map_err(|e| format!("Notification failed: {e}"))
    }
}

// [IN-07] Rust side of inspector port probe: TcpListener::bind on 127.0.0.1
/// Check if a TCP port is available for binding on 127.0.0.1.
/// Used by the frontend to find a free port for BUN_INSPECT before spawning.
#[tauri::command]
pub fn check_port_available(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

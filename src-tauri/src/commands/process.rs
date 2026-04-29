use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};

use sysinfo::{Pid, Process, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::State;

use crate::ActivePids;

const DESCENDANT_VISIT_LIMIT: usize = 4096;

#[derive(Clone, Copy)]
struct ProcessIdentity {
    pid: u32,
    start_time: u64,
}

// ── Active PID registry (for cleanup on app close) ────────────────

// [RC-11] PID registry: frontend registers PTY child PIDs; lib.rs kills on exit
#[tauri::command]
pub fn register_active_pid(pid: u32, pids: State<'_, ActivePids>) -> Result<(), String> {
    pids.insert(pid);
    Ok(())
}

#[tauri::command]
pub fn unregister_active_pid(pid: u32, pids: State<'_, ActivePids>) -> Result<(), String> {
    pids.remove(pid);
    Ok(())
}

// ── Process tree kill ──────────────────────────────────────────────

/// Kill a process and all its descendants by PID.
/// Takes a sysinfo process snapshot, walks children in-process, then
/// terminates descendants before the root.
#[tauri::command]
pub async fn kill_process_tree(pid: u32) -> Result<(), String> {
    tokio::task::spawn_blocking(move || kill_process_tree_sync(pid))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn kill_process_tree_sync(root_pid: u32) -> Result<(), String> {
    kill_process_tree_checked(root_pid, None).map(|_| ())
}

fn kill_process_tree_checked(
    root_pid: u32,
    expected_start_time: Option<u64>,
) -> Result<bool, String> {
    let mut system = process_snapshot();
    let root = match system.process(Pid::from_u32(root_pid)) {
        Some(process) => process,
        None => return Ok(false),
    };
    if expected_start_time.is_some_and(|expected| root.start_time() != expected) {
        return Ok(false);
    }

    let children_of = build_children_index(&system);
    let targets = collect_process_tree(&system, &children_of, root_pid);
    if targets.is_empty() {
        return Ok(false);
    }

    for target in targets {
        let pid = Pid::from_u32(target.pid);
        let pids = [pid];
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            true,
            process_refresh_kind(),
        );
        let Some(process) = system.process(pid) else {
            continue;
        };
        if process.start_time() != target.start_time {
            continue;
        }
        if let Err(err) = kill_pid_sync(target.pid) {
            log::debug!("failed to kill pid {}: {}", target.pid, err);
        }
    }

    Ok(true)
}

fn process_refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .with_cmd(UpdateKind::OnlyIfNotSet)
        .with_exe(UpdateKind::OnlyIfNotSet)
        .without_tasks()
}

fn process_snapshot() -> System {
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, process_refresh_kind());
    system
}

fn build_parent_map(system: &System) -> HashMap<u32, u32> {
    system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            process
                .parent()
                .map(|parent| (pid.as_u32(), parent.as_u32()))
        })
        .collect()
}

fn build_children_index(system: &System) -> HashMap<u32, Vec<u32>> {
    let mut children = HashMap::new();
    for (pid, process) in system.processes() {
        if let Some(parent) = process.parent() {
            children
                .entry(parent.as_u32())
                .or_insert_with(Vec::new)
                .push(pid.as_u32());
        }
    }
    children
}

fn collect_process_tree(
    system: &System,
    children_of: &HashMap<u32, Vec<u32>>,
    root_pid: u32,
) -> Vec<ProcessIdentity> {
    let mut targets = Vec::new();
    let mut stack = children_of.get(&root_pid).cloned().unwrap_or_default();
    let mut visited = HashSet::new();
    visited.insert(root_pid);

    while let Some(pid) = stack.pop() {
        if visited.len() >= DESCENDANT_VISIT_LIMIT {
            log::warn!(
                "process tree traversal hit descendant limit while killing root pid {}",
                root_pid
            );
            break;
        }
        if !visited.insert(pid) {
            continue;
        }
        if let Some(process) = system.process(Pid::from_u32(pid)) {
            targets.push(process_identity(pid, process));
        }
        if let Some(children) = children_of.get(&pid) {
            stack.extend(children.iter().copied());
        }
    }

    targets.reverse();
    if let Some(root) = system.process(Pid::from_u32(root_pid)) {
        targets.push(process_identity(root_pid, root));
    }
    targets
}

fn process_identity(pid: u32, process: &Process) -> ProcessIdentity {
    ProcessIdentity {
        pid,
        start_time: process.start_time(),
    }
}

#[cfg(target_os = "windows")]
fn kill_pid_sync(pid: u32) -> Result<(), String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return Ok(());
        }
        let ok = TerminateProcess(handle, 1);
        CloseHandle(handle);
        if ok == 0 {
            return Err(format!("TerminateProcess failed for pid {pid}"));
        }
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn kill_pid_sync(pid: u32) -> Result<(), String> {
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
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

fn kill_session_holder_sync(session_id: &str) -> Result<SessionHolderResult, String> {
    let system = process_snapshot();
    let parents = build_parent_map(&system);
    let my_pid = std::process::id();
    let mut result = SessionHolderResult {
        killed: 0,
        external: vec![],
    };

    for (pid, process) in system.processes() {
        let pid = pid.as_u32();
        if pid == 0 || pid == my_pid || !command_contains(process, session_id) {
            continue;
        }
        let identity = process_identity(pid, process);
        if is_descendant_of(pid, my_pid, &parents) {
            if kill_process_tree_checked(pid, Some(identity.start_time)).unwrap_or(false) {
                result.killed += 1;
            }
        } else {
            result.external.push(pid);
        }
    }

    Ok(result)
}
/// Walk parent chain to check if `pid` is a descendant of `ancestor`.
fn is_descendant_of(pid: u32, ancestor: u32, parents: &HashMap<u32, u32>) -> bool {
    let mut current = pid;
    let mut visited = HashSet::new();
    while visited.insert(current) {
        let Some(&ppid) = parents.get(&current) else {
            return false;
        };
        if ppid == ancestor {
            return true;
        }
        if ppid == 0 || ppid == current {
            return false;
        }
        current = ppid;
    }
    false
}

// ── Kill orphan sessions (startup cleanup) ─────────────────────────

// [RC-13] Kill orphans: ancestry check skips processes managed by other instances
/// Kill orphaned processes holding any of the given session IDs.
/// Checks for other running code-tabs instances first — processes that
/// are descendants of another instance are skipped (they're managed, not
/// orphaned). Only kills true orphans from crashed/force-closed instances.
#[tauri::command]
pub async fn kill_orphan_sessions(session_ids: Vec<String>) -> Result<u32, String> {
    tokio::task::spawn_blocking(move || kill_orphan_sessions_sync(&session_ids))
        .await
        .map_err(|e| e.to_string())?
}

fn kill_orphan_sessions_sync(session_ids: &[String]) -> Result<u32, String> {
    if session_ids.is_empty() {
        return Ok(0);
    }

    let system = process_snapshot();
    let parents = build_parent_map(&system);
    let my_pid = std::process::id();
    let matching: Vec<ProcessIdentity> = system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            let pid = pid.as_u32();
            (pid != 0 && pid != my_pid && command_contains_any(process, session_ids))
                .then(|| process_identity(pid, process))
        })
        .collect();

    if matching.is_empty() {
        return Ok(0);
    }

    let other_instances = other_code_tabs_instances(&system, &parents, my_pid);

    let mut killed = 0u32;
    if other_instances.is_empty() {
        for identity in matching {
            if kill_process_tree_checked(identity.pid, Some(identity.start_time)).unwrap_or(false) {
                killed += 1;
            }
        }
    } else {
        for identity in matching {
            let managed = other_instances
                .iter()
                .any(|&inst| is_descendant_of(identity.pid, inst, &parents));
            if !managed
                && kill_process_tree_checked(identity.pid, Some(identity.start_time))
                    .unwrap_or(false)
            {
                killed += 1;
            }
        }
    }

    Ok(killed)
}

fn command_contains(process: &Process, needle: &str) -> bool {
    process
        .cmd()
        .iter()
        .any(|part| part.to_string_lossy().contains(needle))
}

fn command_contains_any(process: &Process, needles: &[String]) -> bool {
    process.cmd().iter().any(|part| {
        let part = part.to_string_lossy();
        needles.iter().any(|needle| part.contains(needle))
    })
}

fn other_code_tabs_instances(
    system: &System,
    parents: &HashMap<u32, u32>,
    my_pid: u32,
) -> Vec<u32> {
    let Some(exe_name) = current_exe_name() else {
        return Vec::new();
    };

    system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            let pid = pid.as_u32();
            (pid != 0
                && pid != my_pid
                && !is_descendant_of(pid, my_pid, parents)
                && process_exe_name_matches(process, &exe_name))
            .then_some(pid)
        })
        .collect()
}

fn current_exe_name() -> Option<OsString> {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.file_name().map(|name| name.to_os_string()))
}

fn process_exe_name_matches(process: &Process, exe_name: &OsStr) -> bool {
    process
        .exe()
        .and_then(|path| path.file_name())
        .is_some_and(|name| name == exe_name)
        || process.name() == exe_name
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
    // Shell). wait_for_action can block for the notification lifetime, so the
    // Tauri command returns as soon as the notification is shown and a detached
    // OS thread listens for click/dismiss callbacks.
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
            std::thread::spawn(move || {
                handle.wait_for_action(move |action| {
                    // "__closed" is emitted on dismiss/timeout; only emit the
                    // click event when the user actively invoked the default
                    // action.
                    if action != "__closed" {
                        let _ = app_for_cb.emit("notification-clicked", session_id.clone());
                    }
                });
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

#[tauri::command]
pub async fn resolve_api_host(host: String) -> Result<String, String> {
    let host = host.trim().to_string();
    if host.is_empty()
        || host.len() > 253
        || host.contains('/')
        || host.contains('\\')
        || host.contains(':')
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
    {
        return Err("Invalid API host".to_string());
    }

    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::task::spawn_blocking(move || {
            use std::net::ToSocketAddrs;
            (host.as_str(), 443)
                .to_socket_addrs()
                .map_err(|e| e.to_string())?
                .next()
                .map(|addr| addr.ip().to_string())
                .ok_or_else(|| "No addresses found".to_string())
        }),
    )
    .await
    .map_err(|_| "DNS lookup timed out".to_string())?
    .map_err(|e| e.to_string())?
}

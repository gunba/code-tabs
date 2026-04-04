mod commands;
mod file_watcher;
mod output_filter;
mod path_utils;
mod proxy;
mod pty;
mod session;
mod tap_server;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use tauri::Manager;

use file_watcher::FileWatcherState;
use proxy::ProxyState;
use session::SessionManager;
use tap_server::TapServerState;

/// [PT-07] OS PIDs of active PTY child processes, registered by the frontend.
/// Killed on app exit to prevent orphaned Claude Code CLI processes.
pub struct ActivePids(pub Mutex<HashSet<u32>>);

/// Create a Windows Job Object and assign our process to it.
/// All child processes (ConPTY conhost, Claude CLI, etc.) inherit the job.
/// `KILL_ON_JOB_CLOSE` ensures they all die when our process exits.
#[cfg(target_os = "windows")]
fn setup_job_object() {
    use windows_sys::Win32::System::JobObjects::*;
    use windows_sys::Win32::System::Threading::*;
    use windows_sys::Win32::Foundation::*;
    use std::mem;

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            eprintln!("Failed to create job object");
            return;
        }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            eprintln!("Failed to set job object limits");
            CloseHandle(job);
            return;
        }

        let current = GetCurrentProcess();
        let ok = AssignProcessToJobObject(job, current);
        if ok == 0 {
            eprintln!("Failed to assign process to job object");
            CloseHandle(job);
            return;
        }

        // Don't close the handle — it must stay open for the lifetime of the
        // process. When the process exits, Windows closes it automatically,
        // which triggers KILL_ON_JOB_CLOSE for all child processes.
        let _ = job;
    }
}

/// On Linux, become a child subreaper so orphaned descendants are reparented
/// to us instead of init. Combined with ActivePids cleanup on exit, this
/// prevents zombie processes from accumulating.
#[cfg(target_os = "linux")]
fn setup_child_reaper() {
    let ret = unsafe { libc::prctl(36, 1, 0, 0, 0) }; // PR_SET_CHILD_SUBREAPER
    if ret != 0 {
        eprintln!("Failed to set child subreaper (prctl returned {})", ret);
    }
}

pub fn run() {
    // Assign our process to a Job Object with KILL_ON_JOB_CLOSE.
    // When our process exits (clean, crash, or force-close), Windows
    // automatically kills all child processes — including conhost.exe
    // instances spawned by ConPTY and Claude CLI processes.
    #[cfg(target_os = "windows")]
    setup_job_object();

    #[cfg(target_os = "linux")]
    setup_child_reaper();

    // [PT-03] Strip CLAUDECODE env var so spawned PTYs don't think
    // they're nested inside another Claude Code session.
    std::env::remove_var("CLAUDECODE");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    if let Ok(hwnd) = window.hwnd() {
                        let hwnd = hwnd.0 as *mut std::ffi::c_void;
                        use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
                        // DWMWA_CAPTION_COLOR = 35
                        // Color is COLORREF (0x00BBGGRR) — matches --bg-primary (#1f1e1c), darker than tab bar
                        let color: u32 = 0x001C1E1F;
                        let hr = unsafe {
                            DwmSetWindowAttribute(
                                hwnd,
                                35,
                                &color as *const _ as *const _,
                                std::mem::size_of::<u32>() as u32,
                            )
                        };
                        if hr != 0 {
                            log::warn!("DwmSetWindowAttribute(CAPTION_COLOR) failed: HRESULT 0x{:08X}", hr);
                        }
                    }
                }
            }
            Ok(())
        })
        .manage(SessionManager::new())
        .manage(ActivePids(Mutex::new(HashSet::new())))
        .manage(Arc::new(Mutex::new(TapServerState::new())))
        .manage(pty::PtyState::default())
        .manage(ProxyState::new())
        .manage(FileWatcherState::new())
        .invoke_handler(tauri::generate_handler![
            commands::create_session,
            commands::close_session,
            commands::set_active_tab,
            commands::reorder_tabs,
            commands::persist_sessions_json,
            commands::load_persisted_sessions,
            commands::detect_claude_cli,
            commands::build_claude_args,
            commands::discover_builtin_commands,
            commands::discover_settings_schema,
            commands::discover_env_vars,
            commands::fetch_settings_schema,
            commands::discover_plugin_commands,
            commands::list_past_sessions,
            commands::search_session_content,
            commands::check_cli_version,
            commands::get_cli_help,
            commands::read_ui_config,
            commands::write_ui_config,
            commands::discover_hooks,
            commands::save_hooks,
            commands::scan_command_usage,
            commands::read_config_file,
            commands::write_config_file,
            commands::save_event_kinds,
            commands::list_agents,
            commands::list_skills,
            commands::register_active_pid,
            commands::unregister_active_pid,
            commands::kill_process_tree,
            commands::kill_session_holder,
            commands::force_kill_session_holder,
            commands::kill_orphan_sessions,
            commands::send_notification,
            commands::check_port_available,
            commands::shell_open,
            commands::append_tap_data,
            commands::open_tap_log,
            commands::open_session_data_dir,
            commands::cleanup_session_data,
            commands::get_session_data_path,
            commands::migrate_legacy_data,
            commands::prune_worktree,
            commands::plugin_list,
            commands::plugin_install,
            commands::plugin_uninstall,
            commands::plugin_enable,
            commands::plugin_disable,
            commands::resolve_api_host,
            commands::dir_exists,
            commands::git_repo_check,
            commands::start_file_watcher,
            commands::stop_file_watcher,
            commands::add_watch_path,
            commands::compute_file_diff,
            commands::read_file_for_snapshot,
            tap_server::start_tap_server,
            tap_server::stop_tap_server,
            proxy::start_api_proxy,
            proxy::update_provider_config,
            proxy::update_system_prompt_rules,
            proxy::start_traffic_log,
            proxy::stop_traffic_log,
            pty::pty_spawn,
            pty::pty_read,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_exitstatus,
            pty::pty_destroy,
            pty::pty_get_child_pid,
            pty::pty_drain_output,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Claude Tabs")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Flush traffic logs and stop API proxy (single lock acquisition)
                let proxy_state = app_handle.state::<ProxyState>();
                if let Ok(mut s) = proxy_state.0.lock() {
                    for writer in s.traffic_log_files.values_mut() {
                        use std::io::Write;
                        let _ = writer.flush();
                    }
                    s.traffic_log_files.clear();
                    s.traffic_log_paths.clear();
                    if let Some(tx) = s.shutdown_tx.take() {
                        let _ = tx.send(());
                    }
                    s.port = None;
                }
                // Stop all file watchers
                let fw_state = app_handle.state::<FileWatcherState>();
                fw_state.stop_all();
                // Stop all TCP tap server threads
                let tap_state = app_handle.state::<Arc<Mutex<TapServerState>>>();
                if let Ok(mut s) = tap_state.lock() {
                    s.stop_all();
                }
                // [RC-11] Kill all active PTY process trees to prevent orphaned CLI processes
                let active = app_handle.state::<ActivePids>();
                let pids: Vec<u32> = active.0.lock().unwrap().drain().collect();
                for pid in pids {
                    let _ = commands::kill_process_tree_sync(pid);
                }
            }
        });
}

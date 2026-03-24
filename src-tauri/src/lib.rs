mod commands;
mod jsonl_watcher;
mod path_utils;
mod session;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use tauri::Manager;

use jsonl_watcher::WatcherState;
use session::SessionManager;

/// OS PIDs of active PTY child processes, registered by the frontend.
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

pub fn run() {
    // Assign our process to a Job Object with KILL_ON_JOB_CLOSE.
    // When our process exits (clean, crash, or force-close), Windows
    // automatically kills all child processes — including conhost.exe
    // instances spawned by ConPTY and Claude CLI processes.
    #[cfg(target_os = "windows")]
    setup_job_object();

    // Strip CLAUDECODE env var so spawned Claude CLI sessions don't think
    // they're nested inside another Claude Code session. Claude Tabs manages
    // independent sessions — it's not a nested invocation.
    std::env::remove_var("CLAUDECODE");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_pty::init())
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
        .manage(Arc::new(Mutex::new(WatcherState::new())))
        .invoke_handler(tauri::generate_handler![
            commands::create_session,
            commands::close_session,
            commands::get_session,
            commands::list_sessions,
            commands::set_active_tab,
            commands::get_active_tab,
            commands::reorder_tabs,
            commands::update_session_state,
            commands::set_session_pty_id,
            commands::persist_sessions,
            commands::persist_sessions_json,
            commands::load_persisted_sessions,
            commands::detect_claude_cli,
            commands::build_claude_args,
            commands::discover_builtin_commands,
            commands::discover_settings_schema,
            commands::fetch_settings_schema,
            commands::discover_plugin_commands,
            commands::list_past_sessions,
            commands::search_session_content,
            commands::check_cli_version,
            commands::get_cli_help,
            commands::read_ui_config,
            commands::write_ui_config,
            commands::get_first_user_message,
            commands::discover_hooks,
            commands::save_hooks,
            commands::scan_command_usage,
            commands::read_test_commands,
            commands::write_test_commands,
            commands::write_test_state,
            commands::read_config_file,
            commands::write_config_file,
            commands::list_agents,
            commands::register_active_pid,
            commands::unregister_active_pid,
            commands::kill_process_tree,
            commands::kill_session_holder,
            commands::force_kill_session_holder,
            commands::kill_orphan_sessions,
            commands::send_notification,
            jsonl_watcher::find_active_jsonl_session,
            jsonl_watcher::find_continuation_session,
            jsonl_watcher::session_has_conversation,
            jsonl_watcher::start_jsonl_watcher,
            jsonl_watcher::stop_jsonl_watcher,
            jsonl_watcher::start_subagent_watcher,
            jsonl_watcher::stop_subagent_watcher,
            commands::check_port_available,
            commands::shell_open,
            commands::prune_worktree,
            commands::plugin_list,
            commands::plugin_install,
            commands::plugin_uninstall,
            commands::plugin_enable,
            commands::plugin_disable,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Claude Tabs")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Kill all active PTY process trees to prevent orphaned CLI processes
                let active = app_handle.state::<ActivePids>();
                let pids: Vec<u32> = active.0.lock().unwrap().drain().collect();
                for pid in pids {
                    let _ = commands::kill_process_tree_sync(pid);
                }
            }
        });
}

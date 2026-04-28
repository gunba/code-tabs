mod cli_adapter;
mod commands;
pub mod discovery;
mod metrics;
mod observability;
mod path_utils;
mod port;
mod proxy;
mod pty;
mod session;
mod tap_server;
mod weather;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use tauri::Manager;

use observability::record_backend_event;
use proxy::ProxyState;
use session::SessionManager;
use tap_server::TapServerState;

/// [PT-07] OS PIDs of active PTY child processes, registered by the frontend.
/// Killed on app exit to prevent orphaned CLI child processes.
pub struct ActivePids(pub Mutex<HashSet<u32>>);

/// Create a Windows Job Object and assign our process to it.
/// All child processes (ConPTY conhost, agent CLIs, etc.) inherit the job.
/// `KILL_ON_JOB_CLOSE` ensures they all die when our process exits.
#[cfg(target_os = "windows")]
fn setup_job_object() {
    use std::mem;
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::System::JobObjects::*;
    use windows_sys::Win32::System::Threading::*;

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
    // instances spawned by ConPTY and agent CLI processes.
    #[cfg(target_os = "windows")]
    setup_job_object();

    #[cfg(target_os = "linux")]
    setup_child_reaper();

    // [LP-01] WebKit2GTK 4.1 (2.52.1) has an upstream bug in its
    // wp_linux_drm_syncobj_v1 handling: it opts into Wayland explicit sync on
    // NVIDIA 555+ but never calls set_acquire_point() before commit, which kwin
    // rejects with protocol Error 71. Force the GDK X11 backend so the window
    // runs under Xwayland, which does not expose the syncobj protocol — that
    // sidesteps the bug and lets accelerated compositing stay on. Accelerated
    // compositing is what keeps CSS animations compositor-only (no full-page
    // software repaints) and keeps WebGL canvases (xterm) GPU-resident instead
    // of round-tripping through CPU every frame. DMA-BUF is disabled because
    // Xwayland uses X11 buffer sharing and GBM allocation fails on NVIDIA.
    // Measured: kwin SM load ~55% → ~10% vs the pure-Wayland software path.
    // Honor any pre-set value so power users can opt back in.
    #[cfg(target_os = "linux")]
    {
        for (k, v) in [
            ("GDK_BACKEND", "x11"),
            ("WEBKIT_DISABLE_COMPOSITING_MODE", "0"),
            ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
        ] {
            if std::env::var_os(k).is_none() {
                std::env::set_var(k, v);
            }
        }
    }

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
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            record_backend_event(
                &app.handle(),
                "LOG",
                "app",
                None,
                "app.startup",
                "Tauri application setup",
                serde_json::json!({
                    "debugBuild": cfg!(debug_assertions),
                    "platform": std::env::consts::OS,
                    "arch": std::env::consts::ARCH,
                }),
            );
            // [WN-01] Native Windows decorations — no custom titlebar; dark theme set in tauri.conf.json
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
                            log::warn!(
                                "DwmSetWindowAttribute(CAPTION_COLOR) failed: HRESULT 0x{:08X}",
                                hr
                            );
                        }
                    }
                }
            }
            metrics::spawn_collector(app.handle().clone());
            // [WX-01] Weather poll loop driven by cf-ipcountry from proxy responses.
            weather::init(app.handle().clone());
            Ok(())
        })
        .manage(SessionManager::new())
        .manage(ActivePids(Mutex::new(HashSet::new())))
        .manage(Arc::new(Mutex::new(TapServerState::new())))
        .manage(pty::PtyState::default())
        .manage(ProxyState::new())
        .manage(observability::codex_rollout::CodexRolloutState::default())
        // [DR-01] [AR-01] All Rust IPC commands registered through tauri::generate_handler! — sources spread across src-tauri/src/commands/*.rs (session/cli/config/git/process/data), plus output_filter.rs/proxy/mod.rs/tap_server.rs/path_resolve.rs. The bridge between React (WebView2) and Rust runs through this single handler list.
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
            commands::search_jsonl_files,
            commands::read_conversation,
            commands::read_codex_session_messages,
            commands::check_cli_version,
            commands::get_cli_help,
            commands::read_ui_config,
            commands::write_ui_config,
            commands::discover_hooks,
            commands::save_hooks,
            commands::discover_codex_hooks,
            commands::save_codex_hooks,
            commands::scan_command_usage,
            commands::read_config_file,
            commands::write_config_file,
            commands::symlink_config_file,
            commands::read_mcp_servers,
            commands::write_mcp_servers,
            commands::read_codex_mcp_servers,
            commands::write_codex_mcp_servers,
            commands::save_event_kinds,
            commands::list_agents,
            commands::list_skills,
            commands::list_codex_skill_files,
            commands::copy_cli_skills,
            commands::read_codex_plugins,
            commands::set_codex_plugin_enabled,
            commands::remove_codex_plugin_config,
            commands::resolve_skill_file,
            commands::resolve_activity_context_files,
            commands::register_active_pid,
            commands::unregister_active_pid,
            commands::kill_process_tree,
            commands::kill_session_holder,
            commands::force_kill_session_holder,
            commands::kill_orphan_sessions,
            commands::send_notification,
            commands::check_port_available,
            commands::shell_open,
            commands::reveal_in_file_manager,
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
            commands::git_list_changes,
            commands::paths_exist,
            commands::resolve_paths,
            commands::compute_file_diff,
            commands::read_file_for_snapshot,
            commands::get_build_info,
            commands::linux_use_native_chrome,
            commands::fetch_cli_changelog,
            commands::check_latest_cli_version,
            commands::update_cli,
            weather::get_current_weather,
            observability::append_observability_data,
            observability::get_observability_info,
            observability::open_observability_log,
            observability::open_main_devtools,
            tap_server::start_tap_server,
            tap_server::stop_tap_server,
            proxy::start_api_proxy,
            proxy::update_system_prompt_rules,
            proxy::get_rule_match_counts,
            proxy::start_traffic_log,
            proxy::stop_traffic_log,
            commands::detect_codex_cli,
            commands::check_codex_cli_version,
            commands::get_codex_cli_help,
            commands::discover_codex_models,
            commands::discover_codex_cli_options,
            commands::discover_codex_features,
            commands::discover_codex_mcp_servers,
            commands::discover_codex_skills,
            commands::discover_codex_slash_commands,
            commands::discover_codex_settings_schema,
            commands::discover_codex_env_vars,
            commands::insert_codex_toml_key,
            commands::insert_codex_toml_array_entry,
            commands::read_codex_spawn_env,
            commands::write_codex_spawn_env,
            commands::generate_codex_session_title,
            cli_adapter::build_cli_spawn,
            cli_adapter::cli_launch_options,
            observability::codex_rollout::start_codex_rollout,
            observability::codex_rollout::stop_codex_rollout,
            port::port_skill,
            port::port_memory,
            port::port_mcp,
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
        .expect("error while building Code Tabs")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                record_backend_event(
                    &app_handle,
                    "LOG",
                    "app",
                    None,
                    "app.exit",
                    "Application exit requested",
                    serde_json::json!({}),
                );
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
                // Stop all TCP tap server threads
                let tap_state = app_handle.state::<Arc<Mutex<TapServerState>>>();
                let tap_ports = tap_state
                    .lock()
                    .map(|mut s| s.stop_all())
                    .unwrap_or_default();
                for port in tap_ports {
                    tap_server::wake_tap_listener(port);
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

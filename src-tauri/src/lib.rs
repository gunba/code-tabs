mod commands;
mod haiku_proc;
mod jsonl_watcher;
mod session;

use std::sync::{Arc, Mutex};

use jsonl_watcher::WatcherState;
use session::SessionManager;

pub fn run() {
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
        .manage(SessionManager::new())
        .manage(Arc::new(Mutex::new(WatcherState::new())))
        .manage(Arc::new(tokio::sync::Mutex::new(haiku_proc::HaikuState::new())))
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
            commands::discover_plugin_commands,
            commands::list_past_sessions,
            commands::check_cli_version,
            commands::get_cli_help,
            commands::read_ui_config,
            commands::write_ui_config,
            commands::invoke_claude_pipe,
            commands::discover_hooks,
            commands::save_hooks,
            commands::read_test_commands,
            commands::write_test_commands,
            commands::write_test_state,
            jsonl_watcher::find_active_jsonl_session,
            jsonl_watcher::session_has_conversation,
            jsonl_watcher::start_jsonl_watcher,
            jsonl_watcher::stop_jsonl_watcher,
            jsonl_watcher::start_subagent_watcher,
            jsonl_watcher::stop_subagent_watcher,
            haiku_proc::haiku_query,
            haiku_proc::haiku_set_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Claude Tabs");
}

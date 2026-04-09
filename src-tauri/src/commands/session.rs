use tauri::State;

use crate::session::persistence;
use crate::session::types::{Session, SessionConfig};
use crate::session::SessionManager;

// [RC-01] Session CRUD — close_session does not persist; frontend owns persistence
#[tauri::command]
pub fn create_session(
    name: String,
    config: SessionConfig,
    manager: State<'_, SessionManager>,
) -> Result<Session, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let mut config = config;
    config.session_id = Some(id.clone());
    let session = Session::new(id, name, config);
    let session_clone = session.clone();
    manager.add_session(session);
    Ok(session_clone)
}

#[tauri::command]
pub fn close_session(id: String, manager: State<'_, SessionManager>) -> Result<(), String> {
    manager.remove_session(&id);
    // Don't persist here — the frontend owns persistence via persist_sessions_json
    // (Rust-side metadata is stale and would overwrite the frontend's live data).
    Ok(())
}

#[tauri::command]
pub fn set_active_tab(id: String, manager: State<'_, SessionManager>) -> Result<(), String> {
    manager.set_active(&id);
    Ok(())
}

#[tauri::command]
pub fn reorder_tabs(order: Vec<String>, manager: State<'_, SessionManager>) -> Result<(), String> {
    manager.reorder_tabs(order);
    Ok(())
}

// [RC-08] Save/restore sessions — persist_sessions_json accepts frontend JSON directly
/// Save session data directly from the frontend (includes live metadata).
/// The Rust session manager doesn't receive metadata updates from the frontend,
/// so this command lets the frontend persist its own authoritative data.
#[tauri::command]
pub fn persist_sessions_json(json: String) -> Result<(), String> {
    let path = persistence::sessions_file_path();
    std::fs::write(path, json).map_err(|e| format!("Failed to write sessions: {}", e))
}

#[tauri::command]
pub fn load_persisted_sessions(manager: State<'_, SessionManager>) -> Result<Vec<Session>, String> {
    let snapshots = persistence::load_sessions()?;
    manager.restore_from_snapshots(snapshots);
    Ok(manager.list_sessions())
}

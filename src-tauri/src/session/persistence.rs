use std::fs;
use std::path::PathBuf;

use super::types::SessionSnapshot;

fn data_dir() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("claude-tabs");
    fs::create_dir_all(&dir).ok();
    dir
}

fn sessions_file() -> PathBuf {
    data_dir().join("sessions.json")
}

pub fn sessions_file_path() -> PathBuf {
    sessions_file()
}

pub fn load_sessions() -> Result<Vec<SessionSnapshot>, String> {
    let path = sessions_file();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

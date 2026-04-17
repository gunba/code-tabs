// [PO-02] FsEvent schema: tab_id, op (FsOp), path, pid, ppid, process_chain (ancestry), timestamp_ms
// [PO-04] ProcessInfo in process_chain enables "bash -> python -> ripgrep touched foo.rs" display
/// Filesystem event emitted by the process-tree tracer.
///
/// Every event is attributed to the PTY tab that spawned the tracee root
/// (via `tab_id`) and to the specific PID inside that tree that performed
/// the syscall. The `exe` + `argv` fields let the frontend show ancestry
/// like "bash → python → ripgrep touched foo.rs" instead of just a bare PID.
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FsOp {
    /// File opened for reading.
    Read,
    /// File opened for writing (O_WRONLY or O_RDWR).
    Write,
    /// File created (O_CREAT) or truncated (O_TRUNC).
    Create,
    /// File deleted (unlink).
    Delete,
    /// Directory created (mkdir).
    Mkdir,
    /// Directory removed (rmdir).
    Rmdir,
    /// File or directory renamed. `from` is the source path.
    Rename { from: String },
    /// File truncated (truncate / ftruncate).
    Truncate,
    /// File permissions changed (chmod).
    Chmod,
    /// Symlink created.
    Symlink,
}

impl FsOp {
    /// Map an FsOp to the `FileChangeKind` used by the frontend activity store.
    pub fn activity_kind(&self) -> &'static str {
        match self {
            FsOp::Read => "read",
            FsOp::Write => "modified",
            FsOp::Create => "created",
            FsOp::Delete => "deleted",
            FsOp::Mkdir => "created",
            FsOp::Rmdir => "deleted",
            FsOp::Rename { .. } => "renamed",
            FsOp::Truncate => "modified",
            FsOp::Chmod => "modified",
            FsOp::Symlink => "created",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub exe: String,
    pub argv: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEvent {
    /// Identifier of the tab whose tracee tree produced this event. Stamped
    /// by the per-tab tracer; consumers use this to route into the correct
    /// session activity store — no cross-tab leakage.
    pub tab_id: String,
    /// Operation performed.
    pub op: FsOp,
    /// Absolute path the syscall acted on (resolved through dirfd + cwd).
    pub path: String,
    /// PID that executed the syscall.
    pub pid: u32,
    /// Parent PID at the time of the event (from the tracer's live map).
    pub ppid: u32,
    /// Ancestry chain from the touching process up to (but excluding) the
    /// tab root, oldest-first. Populated from the tracer's live ProcessNode
    /// map so the UI can display "bash → python → ripgrep touched foo.rs".
    pub process_chain: Vec<ProcessInfo>,
    /// Wall-clock timestamp in milliseconds since the Unix epoch.
    pub timestamp_ms: u64,
}

pub fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

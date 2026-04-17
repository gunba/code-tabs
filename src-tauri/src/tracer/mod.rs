// [PO-02] Tracer event flow: per-tab thread emits tracer://fs-event; frontend useTapEventProcessor subscribes and routes to addFileActivityFromTracer
// [PO-05] TracerHandle lifecycle: dropping detaches tracer, tracee lifecycle owned by PTY
/// Process-tree filesystem tracer.
///
/// Replaces the old heuristic `bashFileParser.ts` and `git_list_changes`
/// settled-idle poll with kernel-observed filesystem events captured from
/// Claude's process tree.
///
/// Architecture
/// ------------
/// - Each PTY tab spawns its own Claude root and gets its own tracer instance.
/// - Linux: `PTRACE_SEIZE` on the root + `PTRACE_O_TRACEFORK/VFORK/CLONE/EXEC`
///   to auto-follow descendants. The tracee installs a seccomp-bpf filter
///   returning `SECCOMP_RET_TRACE` on a narrow set of file syscalls; only
///   those syscalls round-trip through the tracer.
/// - Windows: `DebugActiveProcess` to follow descendants + DLL-injected
///   shim that hooks `Nt*` file APIs and streams events back over a named
///   pipe. See `tracer/windows.rs`.
///
/// Privileges
/// ----------
/// Everything is done unprivileged. The tracee is our own direct child, so
/// `ptrace`/`DebugActiveProcess` require no additional capabilities. No
/// admin, no CAP_SYS_ADMIN, no driver install. On Linux with
/// `/proc/sys/kernel/yama/ptrace_scope == 2` the tracee uses
/// `PR_SET_PTRACER(getppid())` in `pre_exec` to keep attachment legal.
///
/// Event flow
/// ----------
/// Per-tab tracer thread → `app.emit("tracer://fs-event", FsEvent)` →
/// frontend `useTapEventProcessor.ts` subscribes and calls
/// `activityStore.addFileActivityFromTracer(tabId, event)`.
pub mod event;

#[allow(unused_imports)]
pub use event::{now_ms, FsEvent, FsOp, ProcessInfo};

#[cfg(target_os = "linux")]
pub mod linux;

#[cfg(target_os = "windows")]
pub mod windows;

// ── Public API ──────────────────────────────────────────────────────────

use std::sync::Arc;
#[cfg(target_os = "windows")]
use tauri::AppHandle;

/// Handle returned from the platform tracers. Dropping it detaches the
/// tracer, terminates the tracer thread, and releases the kernel-side
/// attach (ptrace detach / DebugActiveProcessStop). The underlying
/// tracee process is not killed — the PTY owns its lifecycle.
pub struct TracerHandle {
    #[cfg_attr(not(any(target_os = "linux", target_os = "windows")), allow(dead_code))]
    inner: Arc<dyn TracerBackend>,
}

impl Drop for TracerHandle {
    fn drop(&mut self) {
        self.inner.detach();
    }
}

pub trait TracerBackend: Send + Sync {
    fn detach(&self);
}

/// Tracer event name emitted to the frontend.
pub const FS_EVENT: &str = "tracer://fs-event";

/// Wrap a platform-specific backend handle into a cross-platform
/// [`TracerHandle`] so callers don't need `#[cfg]` at the use-site.
#[cfg(target_os = "linux")]
pub fn handle_from_linux(backend: linux::LinuxTracer) -> TracerHandle {
    TracerHandle {
        inner: Arc::new(backend),
    }
}

#[cfg(target_os = "windows")]
pub fn handle_from_windows(backend: windows::WindowsTracer) -> TracerHandle {
    TracerHandle {
        inner: Arc::new(backend),
    }
}

/// Windows-only: attach to an already-spawned child. On Linux the
/// ptrace thread-affinity requirement forces spawn+attach together, so
/// use `linux::spawn_with_tracer` there instead. No-op on unsupported
/// platforms.
#[cfg(target_os = "windows")]
#[allow(unused_variables)]
pub fn attach(
    app: AppHandle,
    tab_id: String,
    root_pid: u32,
    working_dir: Option<String>,
) -> Result<Option<TracerHandle>, String> {
    let backend = windows::attach(app, tab_id, root_pid, working_dir)?;
    Ok(Some(handle_from_windows(backend)))
}

// ── Path noise filter ────────────────────────────────────────────────────

/// Substring fragments that identify paths we never want to surface in the
/// activity log. Paths are normalized to forward slashes before matching so
/// a single list works on both Linux and Windows.
const NOISE_FRAGMENTS: &[&str] = &[
    // Linux virtual filesystems
    "/proc/",
    "/sys/",
    "/dev/",
    "/run/",
    // Common cache / VCS internals (cross-platform after normalization)
    "/.cache/",
    "/node_modules/.cache/",
    "/.git/objects/",
    "/.git/index.lock",
    "/.git/logs/",
    // Editor swap / tilde-backup noise
    "/.swp",
    // Windows virtual filesystems / IPC / OS-managed dirs (also
    // compared against the forward-slash-normalized path, so these
    // fragments use `/` too).
    "/Device/",
    "//./pipe/",
    "/AppData/Local/Temp/",
    "/Windows/Prefetch/",
];

/// True when the path should be filtered out before emission.
/// Normalizes Windows backslashes to forward slashes so the filter
/// table above applies uniformly.
pub fn is_noise(path: &str) -> bool {
    if path.is_empty() {
        return true;
    }
    let normalized: String;
    let slice = if path.contains('\\') {
        normalized = path.replace('\\', "/");
        normalized.as_str()
    } else {
        path
    };
    NOISE_FRAGMENTS.iter().any(|frag| slice.contains(frag))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noise_filter_drops_proc_paths() {
        assert!(is_noise("/proc/self/maps"));
        assert!(is_noise("/sys/fs/cgroup"));
        assert!(is_noise("/home/x/project/.git/objects/ab/cdef"));
        assert!(is_noise("/home/x/project/node_modules/.cache/babel/bar"));
    }

    #[test]
    fn noise_filter_drops_windows_cache_paths() {
        assert!(is_noise(r"C:\Users\x\project\node_modules\.cache\babel\bar"));
        assert!(is_noise(r"C:\Users\x\AppData\Local\Temp\tmp1234.txt"));
        assert!(is_noise(r"\\.\pipe\foo"));
    }

    #[test]
    fn noise_filter_keeps_real_files() {
        assert!(!is_noise("/home/x/project/src/main.rs"));
        assert!(!is_noise("/tmp/scratch.txt"));
        assert!(!is_noise(r"C:\Users\x\project\src\main.rs"));
    }
}

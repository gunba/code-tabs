// [PO-01] Linux tracer: seccomp-bpf filter (OnceLock) + PTRACE_SEIZE + dedicated tracer thread
/// Linux process-tree tracer using seccomp-bpf + ptrace.
///
/// Design
/// ------
/// 1. At app startup, a single BPF program is built via `seccompiler` that
///    returns `SECCOMP_RET_TRACE` for file-related syscalls and
///    `SECCOMP_RET_ALLOW` for everything else. The raw `sock_filter`
///    bytecode is cached globally — rebuilding in pre_exec is unsafe
///    (allocator / lock state) and wasteful.
/// 2. In the PTY child's `pre_exec` hook we call `prctl(PR_SET_NO_NEW_PRIVS)`,
///    `prctl(PR_SET_PTRACER, getppid())`, then install the BPF filter via
///    the `seccomp(2)` syscall. No allocation happens after fork.
/// 3. After `cmd.spawn()` succeeds the parent calls `PTRACE_SEIZE` on the
///    child with `PTRACE_O_TRACEFORK | TRACEVFORK | TRACECLONE | TRACEEXEC
///    | TRACEEXIT | TRACESECCOMP`. Seccomp survives fork; `NO_NEW_PRIVS`
///    propagates across exec, so the filter applies to every descendant.
/// 4. A dedicated tracer thread owns all ptrace operations (ptrace is
///    per-thread-tied). It loops on `waitpid(-1, ..., __WALL)` and handles
///    `PTRACE_EVENT_SECCOMP` by reading syscall args via
///    `process_vm_readv`, resolving paths against `/proc/<pid>/cwd` and
///    `/proc/<pid>/fd/<dirfd>`, and emitting an `FsEvent` to the frontend.
/// 5. A lightweight `ProcessNode` map tracks (pid, ppid, exe, argv) for
///    every attached descendant. `PTRACE_EVENT_EXEC` refreshes exe/argv;
///    `PTRACE_EVENT_EXIT` prunes.
///
/// Correctness notes
/// -----------------
/// - Thread affinity: ptrace callers are tied to the thread that issued
///   `PTRACE_SEIZE`. The tracer thread performs every ptrace call.
/// - Group-stop: `PTRACE_SEIZE` + new-child events arrive as group stops;
///   tracer responds with `PTRACE_CONT` (signal 0) so they resume.
/// - AT_FDCWD (=-100) means "relative to cwd"; any other dirfd means
///   "relative to /proc/<pid>/fd/<dirfd>".
/// - Short-lived grandchildren: seccomp + TRACEFORK together guarantee the
///   tracer sees every child's first syscall — even if the child exits
///   immediately after.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;

use seccompiler::{
    BpfProgram, SeccompAction, SeccompFilter, TargetArch,
};
use tauri::{AppHandle, Emitter};

use super::event::{now_ms, FsEvent, FsOp, ProcessInfo};
use super::{is_noise, TracerBackend, FS_EVENT};

// ── seccomp filter construction (once per process) ───────────────────────

/// File-related syscalls we trap via `SECCOMP_RET_TRACE`. The trace-data
/// constant is arbitrary — the tracer identifies the event via `orig_rax`
/// (the syscall number) at stop time, not via the trace data.
const TRACE_DATA: u32 = 1;

/// Returns the raw BPF bytecode used in pre_exec. Built once on first call
/// and cached. Uses `seccompiler` to generate a program that traces only
/// the narrow set of file-modifying syscalls listed below and allows
/// everything else unchanged.
pub fn seccomp_filter_bytes() -> &'static [libc::sock_filter] {
    static CELL: OnceLock<Vec<libc::sock_filter>> = OnceLock::new();
    CELL.get_or_init(build_seccomp_filter).as_slice()
}

fn build_seccomp_filter() -> Vec<libc::sock_filter> {
    let target: TargetArch = std::env::consts::ARCH
        .try_into()
        .expect("tracer: unsupported target arch for seccomp");

    // All file syscalls we care about. Missing a syscall here silently drops
    // events — add new ones deliberately.
    let file_syscalls: &[libc::c_long] = &[
        libc::SYS_openat,
        #[cfg(not(any(target_arch = "aarch64", target_arch = "riscv64")))]
        libc::SYS_open,
        #[cfg(not(any(target_arch = "aarch64", target_arch = "riscv64")))]
        libc::SYS_creat,
        libc::SYS_unlinkat,
        #[cfg(not(any(target_arch = "aarch64", target_arch = "riscv64")))]
        libc::SYS_unlink,
        libc::SYS_renameat2,
        libc::SYS_renameat,
        #[cfg(not(any(target_arch = "aarch64", target_arch = "riscv64")))]
        libc::SYS_rename,
        libc::SYS_linkat,
        #[cfg(not(any(target_arch = "aarch64", target_arch = "riscv64")))]
        libc::SYS_link,
        libc::SYS_mkdirat,
        #[cfg(not(any(target_arch = "aarch64", target_arch = "riscv64")))]
        libc::SYS_mkdir,
        #[cfg(not(any(target_arch = "aarch64", target_arch = "riscv64")))]
        libc::SYS_rmdir,
        libc::SYS_symlinkat,
        #[cfg(not(any(target_arch = "aarch64", target_arch = "riscv64")))]
        libc::SYS_symlink,
        libc::SYS_truncate,
        libc::SYS_ftruncate,
        libc::SYS_fchmodat,
        #[cfg(not(any(target_arch = "aarch64", target_arch = "riscv64")))]
        libc::SYS_chmod,
    ];

    let rules = file_syscalls
        .iter()
        .map(|&sys| (sys, Vec::new()))
        .collect();

    let filter = SeccompFilter::new(
        rules,
        SeccompAction::Allow,              // mismatch
        SeccompAction::Trace(TRACE_DATA),  // match
        target,
    )
    .expect("tracer: failed to build seccomp filter");

    let program: BpfProgram = filter
        .try_into()
        .expect("tracer: failed to compile seccomp filter");

    // Re-interpret seccompiler's sock_filter into libc's sock_filter. Both
    // are ABI-identical representations of `struct sock_filter` from
    // <linux/filter.h>, but the types come from different crates.
    program
        .into_iter()
        .map(|sf| libc::sock_filter {
            code: sf.code,
            jt: sf.jt,
            jf: sf.jf,
            k: sf.k,
        })
        .collect()
}

/// Install just the seccomp-bpf filter + NoNewPrivs. Used by unit
/// tests that want to verify the filter install without also halting
/// the child on post-execve SIGTRAP. Production `pre_exec` callers use
/// [`install_in_pre_exec`] which additionally invokes `PTRACE_TRACEME`.
pub fn install_seccomp_only() -> std::io::Result<()> {
    let ret = unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
    if ret < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let ppid = unsafe { libc::getppid() };
    let _ = unsafe {
        libc::prctl(
            libc::PR_SET_PTRACER,
            ppid as libc::c_ulong,
            0,
            0,
            0,
        )
    };
    let filter = seccomp_filter_bytes();
    let prog = libc::sock_fprog {
        len: filter.len() as u16,
        filter: filter.as_ptr() as *mut _,
    };
    let ret = unsafe {
        libc::syscall(
            libc::SYS_seccomp,
            libc::SECCOMP_SET_MODE_FILTER,
            0 as libc::c_ulong,
            &prog as *const _ as *const libc::c_void,
        )
    };
    if ret < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Install the seccomp filter on the current thread, then mark the
/// current process as ptrace-willing via `PTRACE_TRACEME`. Called from
/// `pre_exec` in `src-tauri/src/pty/unix.rs`.
///
/// Why TRACEME and not SEIZE-after-spawn
/// -------------------------------------
/// `SECCOMP_RET_TRACE` returns `-ENOSYS` to the caller when no tracer
/// is attached. If we installed the filter in `pre_exec` and only
/// called `PTRACE_SEIZE` from the parent after `spawn()` returned, the
/// dynamic linker's early `openat(".../libc.so")` calls (issued by the
/// kernel's elf loader inside `execve`, before the parent observes the
/// child PID) would return ENOSYS and the exec'd program would die
/// with "cannot open shared object file: Function not implemented".
///
/// `PTRACE_TRACEME` avoids the race: the kernel records that this
/// process is trace-willing, and the *first* instruction after
/// `execve` raises a synthetic `SIGTRAP` that stops the child.
/// `std::process::Command::spawn()` returns immediately after execve
/// succeeds (the close-on-exec pipe closes); the parent then
/// `waitpid`s for the trap, calls `PTRACE_SETOPTIONS`, and resumes
/// the child — now fully attached, before any syscall from the exec'd
/// image runs.
///
/// # Safety
/// Caller must be inside `pre_exec` (post-fork, pre-exec) or equivalent
/// async-signal-safe context. Returns Err(io::Error) on failure so the
/// spawn can bail cleanly before exec.
pub fn install_in_pre_exec() -> std::io::Result<()> {
    install_seccomp_only()?;

    // Mark self as trace-willing. The kernel will SIGTRAP this process
    // at the first instruction after the upcoming execve. Parent
    // synchronously observes the stop and attaches PTRACE_SETOPTIONS.
    // This MUST be the last step — any syscall after TRACEME and
    // before execve would stop the tracee prematurely.
    let ret = unsafe {
        libc::ptrace(PTRACE_TRACEME, 0, 0 as libc::c_long, 0 as libc::c_long)
    };
    if ret < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

// ── Tracer thread ────────────────────────────────────────────────────────

pub struct LinuxTracer {
    shutdown: Arc<AtomicBool>,
}

impl TracerBackend for LinuxTracer {
    fn detach(&self) {
        self.shutdown.store(true, Ordering::Release);
        // Ptrace detaches implicitly when the tracer thread exits. The
        // waitpid loop in the tracer thread polls `shutdown` on each
        // iteration with a short `WNOHANG` fallback. See `tracer_loop`.
    }
}

/// Event emission callback used by [`tracer_loop`]. Boxed so the event
/// loop can be driven either by a Tauri `AppHandle` emitter (in
/// production) or a test collector (in integration tests).
pub type EventSink = Box<dyn Fn(&FsEvent) + Send + 'static>;

/// Build an [`EventSink`] that emits `FsEvent`s to the frontend via
/// the given Tauri `AppHandle`. Used by the production spawn path.
pub fn sink_from_app(app: AppHandle) -> EventSink {
    Box::new(move |ev: &FsEvent| {
        let _ = app.emit(FS_EVENT, ev);
    })
}

/// Spawn a child via the provided [`Command`] *and* attach the tracer
/// in a single dedicated OS thread, so the forking thread and the
/// tracer event loop are the same thread. This is the *only* production
/// entry point; it guarantees ptrace thread affinity without making
/// callers think about it.
///
/// **Thread affinity**: Linux ptrace ties every tracee to the specific
/// kernel thread that became its tracer — for `PTRACE_TRACEME`, that's
/// the thread which called `fork()` via `Command::spawn()`. All
/// subsequent `waitpid`/`PTRACE_*` calls must come from that same
/// thread or they return 0/ESRCH. This function spawns an internal
/// thread that both forks the child and runs the tracer loop for its
/// entire lifetime, so the invariant is preserved without the caller
/// needing to think about OS-level threading.
///
/// The tracer thread runs until the child exits or the returned
/// [`LinuxTracer`] is dropped. Events are delivered to `sink`.
///
/// `cmd` must have `pre_exec` set to call [`install_in_pre_exec`]
/// (that's what installs seccomp + `PTRACE_TRACEME`). Any stdio
/// configuration on `cmd` is preserved.
///
/// Returns `(child_pid, tracer_handle)` after the child has reached
/// its post-execve TRACEME stop and the event loop is running. The
/// `exit_tx` is held by the tracer loop; when it observes the root
/// pid exit (WIFEXITED/WIFSIGNALED) it sends the code once and
/// drops the sender. Callers waiting on the matching receiver (see
/// `pty/unix.rs::UnixPty::wait`) unblock.
pub fn spawn_with_tracer(
    mut cmd: std::process::Command,
    tab_id: String,
    working_dir: Option<String>,
    sink: EventSink,
    exit_tx: std::sync::mpsc::Sender<u32>,
) -> Result<(u32, LinuxTracer), String> {
    use std::sync::mpsc;
    let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<u32, String>>(1);
    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_clone = shutdown.clone();

    thread::Builder::new()
        .name(format!("tracer-{}", tab_id))
        .spawn(move || {
            // Fork + exec happens on THIS thread — it is the tracer of
            // record for all ptrace operations on the tracee.
            let child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("spawn failed: {}", e)));
                    return;
                }
            };
            let pid = child.id();
            // Leak the Child so stdlib doesn't reap or waitpid on drop —
            // the tracer thread owns reaping via waitpid in the loop.
            std::mem::forget(child);

            if let Err(e) = wait_for_traceme_stop(pid) {
                let _ = ready_tx.send(Err(e));
                return;
            }
            if let Err(e) = set_trace_options(pid) {
                let _ = ready_tx.send(Err(e));
                return;
            }
            let cont = unsafe {
                libc::ptrace(PTRACE_CONT, pid as libc::pid_t, 0, 0)
            };
            if cont < 0 {
                let _ = ready_tx.send(Err(format!(
                    "initial PTRACE_CONT failed: {}",
                    std::io::Error::last_os_error()
                )));
                return;
            }
            let _ = ready_tx.send(Ok(pid));
            tracer_loop(
                sink,
                tab_id,
                pid,
                working_dir,
                shutdown_clone,
                Some(exit_tx),
            );
        })
        .map_err(|e| format!("tracer: failed to spawn thread: {}", e))?;

    let pid = ready_rx
        .recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|_| "tracer: spawn thread timed out".to_string())??;
    Ok((pid, LinuxTracer { shutdown }))
}

/// Block until the TRACEME'd child reaches its post-execve SIGTRAP stop.
fn wait_for_traceme_stop(pid: u32) -> Result<(), String> {
    let mut status: libc::c_int = 0;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let ret = unsafe {
            libc::waitpid(pid as libc::pid_t, &mut status, libc::__WALL | libc::WNOHANG)
        };
        if ret == pid as libc::pid_t && libc::WIFSTOPPED(status) {
            return Ok(());
        }
        if ret < 0 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Err(format!("waitpid failed: {}", err));
        }
        if std::time::Instant::now() > deadline {
            return Err(format!(
                "timed out waiting for TRACEME stop on pid={}",
                pid
            ));
        }
        thread::sleep(std::time::Duration::from_millis(2));
    }
}

fn set_trace_options(pid: u32) -> Result<(), String> {
    let options: libc::c_long = (PTRACE_O_TRACEFORK
        | PTRACE_O_TRACEVFORK
        | PTRACE_O_TRACECLONE
        | PTRACE_O_TRACEEXEC
        | PTRACE_O_TRACEEXIT
        | PTRACE_O_TRACESECCOMP) as libc::c_long;

    let ret = unsafe {
        libc::ptrace(
            PTRACE_SETOPTIONS,
            pid as libc::pid_t,
            0 as libc::c_long,
            options,
        )
    };
    if ret < 0 {
        return Err(format!(
            "PTRACE_SETOPTIONS(pid={}) failed: {}",
            pid,
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

// ── ptrace constants ────────────────────────────────────────────────────

// libc on some distros doesn't expose every ptrace op; declare locally.
const PTRACE_TRACEME: libc::c_uint = 0;
const PTRACE_CONT: libc::c_uint = 7;
const PTRACE_DETACH: libc::c_uint = 17;
const PTRACE_GETREGS: libc::c_uint = 12;
const PTRACE_SETOPTIONS: libc::c_uint = 0x4200;
const PTRACE_GETEVENTMSG: libc::c_uint = 0x4201;

const PTRACE_O_TRACEFORK: libc::c_int = 1 << 2;
const PTRACE_O_TRACEVFORK: libc::c_int = 1 << 3;
const PTRACE_O_TRACECLONE: libc::c_int = 1 << 4;
const PTRACE_O_TRACEEXEC: libc::c_int = 1 << 5;
const PTRACE_O_TRACEEXIT: libc::c_int = 1 << 6;
const PTRACE_O_TRACESECCOMP: libc::c_int = 1 << 7;

const PTRACE_EVENT_FORK: libc::c_int = 1;
const PTRACE_EVENT_VFORK: libc::c_int = 2;
const PTRACE_EVENT_CLONE: libc::c_int = 3;
const PTRACE_EVENT_EXEC: libc::c_int = 4;
#[allow(dead_code)]
const PTRACE_EVENT_EXIT: libc::c_int = 6;
const PTRACE_EVENT_SECCOMP: libc::c_int = 7;
const PTRACE_EVENT_STOP: libc::c_int = 128;

// File syscall flag bits we inspect.
const O_WRONLY: u64 = 1;
const O_RDWR: u64 = 2;
const O_CREAT: u64 = 0o100;
const O_TRUNC: u64 = 0o1000;
#[allow(dead_code)]
const AT_FDCWD: i32 = -100;

// ── Process node bookkeeping ─────────────────────────────────────────────
// [PO-04] ProcessNode map: live (pid -> ProcessNode) for ancestry chain construction; EXEC refreshes, EXIT prunes

#[derive(Clone, Debug)]
struct ProcessNode {
    pid: u32,
    ppid: u32,
    exe: String,
    argv: Vec<String>,
}

impl ProcessNode {
    fn from_proc(pid: u32, fallback_ppid: u32) -> Self {
        let exe = std::fs::read_link(format!("/proc/{}/exe", pid))
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let argv = read_cmdline(pid);
        let ppid = read_ppid(pid).unwrap_or(fallback_ppid);
        ProcessNode {
            pid,
            ppid,
            exe,
            argv,
        }
    }

    fn to_info(&self) -> ProcessInfo {
        ProcessInfo {
            pid: self.pid,
            exe: self.exe.clone(),
            argv: self.argv.clone(),
        }
    }
}

fn read_cmdline(pid: u32) -> Vec<String> {
    let bytes = match std::fs::read(format!("/proc/{}/cmdline", pid)) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    bytes
        .split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect()
}

fn read_ppid(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{}/stat", pid)).ok()?;
    // /proc/<pid>/stat: pid (comm) state ppid ...
    // The comm field may contain spaces — find the last ')' and split after.
    let tail = stat.rsplit_once(')').map(|(_, rest)| rest)?;
    let fields: Vec<&str> = tail.split_whitespace().collect();
    // After ')': state (index 0), ppid (index 1)
    fields.get(1)?.parse::<u32>().ok()
}

// ── Main tracer loop ─────────────────────────────────────────────────────

fn tracer_loop(
    sink: EventSink,
    tab_id: String,
    root_pid: u32,
    _working_dir: Option<String>,
    shutdown: Arc<AtomicBool>,
    exit_tx: Option<std::sync::mpsc::Sender<u32>>,
) {
    let mut nodes: HashMap<u32, ProcessNode> = HashMap::new();
    nodes.insert(root_pid, ProcessNode::from_proc(root_pid, 0));
    log::debug!(
        "tracer[{}]: loop started, root_pid={}",
        tab_id, root_pid
    );

    // Track file descriptors opened with write intent so open+subsequent
    // mutation can be classified as "modified" vs the initial "read".
    // For now we emit a single event at syscall-enter; this map is a
    // hook point for future close-based write confirmation.

    loop {
        if shutdown.load(Ordering::Acquire) {
            // Detach the root; descendants auto-detach when the tracer
            // thread exits. PTRACE_DETACH on a running process is a no-op
            // error tolerant path.
            let _ = unsafe {
                libc::ptrace(PTRACE_DETACH, root_pid as libc::pid_t, 0, 0)
            };
            return;
        }

        let mut status: libc::c_int = 0;
        let pid = unsafe {
            libc::waitpid(-1, &mut status, libc::__WALL | libc::WNOHANG)
        };

        if pid == 0 {
            thread::sleep(std::time::Duration::from_millis(5));
            continue;
        }
        if pid < 0 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::ECHILD) {
                return;
            }
            if err.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            log::warn!("tracer: waitpid failed: {}", err);
            return;
        }

        handle_stop(pid as u32, status, &sink, &tab_id, root_pid, &mut nodes, &exit_tx);
    }
}

fn handle_stop(
    pid: u32,
    status: libc::c_int,
    sink: &EventSink,
    tab_id: &str,
    root_pid: u32,
    nodes: &mut HashMap<u32, ProcessNode>,
    exit_tx: &Option<std::sync::mpsc::Sender<u32>>,
) {
    let stopsig = libc::WSTOPSIG(status);
    let event = (status >> 16) & 0xffff;
    if libc::WIFEXITED(status) || libc::WIFSIGNALED(status) {
        // Surface the root pid's exit code to the UnixPty::wait()
        // caller. Grandchildren exits are ignored — PTY lifecycle
        // follows the root only. `send` is a no-op if the receiver
        // has dropped.
        if pid == root_pid {
            let code = if libc::WIFEXITED(status) {
                libc::WEXITSTATUS(status) as u32
            } else {
                // SIGTERM, SIGKILL, etc. — mirror std's convention of
                // 128 + signal for wait.
                (128 + libc::WTERMSIG(status)) as u32
            };
            if let Some(tx) = exit_tx {
                let _ = tx.send(code);
            }
        }
        nodes.remove(&pid);
        return;
    }
    if !libc::WIFSTOPPED(status) {
        return;
    }

    // Signal to forward on PTRACE_CONT. 0 means "suppress"; stop-signals
    // from SIGSTOP etc. should be forwarded so the tracee resumes cleanly.
    let mut sig_to_deliver: libc::c_int = 0;

    if stopsig == libc::SIGTRAP {
        match event {
            PTRACE_EVENT_SECCOMP => {
                on_seccomp(pid, sink, tab_id, root_pid, nodes);
            }
            PTRACE_EVENT_FORK | PTRACE_EVENT_VFORK | PTRACE_EVENT_CLONE => {
                let mut child_pid: libc::c_long = 0;
                unsafe {
                    libc::ptrace(
                        PTRACE_GETEVENTMSG,
                        pid as libc::pid_t,
                        0,
                        &mut child_pid as *mut _ as libc::c_long,
                    );
                }
                if child_pid > 0 {
                    let cpid = child_pid as u32;
                    let node = ProcessNode::from_proc(cpid, pid);
                    nodes.insert(cpid, node);
                }
            }
            PTRACE_EVENT_EXEC => {
                // Argv / exe change across exec — refresh from /proc.
                if let Some(node) = nodes.get_mut(&pid) {
                    *node = ProcessNode::from_proc(pid, node.ppid);
                }
            }
            PTRACE_EVENT_STOP => {
                // Group-stop / PTRACE_EVENT_STOP for newly attached child.
                // Just resume.
            }
            _ => {}
        }
    } else if stopsig == libc::SIGSTOP {
        // Initial stop from PTRACE_SEIZE-style attach — suppress.
    } else {
        // Forward real signals to the tracee so behavior matches untraced.
        sig_to_deliver = stopsig;
    }

    unsafe {
        libc::ptrace(
            PTRACE_CONT,
            pid as libc::pid_t,
            0 as libc::c_long,
            sig_to_deliver as libc::c_long,
        );
    }
}

// ── Seccomp-event handler: read syscall, emit FsEvent ───────────────────

fn on_seccomp(
    pid: u32,
    sink: &EventSink,
    tab_id: &str,
    root_pid: u32,
    nodes: &mut HashMap<u32, ProcessNode>,
) {
    let regs = match read_regs(pid) {
        Some(r) => r,
        None => return,
    };

    let syscall = regs.syscall_num();
    let ev = match classify_syscall(pid, syscall, &regs) {
        Some(ev) => ev,
        None => return,
    };

    if is_noise(&ev.path) {
        return;
    }

    // Snapshot the fields we need so `nodes` is free for the chain walk
    // (build_chain takes an immutable borrow; or_insert_with took a
    // mutable one).
    let ppid = nodes
        .entry(pid)
        .or_insert_with(|| ProcessNode::from_proc(pid, 0))
        .ppid;

    let process_chain = build_chain(pid, root_pid, nodes);

    let fs_event = FsEvent {
        tab_id: tab_id.to_string(),
        op: ev.op,
        path: ev.path,
        pid,
        ppid,
        process_chain,
        timestamp_ms: now_ms(),
    };

    sink(&fs_event);
}

fn build_chain(
    pid: u32,
    root_pid: u32,
    nodes: &HashMap<u32, ProcessNode>,
) -> Vec<ProcessInfo> {
    let mut chain = Vec::new();
    let mut cur = pid;
    let mut guard = 0;
    while cur != root_pid && guard < 32 {
        guard += 1;
        match nodes.get(&cur) {
            Some(n) => {
                chain.push(n.to_info());
                if n.ppid == 0 || n.ppid == cur {
                    break;
                }
                cur = n.ppid;
            }
            None => break,
        }
    }
    chain
}

// ── Classified syscall event ─────────────────────────────────────────────

struct SyscallEvent {
    op: FsOp,
    path: String,
}

fn classify_syscall(pid: u32, syscall: i64, regs: &UserRegs) -> Option<SyscallEvent> {
    // Argument conventions on x86_64:
    //   arg0 = rdi, arg1 = rsi, arg2 = rdx, arg3 = r10, arg4 = r8, arg5 = r9
    // For the syscalls below we only need arg0..arg3.
    //
    // On aarch64 the `UserRegs` struct is populated from NT_PRSTATUS with
    // x0..x7 in `args[]`. See `read_regs`.
    let arg0 = regs.arg(0);
    let arg1 = regs.arg(1);
    let arg2 = regs.arg(2);
    let arg3 = regs.arg(3);

    match syscall {
        // openat(dirfd, pathname, flags, mode?)
        s if is_syscall(s, "openat") => {
            let path = read_path_at(pid, arg0 as i32, arg1)?;
            let flags = arg2;
            Some(SyscallEvent {
                op: open_op(flags),
                path,
            })
        }
        // open(pathname, flags, mode?) — legacy, x86_64 only
        s if is_syscall(s, "open") => {
            let path = read_path_at(pid, AT_FDCWD, arg0)?;
            let flags = arg1;
            Some(SyscallEvent {
                op: open_op(flags),
                path,
            })
        }
        // creat(pathname, mode)
        s if is_syscall(s, "creat") => {
            let path = read_path_at(pid, AT_FDCWD, arg0)?;
            Some(SyscallEvent {
                op: FsOp::Create,
                path,
            })
        }
        // unlinkat(dirfd, pathname, flags)
        s if is_syscall(s, "unlinkat") => {
            let path = read_path_at(pid, arg0 as i32, arg1)?;
            // AT_REMOVEDIR = 0x200 => rmdir semantic
            let op = if arg2 & 0x200 != 0 {
                FsOp::Rmdir
            } else {
                FsOp::Delete
            };
            Some(SyscallEvent { op, path })
        }
        s if is_syscall(s, "unlink") => {
            let path = read_path_at(pid, AT_FDCWD, arg0)?;
            Some(SyscallEvent {
                op: FsOp::Delete,
                path,
            })
        }
        // rename(old, new) / renameat(olddirfd, old, newdirfd, new)
        s if is_syscall(s, "rename") => {
            let from = read_path_at(pid, AT_FDCWD, arg0)?;
            let to = read_path_at(pid, AT_FDCWD, arg1)?;
            Some(SyscallEvent {
                op: FsOp::Rename { from },
                path: to,
            })
        }
        s if is_syscall(s, "renameat") || is_syscall(s, "renameat2") => {
            let from = read_path_at(pid, arg0 as i32, arg1)?;
            let to = read_path_at(pid, arg2 as i32, arg3)?;
            Some(SyscallEvent {
                op: FsOp::Rename { from },
                path: to,
            })
        }
        // mkdir / mkdirat
        s if is_syscall(s, "mkdirat") => {
            let path = read_path_at(pid, arg0 as i32, arg1)?;
            Some(SyscallEvent {
                op: FsOp::Mkdir,
                path,
            })
        }
        s if is_syscall(s, "mkdir") => {
            let path = read_path_at(pid, AT_FDCWD, arg0)?;
            Some(SyscallEvent {
                op: FsOp::Mkdir,
                path,
            })
        }
        // rmdir
        s if is_syscall(s, "rmdir") => {
            let path = read_path_at(pid, AT_FDCWD, arg0)?;
            Some(SyscallEvent {
                op: FsOp::Rmdir,
                path,
            })
        }
        // symlink / symlinkat
        s if is_syscall(s, "symlink") => {
            // symlink(target, linkpath)
            let path = read_path_at(pid, AT_FDCWD, arg1)?;
            Some(SyscallEvent {
                op: FsOp::Symlink,
                path,
            })
        }
        s if is_syscall(s, "symlinkat") => {
            let path = read_path_at(pid, arg1 as i32, arg2)?;
            Some(SyscallEvent {
                op: FsOp::Symlink,
                path,
            })
        }
        // link / linkat
        s if is_syscall(s, "link") => {
            let path = read_path_at(pid, AT_FDCWD, arg1)?;
            Some(SyscallEvent {
                op: FsOp::Create,
                path,
            })
        }
        s if is_syscall(s, "linkat") => {
            let path = read_path_at(pid, arg2 as i32, arg3)?;
            Some(SyscallEvent {
                op: FsOp::Create,
                path,
            })
        }
        // truncate(pathname, length)
        s if is_syscall(s, "truncate") => {
            let path = read_path_at(pid, AT_FDCWD, arg0)?;
            Some(SyscallEvent {
                op: FsOp::Truncate,
                path,
            })
        }
        // ftruncate(fd, length) — resolve fd via /proc/<pid>/fd/<fd>
        s if is_syscall(s, "ftruncate") => {
            let path = resolve_fd(pid, arg0 as i32)?;
            Some(SyscallEvent {
                op: FsOp::Truncate,
                path,
            })
        }
        // chmod / fchmodat
        s if is_syscall(s, "chmod") => {
            let path = read_path_at(pid, AT_FDCWD, arg0)?;
            Some(SyscallEvent {
                op: FsOp::Chmod,
                path,
            })
        }
        s if is_syscall(s, "fchmodat") => {
            let path = read_path_at(pid, arg0 as i32, arg1)?;
            Some(SyscallEvent {
                op: FsOp::Chmod,
                path,
            })
        }
        _ => None,
    }
}

fn open_op(flags: u64) -> FsOp {
    let wants_write = flags & O_WRONLY != 0 || flags & O_RDWR != 0;
    let creates = flags & O_CREAT != 0;
    let truncates = flags & O_TRUNC != 0;
    if creates {
        FsOp::Create
    } else if truncates {
        FsOp::Truncate
    } else if wants_write {
        FsOp::Write
    } else {
        FsOp::Read
    }
}

// Per-architecture syscall comparison that tolerates syscalls that don't
// exist on some arches (e.g. `open` on aarch64). Any missing libc::SYS_*
// at compile time is guarded by the #[cfg] on the caller list.
fn is_syscall(s: i64, name: &str) -> bool {
    // We cannot do arbitrary name lookup at runtime without a table. List
    // mapping table is tiny and matches the seccomp filter.
    macro_rules! check {
        ($sys:ident, $lit:literal) => {
            if name == $lit && s == libc::$sys as i64 {
                return true;
            }
        };
    }
    #[cfg(not(any(target_arch = "aarch64", target_arch = "riscv64")))]
    {
        check!(SYS_open, "open");
        check!(SYS_creat, "creat");
        check!(SYS_unlink, "unlink");
        check!(SYS_rename, "rename");
        check!(SYS_link, "link");
        check!(SYS_mkdir, "mkdir");
        check!(SYS_rmdir, "rmdir");
        check!(SYS_symlink, "symlink");
        check!(SYS_chmod, "chmod");
    }
    check!(SYS_openat, "openat");
    check!(SYS_unlinkat, "unlinkat");
    check!(SYS_renameat, "renameat");
    check!(SYS_renameat2, "renameat2");
    check!(SYS_linkat, "linkat");
    check!(SYS_mkdirat, "mkdirat");
    check!(SYS_symlinkat, "symlinkat");
    check!(SYS_truncate, "truncate");
    check!(SYS_ftruncate, "ftruncate");
    check!(SYS_fchmodat, "fchmodat");
    false
}

// ── Register access + remote memory reads ────────────────────────────────

/// Per-architecture view of the syscall argument registers.
///
/// On x86_64 this maps directly to `user_regs_struct` from
/// `<sys/user.h>`; on aarch64 we populate it from `NT_PRSTATUS` via
/// `PTRACE_GETREGSET`.
#[cfg(target_arch = "x86_64")]
#[repr(C)]
#[derive(Default)]
struct UserRegs {
    r15: u64,
    r14: u64,
    r13: u64,
    r12: u64,
    rbp: u64,
    rbx: u64,
    r11: u64,
    r10: u64,
    r9: u64,
    r8: u64,
    rax: u64,
    rcx: u64,
    rdx: u64,
    rsi: u64,
    rdi: u64,
    orig_rax: u64,
    rip: u64,
    cs: u64,
    eflags: u64,
    rsp: u64,
    ss: u64,
    fs_base: u64,
    gs_base: u64,
    ds: u64,
    es: u64,
    fs: u64,
    gs: u64,
}

#[cfg(target_arch = "x86_64")]
impl UserRegs {
    fn arg(&self, i: usize) -> u64 {
        match i {
            0 => self.rdi,
            1 => self.rsi,
            2 => self.rdx,
            3 => self.r10,
            4 => self.r8,
            5 => self.r9,
            _ => 0,
        }
    }

    fn syscall_num(&self) -> i64 {
        self.orig_rax as i64
    }
}

#[cfg(target_arch = "aarch64")]
#[repr(C)]
#[derive(Default)]
struct UserRegs {
    // Linux kernel uapi `struct user_pt_regs`: x0..x30 + sp + pc + pstate.
    // On aarch64, x8 holds the syscall number and x0..x5 hold args.
    regs: [u64; 31],
    sp: u64,
    pc: u64,
    pstate: u64,
}

#[cfg(target_arch = "aarch64")]
impl UserRegs {
    fn arg(&self, i: usize) -> u64 {
        if i < 6 {
            self.regs[i]
        } else {
            0
        }
    }

    fn syscall_num(&self) -> i64 {
        self.regs[8] as i64
    }
}

#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
compile_error!("tracer: unsupported target architecture (add UserRegs layout)");

fn read_regs(pid: u32) -> Option<UserRegs> {
    #[cfg(target_arch = "x86_64")]
    unsafe {
        let mut regs: UserRegs = std::mem::zeroed();
        let ret = libc::ptrace(
            PTRACE_GETREGS,
            pid as libc::pid_t,
            0 as libc::c_long,
            &mut regs as *mut _ as libc::c_long,
        );
        if ret < 0 {
            return None;
        }
        Some(regs)
    }
    #[cfg(target_arch = "aarch64")]
    unsafe {
        // PTRACE_GETREGSET with NT_PRSTATUS = 1
        let mut regs: UserRegs = std::mem::zeroed();
        let mut iov = libc::iovec {
            iov_base: &mut regs as *mut _ as *mut libc::c_void,
            iov_len: std::mem::size_of::<UserRegs>(),
        };
        const PTRACE_GETREGSET: libc::c_uint = 0x4204;
        const NT_PRSTATUS: libc::c_long = 1;
        let ret = libc::ptrace(
            PTRACE_GETREGSET,
            pid as libc::pid_t,
            NT_PRSTATUS,
            &mut iov as *mut _ as libc::c_long,
        );
        if ret < 0 {
            return None;
        }
        Some(regs)
    }
}

/// Read a null-terminated path from the tracee's address space.
fn read_remote_cstr(pid: u32, addr: u64) -> Option<String> {
    if addr == 0 {
        return None;
    }
    let mut buf = [0u8; 4096];
    let local = libc::iovec {
        iov_base: buf.as_mut_ptr() as *mut libc::c_void,
        iov_len: buf.len(),
    };
    let remote = libc::iovec {
        iov_base: addr as *mut libc::c_void,
        iov_len: buf.len(),
    };
    let n = unsafe {
        libc::process_vm_readv(pid as libc::pid_t, &local, 1, &remote, 1, 0)
    };
    if n < 0 {
        // process_vm_readv can short-read at page boundaries — retry by
        // shrinking the remote iov to the distance to the next page.
        return read_remote_cstr_bytewise(pid, addr);
    }
    let bytes = &buf[..n as usize];
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    Some(String::from_utf8_lossy(&bytes[..end]).into_owned())
}

fn read_remote_cstr_bytewise(pid: u32, addr: u64) -> Option<String> {
    // Slow fallback via /proc/<pid>/mem for unmapped-page edge cases.
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(format!("/proc/{}/mem", pid)).ok()?;
    f.seek(SeekFrom::Start(addr)).ok()?;
    let mut out = Vec::with_capacity(256);
    let mut chunk = [0u8; 256];
    loop {
        let n = f.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        if let Some(idx) = chunk[..n].iter().position(|&b| b == 0) {
            out.extend_from_slice(&chunk[..idx]);
            break;
        }
        out.extend_from_slice(&chunk[..n]);
        if out.len() > 8192 {
            break;
        }
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

fn read_path_at(pid: u32, dirfd: i32, path_addr: u64) -> Option<String> {
    let raw = read_remote_cstr(pid, path_addr)?;
    if raw.is_empty() {
        return None;
    }
    if raw.starts_with('/') {
        return Some(raw);
    }
    let base = if dirfd == AT_FDCWD {
        PathBuf::from(
            std::fs::read_link(format!("/proc/{}/cwd", pid)).ok()?,
        )
    } else {
        PathBuf::from(
            std::fs::read_link(format!("/proc/{}/fd/{}", pid, dirfd)).ok()?,
        )
    };
    let joined = base.join(raw);
    Some(joined.to_string_lossy().into_owned())
}

fn resolve_fd(pid: u32, fd: i32) -> Option<String> {
    std::fs::read_link(format!("/proc/{}/fd/{}", pid, fd))
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seccomp_filter_builds_and_is_nonempty() {
        let filter = seccomp_filter_bytes();
        assert!(
            filter.len() > 1,
            "seccomp filter bytecode should contain at least a prologue + rule",
        );
    }

    #[test]
    fn classify_syscall_maps_open_flags_to_read_vs_write() {
        assert!(matches!(open_op(0), FsOp::Read));
        assert!(matches!(open_op(O_WRONLY), FsOp::Write));
        assert!(matches!(open_op(O_RDWR), FsOp::Write));
        assert!(matches!(open_op(O_CREAT), FsOp::Create));
        assert!(matches!(open_op(O_TRUNC), FsOp::Truncate));
        assert!(matches!(open_op(O_WRONLY | O_CREAT), FsOp::Create));
    }
}

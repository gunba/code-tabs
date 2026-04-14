/// Unix PTY wrapper using openpty + std::process::Command.
///
/// Uses Command::pre_exec (not raw fork) to safely spawn in a Tokio process.
/// Raw fork() is undefined behavior in multi-threaded processes -- only the
/// calling thread is replicated, leaving Tokio workers dead with inconsistent
/// mutex/allocator state.
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;

/// Writer that wraps a dup'd master fd for PTY stdin.
/// Does NOT own the fd -- UnixPty owns the master fd.
pub struct FdWriter(RawFd);

// SAFETY: FdWriter is only accessed under mutex in Session.
unsafe impl Send for FdWriter {}

impl Write for FdWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = unsafe { libc::write(self.0, buf.as_ptr() as *const _, buf.len()) };
        if n < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(n as usize)
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Reader for the background thread. Does NOT own the fd.
struct FdReader(RawFd);

unsafe impl Send for FdReader {}

impl Read for FdReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = unsafe { libc::read(self.0, buf.as_mut_ptr() as *mut _, buf.len()) };
        if n < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(n as usize)
        }
    }
}

/// Unix PTY handle -- owns the master fd and child process.
pub struct UnixPty {
    master_fd: RawFd,
    child: Child,
}

impl UnixPty {
    /// Resize the PTY.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let ws = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let ret = unsafe { libc::ioctl(self.master_fd, libc::TIOCSWINSZ, &ws) };
        if ret < 0 {
            Err(format!(
                "ioctl TIOCSWINSZ failed: {}",
                io::Error::last_os_error()
            ))
        } else {
            Ok(())
        }
    }

    // [PT-20] Process-group kill: SIGKILL to -pgid tears down the whole group;
    // ESRCH is Ok since the goal (no live processes) is already met.
    /// Kill the entire process group of the child.
    /// pre_exec runs setsid(), so child.id() is the session/process-group id.
    /// Targeting the negative PID cleans up grandchildren (tools spawned by the
    /// CLI) that inherited the session — ConPTY tears down its tree on the
    /// Windows side; this matches that semantic. ESRCH (whole group already
    /// gone) is treated as success since the goal — no live processes — is met.
    pub fn kill(&mut self) -> Result<(), String> {
        let pgid = self.child.id() as i32;
        let ret = unsafe { libc::kill(-pgid, libc::SIGKILL) };
        if ret < 0 {
            let err = io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::ESRCH) {
                return Ok(());
            }
            return Err(format!("kill SIGKILL pgid={} failed: {}", pgid, err));
        }
        Ok(())
    }

    /// Wait for the child to exit (blocking). Returns exit code.
    pub fn wait(&mut self) -> Result<u32, String> {
        let status = self.child.wait().map_err(|e| e.to_string())?;
        Ok(status.code().unwrap_or(1) as u32)
    }

    /// Get the OS process ID.
    pub fn process_id(&self) -> u32 {
        self.child.id()
    }
}

impl Drop for UnixPty {
    fn drop(&mut self) {
        if self.master_fd >= 0 {
            unsafe { libc::close(self.master_fd) };
        }
    }
}

// [PT-21] OwnedFd RAII: openpty_pair returns OwnedFd pair; spawn() wraps each dup in OwnedFd;
// master transferred to UnixPty only after cmd.spawn() succeeds.
/// Create an openpty pair, returning RAII-owned fds that close on drop.
fn openpty_pair(cols: u16, rows: u16) -> Result<(OwnedFd, OwnedFd), String> {
    let mut master: RawFd = -1;
    let mut slave: RawFd = -1;
    let ws = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let ret = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &ws,
        )
    };
    if ret < 0 {
        return Err(format!("openpty failed: {}", io::Error::last_os_error()));
    }
    // SAFETY: openpty returned success; fds are valid and exclusively owned.
    let master = unsafe { OwnedFd::from_raw_fd(master) };
    let slave = unsafe { OwnedFd::from_raw_fd(slave) };
    Ok((master, slave))
}

/// Result of a successful PTY spawn.
pub struct SpawnResult {
    pub pty: UnixPty,
    pub writer: FdWriter,
    pub output_rx: mpsc::Receiver<Vec<u8>>,
    pub process_id: u32,
}

/// Spawn a process attached to a new PTY.
pub fn spawn(
    file: &str,
    args: &[String],
    cols: u16,
    rows: u16,
    cwd: Option<&str>,
    env: &std::collections::BTreeMap<String, String>,
) -> Result<SpawnResult, String> {
    // RAII pair: any early return closes both fds via OwnedFd Drop.
    let (master, slave) = openpty_pair(cols, rows)?;

    // Dup slave for stdout/stderr — Stdio::from_raw_fd consumes one fd each,
    // so stdin/stdout/stderr need three distinct fds. Wrapping each dup in
    // OwnedFd ensures partial-success on the second dup still cleans up the
    // first.
    let slave_stdout_raw = unsafe { libc::dup(slave.as_raw_fd()) };
    if slave_stdout_raw < 0 {
        return Err(format!(
            "dup slave fd (stdout) failed: {}",
            io::Error::last_os_error()
        ));
    }
    let slave_stdout = unsafe { OwnedFd::from_raw_fd(slave_stdout_raw) };
    let slave_stderr_raw = unsafe { libc::dup(slave.as_raw_fd()) };
    if slave_stderr_raw < 0 {
        return Err(format!(
            "dup slave fd (stderr) failed: {}",
            io::Error::last_os_error()
        ));
    }
    let slave_stderr = unsafe { OwnedFd::from_raw_fd(slave_stderr_raw) };

    // Spawn child using Command + pre_exec (safe in multi-threaded process).
    // If cmd.spawn() fails, the Stdio objects drop and close the parent's
    // copies of the slave fds — no leak.
    let child = unsafe {
        let mut cmd = Command::new(file);
        cmd.args(args);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        // [PT-19] TERM/COLORTERM defaults injected before caller env so caller wins on conflict.
        // Default to a color-capable terminal type for color-aware CLIs.
        // Caller env (frontend) wins because it runs after.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        for (k, v) in env {
            cmd.env(k, v);
        }

        cmd.stdin(Stdio::from_raw_fd(slave.into_raw_fd()));
        cmd.stdout(Stdio::from_raw_fd(slave_stdout.into_raw_fd()));
        cmd.stderr(Stdio::from_raw_fd(slave_stderr.into_raw_fd()));

        cmd.pre_exec(move || {
            // Create new session and set controlling terminal
            if libc::setsid() < 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::ioctl(0, libc::TIOCSCTTY, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            // [PT-22] Deliver SIGKILL to this child if the Tauri parent dies
            // for any reason (including SIGKILL / hard crash). Must run AFTER
            // setsid, which clears the parent-death signal. Persists across
            // exec for non-setuid targets. Covers the direct CLI process;
            // grandchildren spawned by the CLI are not covered by PDEATHSIG
            // and would still leak on hard crash (separate follow-up).
            #[cfg(target_os = "linux")]
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong, 0, 0, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });

        cmd.spawn().map_err(|e| e.to_string())?
    };

    let pid = child.id();

    // Transfer master ownership into UnixPty's manual-Drop slot. FdWriter and
    // FdReader carry copies of the int but do not own — UnixPty.Drop is sole
    // closer to keep the existing single-owner pattern.
    let master_fd = master.into_raw_fd();
    let writer = FdWriter(master_fd);

    // [PT-15] Background reader thread: OS thread reads PTY fd (8 KiB) into sync_channel(64)
    let reader_fd = master_fd;
    let (output_tx, output_rx) = mpsc::sync_channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        let mut reader = FdReader(reader_fd);
        let mut buf = vec![0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if output_tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                // EIO on master read is the normal EOF signal once the slave
                // end closes; any other read error also terminates the reader.
                Err(_) => break,
            }
        }
    });

    let pty = UnixPty {
        master_fd,
        child,
    };

    Ok(SpawnResult {
        pty,
        writer,
        output_rx,
        process_id: pid,
    })
}

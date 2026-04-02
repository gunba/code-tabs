/// Unix PTY wrapper using openpty + std::process::Command.
///
/// Uses Command::pre_exec (not raw fork) to safely spawn in a Tokio process.
/// Raw fork() is undefined behavior in multi-threaded processes -- only the
/// calling thread is replicated, leaving Tokio workers dead with inconsistent
/// mutex/allocator state.
use std::io::{self, Read, Write};
use std::os::fd::{FromRawFd, RawFd};
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

    /// Kill the child process.
    pub fn kill(&mut self) -> Result<(), String> {
        self.child.kill().map_err(|e| e.to_string())
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

/// Create an openpty pair, returning (master_fd, slave_fd).
fn openpty_pair(cols: u16, rows: u16) -> Result<(RawFd, RawFd), String> {
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
        Err(format!("openpty failed: {}", io::Error::last_os_error()))
    } else {
        Ok((master, slave))
    }
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
    // 1. Create PTY pair
    let (master, slave) = openpty_pair(cols, rows)?;

    // 2. Dup slave fd for stdout/stderr -- from_raw_fd takes ownership,
    //    so each of stdin/stdout/stderr needs its own fd.
    let slave_stdout = unsafe { libc::dup(slave) };
    let slave_stderr = unsafe { libc::dup(slave) };
    if slave_stdout < 0 || slave_stderr < 0 {
        unsafe {
            libc::close(slave);
            libc::close(master);
            if slave_stdout >= 0 {
                libc::close(slave_stdout);
            }
            if slave_stderr >= 0 {
                libc::close(slave_stderr);
            }
        }
        return Err(format!(
            "dup slave fd failed: {}",
            io::Error::last_os_error()
        ));
    }

    // 3. Spawn child using Command + pre_exec (safe in multi-threaded process)
    let child = unsafe {
        let mut cmd = Command::new(file);
        cmd.args(args);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        for (k, v) in env {
            cmd.env(k, v);
        }

        // Each Stdio::from_raw_fd takes ownership of a unique fd
        cmd.stdin(Stdio::from_raw_fd(slave));
        cmd.stdout(Stdio::from_raw_fd(slave_stdout));
        cmd.stderr(Stdio::from_raw_fd(slave_stderr));

        cmd.pre_exec(move || {
            // Create new session and set controlling terminal
            if libc::setsid() < 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::ioctl(0, libc::TIOCSCTTY, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });

        cmd.spawn().map_err(|e| e.to_string())?
    };
    // Command::spawn transferred ownership of all three slave fds via from_raw_fd.
    // They are closed after the child's dup2 calls.

    let pid = child.id();

    // 4. Create writer (shares master fd -- NOT owned, UnixPty owns it)
    let writer = FdWriter(master);

    // [PT-15] Background reader thread: OS thread reads PTY fd (8 KiB) into sync_channel(64)
    let reader_fd = master;
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
                Err(e) => {
                    // EIO is expected when child exits (master read after slave close)
                    if e.raw_os_error() == Some(libc::EIO) {
                        break;
                    }
                    break;
                }
            }
        }
    });

    let pty = UnixPty {
        master_fd: master,
        child,
    };

    Ok(SpawnResult {
        pty,
        writer,
        output_rx,
        process_id: pid,
    })
}

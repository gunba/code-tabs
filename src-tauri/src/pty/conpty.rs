/// Windows ConPTY wrapper with RAII resource management.
///
/// Provides direct ConPTY access via windows-sys, replacing portable-pty.
/// All handles are cleaned up via Drop impls to prevent resource leaks
/// even on spawn failure paths.
use std::io::{self, Read, Write};
use std::ptr;
use std::sync::mpsc;

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, BOOL, FALSE, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, EXTENDED_STARTUPINFO_PRESENT, INFINITE, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, STARTUPINFOEXW,
};

// ── RAII Wrappers ────────────────────────────────────────────────────

/// Owned Windows HANDLE that closes on drop.
struct OwnedHandle(HANDLE);

// SAFETY: Windows HANDLEs are safe to send/share across threads.
// ConPTY process/thread handles are not thread-affine.
unsafe impl Send for OwnedHandle {}
unsafe impl Sync for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if self.0 != INVALID_HANDLE_VALUE && !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

/// Writer that wraps a pipe handle for PTY stdin via std::fs::File.
/// File::from_raw_handle takes ownership and closes on drop.
pub struct PipeWriter(std::fs::File);

// SAFETY: PipeWriter is only accessed under mutex in Session.
unsafe impl Send for PipeWriter {}

impl Write for PipeWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

/// Reader that wraps a pipe handle for PTY stdout via std::fs::File.
struct PipeReader(std::fs::File);

// SAFETY: PipeReader is moved to dedicated reader thread.
unsafe impl Send for PipeReader {}

impl Read for PipeReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self.0.read(buf) {
            Ok(n) => Ok(n),
            Err(e) if e.raw_os_error() == Some(109) => Ok(0), // ERROR_BROKEN_PIPE = EOF
            Err(e) => Err(e),
        }
    }
}

/// Owned HPCON that closes on drop.
struct OwnedHpcon(HPCON);

// SAFETY: HPCON is thread-safe (ConPTY documentation).
unsafe impl Send for OwnedHpcon {}
unsafe impl Sync for OwnedHpcon {}

impl Drop for OwnedHpcon {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe { ClosePseudoConsole(self.0) };
        }
    }
}

/// Owned attribute list that deletes on drop.
struct OwnedAttrList {
    ptr: LPPROC_THREAD_ATTRIBUTE_LIST,
    _buf: Vec<u8>,
}

impl Drop for OwnedAttrList {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe { DeleteProcThreadAttributeList(self.ptr) };
        }
    }
}

/// RAII ConPTY handle — owns the pseudoconsole + process handles.
/// Dropped when Session is removed from the BTreeMap.
pub struct ConPtyHandle {
    hpcon: OwnedHpcon,
    process_handle: OwnedHandle,
    _thread_handle: OwnedHandle,
}

impl ConPtyHandle {
    /// Resize the pseudoconsole.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let size = COORD {
            X: cols as i16,
            Y: rows as i16,
        };
        let hr = unsafe { ResizePseudoConsole(self.hpcon.0, size) };
        if hr < 0 {
            Err(format!("ResizePseudoConsole failed: HRESULT 0x{:08x}", hr))
        } else {
            Ok(())
        }
    }

    /// Terminate the child process.
    pub fn kill(&self) -> Result<(), String> {
        let ok = unsafe { TerminateProcess(self.process_handle.0, 1) };
        if ok == FALSE {
            Err(format!(
                "TerminateProcess failed: {}",
                io::Error::last_os_error()
            ))
        } else {
            Ok(())
        }
    }

    /// Wait for the child to exit (blocking). Returns exit code.
    pub fn wait(&self) -> Result<u32, String> {
        unsafe {
            WaitForSingleObject(self.process_handle.0, INFINITE);
            let mut exit_code: u32 = 0;
            let ok = GetExitCodeProcess(self.process_handle.0, &mut exit_code);
            if ok == FALSE {
                Err(format!(
                    "GetExitCodeProcess failed: {}",
                    io::Error::last_os_error()
                ))
            } else {
                Ok(exit_code)
            }
        }
    }

}

/// Result of a successful ConPTY spawn.
pub struct SpawnResult {
    pub handle: ConPtyHandle,
    pub writer: PipeWriter,
    pub output_rx: mpsc::Receiver<Vec<u8>>,
    pub process_id: u32,
}

/// Create a pipe pair, returning (read_end, write_end).
fn create_pipe() -> Result<(OwnedHandle, OwnedHandle), String> {
    let mut read: HANDLE = INVALID_HANDLE_VALUE;
    let mut write: HANDLE = INVALID_HANDLE_VALUE;
    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: ptr::null_mut(),
        bInheritHandle: FALSE,
    };
    let ok = unsafe { CreatePipe(&mut read, &mut write, &sa, 0) };
    if ok == FALSE {
        Err(format!("CreatePipe failed: {}", io::Error::last_os_error()))
    } else {
        Ok((OwnedHandle(read), OwnedHandle(write)))
    }
}

/// Build a null-terminated wide string from a Rust string.
fn to_wide_null(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Build a null-terminated wide command line from file + args.
fn build_command_line(file: &str, args: &[String]) -> Vec<u16> {
    let mut cmd = format!("\"{}\"", file);
    for arg in args {
        cmd.push(' ');
        if arg.contains(' ') || arg.contains('"') {
            cmd.push('"');
            cmd.push_str(&arg.replace('"', "\\\""));
            cmd.push('"');
        } else {
            cmd.push_str(arg);
        }
    }
    to_wide_null(&cmd)
}

/// Build a null-terminated wide environment block from key-value pairs.
/// Format: "KEY=VALUE\0KEY=VALUE\0\0"
fn build_env_block(
    env: &std::collections::BTreeMap<String, String>,
) -> Vec<u16> {
    // Start with inherited environment, then overlay
    let mut merged: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();

    // Inherit current process environment
    for (k, v) in std::env::vars() {
        merged.insert(k, v);
    }

    // Overlay provided env vars
    for (k, v) in env {
        merged.insert(k.clone(), v.clone());
    }

    let mut block = Vec::new();
    for (k, v) in &merged {
        let entry = format!("{}={}", k, v);
        block.extend(entry.encode_utf16());
        block.push(0);
    }
    block.push(0); // Double null terminator
    block
}

/// Spawn a process attached to a new ConPTY pseudoconsole.
pub fn spawn(
    file: &str,
    args: &[String],
    cols: u16,
    rows: u16,
    cwd: Option<&str>,
    env: &std::collections::BTreeMap<String, String>,
) -> Result<SpawnResult, String> {
    // 1. Create pipe pairs
    let (pty_input_read, pty_input_write) = create_pipe()?;
    let (pty_output_read, pty_output_write) = create_pipe()?;

    // 2. Create pseudoconsole
    let size = COORD {
        X: cols as i16,
        Y: rows as i16,
    };
    let mut hpcon: HPCON = 0;
    let hr = unsafe {
        CreatePseudoConsole(size, pty_input_read.0, pty_output_write.0, 0, &mut hpcon)
    };
    if hr < 0 {
        return Err(format!(
            "CreatePseudoConsole failed: HRESULT 0x{:08x}",
            hr
        ));
    }
    let hpcon = OwnedHpcon(hpcon);

    // 3. Close ConPTY-owned pipe ends (ConPTY duplicates them internally)
    drop(pty_input_read);
    drop(pty_output_write);

    // 4. Initialize thread attribute list
    let mut attr_size: usize = 0;
    unsafe {
        InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut attr_size);
    }
    let mut attr_buf = vec![0u8; attr_size];
    let attr_list = attr_buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
    let ok = unsafe { InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_size) };
    if ok == FALSE {
        return Err(format!(
            "InitializeProcThreadAttributeList failed: {}",
            io::Error::last_os_error()
        ));
    }
    let attr_list_guard = OwnedAttrList {
        ptr: attr_list,
        _buf: attr_buf,
    };

    // 5. Associate ConPTY with attribute list
    let ok = unsafe {
        UpdateProcThreadAttribute(
            attr_list_guard.ptr,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
            hpcon.0 as *mut _,
            std::mem::size_of::<HPCON>(),
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if ok == FALSE {
        return Err(format!(
            "UpdateProcThreadAttribute failed: {}",
            io::Error::last_os_error()
        ));
    }

    // 6. Create process
    let mut cmd_line = build_command_line(file, args);
    let env_block = build_env_block(env);
    let cwd_wide = cwd.map(to_wide_null);

    let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    si.lpAttributeList = attr_list_guard.ptr;

    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

    // Note: CREATE_NO_WINDOW is intentionally omitted here (despite DR-07).
    // ConPTY IS the console — CREATE_NO_WINDOW prevents the pseudoconsole from
    // attaching to the child, breaking all console I/O. DR-07 applies to headless
    // subprocess helpers, not PTY children that need a functional console.
    let creation_flags = EXTENDED_STARTUPINFO_PRESENT | 0x0400; // CREATE_UNICODE_ENVIRONMENT

    let ok = unsafe {
        CreateProcessW(
            ptr::null(),
            cmd_line.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            FALSE as BOOL,
            creation_flags,
            env_block.as_ptr() as *const _,
            cwd_wide
                .as_ref()
                .map(|w| w.as_ptr())
                .unwrap_or(ptr::null()),
            &si.StartupInfo,
            &mut pi,
        )
    };

    // Attribute list no longer needed after CreateProcessW
    drop(attr_list_guard);

    if ok == FALSE {
        let err = unsafe { GetLastError() };
        return Err(format!("CreateProcessW failed: error {}", err));
    }

    let process_id = pi.dwProcessId;

    // 7. Wrap handles in RAII
    let handle = ConPtyHandle {
        hpcon,
        process_handle: OwnedHandle(pi.hProcess),
        _thread_handle: OwnedHandle(pi.hThread),
    };

    // 8. Extract writer pipe (take ownership via File, prevent Drop on OwnedHandle)
    use std::os::windows::io::FromRawHandle;
    let writer = PipeWriter(unsafe { std::fs::File::from_raw_handle(pty_input_write.0 as *mut _) });
    std::mem::forget(pty_input_write); // File now owns the handle

    // [PT-15] Background reader thread: OS thread reads ConPTY pipe (8 KiB) into sync_channel(64)
    let reader = PipeReader(unsafe { std::fs::File::from_raw_handle(pty_output_read.0 as *mut _) });
    std::mem::forget(pty_output_read); // File now owns the handle

    let (output_tx, output_rx) = mpsc::sync_channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = vec![0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if output_tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    Ok(SpawnResult {
        handle,
        writer,
        output_rx,
        process_id,
    })
}

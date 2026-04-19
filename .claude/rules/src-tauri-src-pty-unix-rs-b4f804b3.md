---
paths:
  - "src-tauri/src/pty/unix.rs"
---

# src-tauri/src/pty/unix.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## PTY Output

- [PT-15 L255] Background reader thread per session: OS thread reads ConPTY pipe (8 KiB buffer) into bounded sync_channel(64). Decouples blocking pipe reads from IPC, enabling timeout-based reads in the pty_read command.

## PTY Spawn

- [PT-20 L80] UnixPty::kill() sends SIGKILL to the negative PGID (libc::kill(-pgid, SIGKILL)) to tear down the entire process group, including grandchildren (tools spawned by the CLI). ESRCH (no such process group) is treated as Ok since the goal — no live processes — is already met. This mirrors ConPTY's Windows-side tree teardown.
- [PT-26 L101] UnixPty.wait() uses stdlib Child.wait() + ExitStatusExt to preserve the 128+signal exit code convention: if the child was killed by signal N, wait() returns 128+N (matching the POSIX shell convention and frontend exitCode checks). The child is wrapped in Mutex<Option<Child>>; take() consumes it so double-wait panics with 'wait already consumed' rather than silently returning 0.
  - src-tauri/src/pty/unix.rs:L102
- [PT-21 L129] openpty_pair() returns an OwnedFd pair so both fds are closed by Drop on any early return. In spawn(), each dup is also wrapped in OwnedFd immediately after creation; Stdio::from_raw_fd consumes the fd via into_raw_fd() only after all dups succeed. The master OwnedFd is converted to a raw int via into_raw_fd() only after cmd.spawn() succeeds and ownership transfers to UnixPty::master_fd.
- [PT-19 L207] TERM=xterm-ghostty, TERM_PROGRAM=ghostty, and COLORTERM=truecolor are injected before the caller-supplied env in unix.rs spawn(), so caller entries win on conflict. This ensures color-aware CLIs get a capable terminal type and enables TUI sync output (see PT-23 for the ghostty-specific DEC 2026 rationale).
  - src-tauri/src/pty/unix.rs:L206
- [PT-23 L208] Linux PTY spawn sets TERM=xterm-ghostty + TERM_PROGRAM=ghostty before the caller env so Claude Code's isSynchronizedOutputSupported() (env-sniff on TERM / TERM_PROGRAM in src/ink/terminal.ts) returns true and the TUI wraps diff frames in BSU/ESU (DEC 2026). Without this, ink.tsx L736 passes skipSyncMarkers=true and emits raw incremental patches; each keystroke's render output lands one-behind in xterm.js because the buffer only flushes when the next input triggers another render. xterm.js 6.0 handles DEC 2026 correctly; ghostty's terminfo is xterm-compatible so color/mouse/key sequences stay identical.
- [PT-22 L234] In unix.rs pre_exec, after setsid/TIOCSCTTY, call prctl(PR_SET_PDEATHSIG, SIGKILL) so the direct PTY child receives SIGKILL when the Tauri parent dies for any reason (hard crash or SIGKILL included). Must run AFTER setsid — setsid clears the parent-death signal. Persists across exec for non-setuid targets. Grandchildren spawned by the CLI are NOT covered by PDEATHSIG; complete tree teardown on hard crash would need cgroups/systemd or a reaper subprocess.

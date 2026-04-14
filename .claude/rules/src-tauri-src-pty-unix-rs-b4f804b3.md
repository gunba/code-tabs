---
paths:
  - "src-tauri/src/pty/unix.rs"
---

# src-tauri/src/pty/unix.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## PTY Output

- [PT-15 L243] Background reader thread per session: OS thread reads ConPTY pipe (8 KiB buffer) into bounded sync_channel(64). Decouples blocking pipe reads from IPC, enabling timeout-based reads in the pty_read command.

## PTY Spawn

- [PT-20 L77] UnixPty::kill() sends SIGKILL to the negative PGID (libc::kill(-pgid, SIGKILL)) to tear down the entire process group, including grandchildren (tools spawned by the CLI). ESRCH (no such process group) is treated as Ok since the goal — no live processes — is already met. This mirrors ConPTY's Windows-side tree teardown.
- [PT-21 L118] openpty_pair() returns an OwnedFd pair so both fds are closed by Drop on any early return. In spawn(), each dup is also wrapped in OwnedFd immediately after creation; Stdio::from_raw_fd consumes the fd via into_raw_fd() only after all dups succeed. The master OwnedFd is converted to a raw int via into_raw_fd() only after cmd.spawn() succeeds and ownership transfers to UnixPty::master_fd.
- [PT-19 L198] TERM=xterm-256color and COLORTERM=truecolor are injected before the caller-supplied env in unix.rs spawn(), so caller entries win on conflict. This ensures color-aware CLIs (e.g., Claude Code) get a capable terminal type even when the frontend env map omits TERM.
- [PT-22 L219] In unix.rs pre_exec, after setsid/TIOCSCTTY, call prctl(PR_SET_PDEATHSIG, SIGKILL) so the direct PTY child receives SIGKILL when the Tauri parent dies for any reason (hard crash or SIGKILL included). Must run AFTER setsid — setsid clears the parent-death signal. Persists across exec for non-setuid targets. Grandchildren spawned by the CLI are NOT covered by PDEATHSIG; complete tree teardown on hard crash would need cgroups/systemd or a reaper subprocess.

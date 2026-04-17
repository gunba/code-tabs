---
paths:
  - "src-tauri/src/tracer/linux.rs"
---

# src-tauri/src/tracer/linux.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Process-Tree Filesystem Tracer

- [PO-01 L1] Linux tracer architecture: seccomp-bpf filter (built once via seccompiler, cached in OnceLock) returns SECCOMP_RET_TRACE for file syscalls (openat, unlinkat, renameat2, mkdirat, symlinkat, truncate, ftruncate, fchmodat etc). Installed in PTY child pre_exec via install_in_pre_exec() which calls PR_SET_NO_NEW_PRIVS + PR_SET_PTRACER(getppid()) + PTRACE_TRACEME. Parent then PTRACE_SEIZEs with TRACEFORK|TRACEVFORK|TRACECLONE|TRACEEXEC|TRACEEXIT|TRACESECCOMP. Dedicated tracer thread loops on waitpid(-1, __WALL) and handles PTRACE_EVENT_SECCOMP stops by reading syscall args via process_vm_readv and resolving paths against /proc/pid/cwd and /proc/pid/fd/dirfd.
  - src-tauri/src/tracer/linux.rs:L1
- [PO-04 L429] ProcessNode map: tracer maintains a live map of (pid -> ProcessNode{ppid, exe, argv}) for every attached descendant. PTRACE_EVENT_EXEC refreshes exe/argv. PTRACE_EVENT_EXIT prunes the node. process_chain in each FsEvent is built by walking the map from touching PID up to (but excluding) the tab root, oldest-first. Enables 'bash -> python -> ripgrep touched foo.rs' ancestry display in ActivityPanel.
  - src-tauri/src/tracer/linux.rs:L22

---
paths:
  - "src-tauri/src/commands/git.rs"
---

# src-tauri/src/commands/git.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Rust Session Commands

- [RC-21 L25] git_list_changes Tauri command in src-tauri/src/commands/git.rs:L30 runs 'git status --porcelain=v1 -z' in the session working directory and returns Vec<GitChange> with absolute paths. Internal parse_porcelain() (git.rs:L50) splits NUL-terminated entries, maps XY status bytes to single-char (M/A/D/R/?), and skips the second path of renames. Async via spawn_blocking with CREATE_NO_WINDOW on Windows. Returns empty Vec on error or non-repo. Frontend polls via runGitScanAndValidate() in useTapEventProcessor on settled-idle; only adds paths not already in visitedPaths (prevents duplicate activity entries for files Claude itself touched).

## Rust System Command Modules

- [RC-19 L140] prune_worktree: runs git worktree remove --force <path> (always forced -- dialog is the confirmation). Async with spawn_blocking + CREATE_NO_WINDOW. Takes worktree_path and project_root (cwd for git).

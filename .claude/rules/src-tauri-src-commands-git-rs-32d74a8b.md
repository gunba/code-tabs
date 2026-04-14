---
paths:
  - "src-tauri/src/commands/git.rs"
---

# src-tauri/src/commands/git.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Rust Session Commands

- [RC-21 L26] git_list_changes(working_dir): Tauri command running git status --porcelain -z in working_dir. Returns Vec<GitChange> (path: absolutized string, kind: created/modified/deleted). Empty Vec when not a git repo or git fails (silent). classify() precedence: ?? -> created; D present -> deleted; xy[0]=='A' -> created (covers AM staged-add+worktree-modify); M/R/C present -> modified. Renames consume the extra NUL-terminated old-path record. Replaces the deleted notify-based file_watcher.rs.

## Rust System Command Modules

- [RC-19 L101] prune_worktree: runs git worktree remove --force <path> (always forced -- dialog is the confirmation). Async with spawn_blocking + CREATE_NO_WINDOW. Takes worktree_path and project_root (cwd for git).

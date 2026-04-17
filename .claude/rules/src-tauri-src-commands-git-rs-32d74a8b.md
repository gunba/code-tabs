---
paths:
  - "src-tauri/src/commands/git.rs"
---

# src-tauri/src/commands/git.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Rust System Command Modules

- [RC-19 L19] prune_worktree: runs git worktree remove --force <path> (always forced -- dialog is the confirmation). Async with spawn_blocking + CREATE_NO_WINDOW. Takes worktree_path and project_root (cwd for git).

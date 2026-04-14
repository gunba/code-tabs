---
paths:
  - "src-tauri/src/file_watcher.rs"
---

# src-tauri/src/file_watcher.rs

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## File Watcher

- [FW-01 L85] Linux FileWatcher uses non-recursive per-directory inotify watches instead of RecursiveMode::Recursive (the Linux setup_watches() is #[cfg(target_os='linux')] only). On startup it walks the tree with ignore::WalkBuilder (respects .gitignore, .git/info/exclude, global excludes, nested .gitignores) and calls watcher.watch(dir, NonRecursive) for each non-ignored directory. The Mutex lock is held across the entire WalkBuilder iteration. On Windows/macOS a single recursive watch covers the whole tree. For new directories created after start, the event loop re-watches them on Linux via watcher.upgrade() in the Create+is_dir branch. Gitignore matcher is built once at start from root .gitignore + .git/info/exclude + hardcoded .git/ rule.

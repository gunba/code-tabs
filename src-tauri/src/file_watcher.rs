use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::observability::record_backend_event;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

const DEBOUNCE_MS: u64 = 200;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChangeEvent {
    pub session_id: String,
    pub path: String,
    pub kind: String,
    pub timestamp_ms: u64,
}

struct SessionWatcherHandle {
    watcher: Arc<Mutex<RecommendedWatcher>>,
}

pub struct FileWatcherState {
    watchers: Mutex<HashMap<String, SessionWatcherHandle>>,
}

impl FileWatcherState {
    pub fn new() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
        }
    }

    pub fn stop_all(&self) {
        if let Ok(mut watchers) = self.watchers.lock() {
            watchers.clear();
        }
    }
}

/// Build a gitignore matcher rooted at `root`. Picks up the root .gitignore,
/// .git/info/exclude, and the user's global core.excludesFile (via the ignore
/// crate). Nested .gitignore files further down the tree are NOT consulted
/// here; on Linux the walk handles them, and on other platforms nested-level
/// ignores only cause spurious events (the top-level rules catch the big
/// directories like target/ and node_modules/ that cause actual problems).
fn build_matcher(root: &Path) -> Gitignore {
    let mut builder = GitignoreBuilder::new(root);

    let root_ignore = root.join(".gitignore");
    if root_ignore.exists() {
        let _ = builder.add(root_ignore);
    }

    let info_exclude = root.join(".git").join("info").join("exclude");
    if info_exclude.exists() {
        let _ = builder.add(info_exclude);
    }

    // Always ignore .git itself — git never tracks it and no one wants events for it.
    let _ = builder.add_line(None, ".git/");

    builder.build().unwrap_or_else(|_| Gitignore::empty())
}

fn is_ignored(matcher: &Gitignore, path: &Path, is_dir: bool) -> bool {
    matches!(
        matcher.matched_path_or_any_parents(path, is_dir),
        ignore::Match::Ignore(_)
    )
}

fn event_kind_str(kind: &EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Create(_) => Some("created"),
        EventKind::Modify(_) => Some("modified"),
        EventKind::Remove(_) => Some("deleted"),
        _ => None,
    }
}

/// [FW-01] Linux: non-recursive per-directory inotify watches via WalkBuilder; Mutex held across walk.
/// Set up inotify watches for every non-ignored directory under `root`.
/// Linux inotify is per-directory — a recursive watch on a large tree
/// (e.g. .claude/worktrees with cargo targets) adds tens of thousands of
/// watches and stalls the app for minutes. Walking with the ignore crate's
/// WalkBuilder respects .gitignore, .git/info/exclude, global excludes,
/// and nested .gitignore files, pruning the watch set to what the user
/// actually cares about. New directories created after start are picked up
/// in the event loop.
#[cfg(target_os = "linux")]
fn setup_watches(watcher: &Mutex<RecommendedWatcher>, root: &Path) -> Result<usize, String> {
    use ignore::WalkBuilder;

    let mut w = watcher.lock().map_err(|e| e.to_string())?;
    let mut count = 0;
    for entry in WalkBuilder::new(root).hidden(false).build() {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.file_type().map_or(false, |t| t.is_dir()) {
            match w.watch(entry.path(), RecursiveMode::NonRecursive) {
                Ok(()) => count += 1,
                Err(e) => {
                    log::warn!(
                        "file_watcher: watch {} failed: {}",
                        entry.path().display(),
                        e
                    );
                }
            }
        }
    }
    Ok(count)
}

/// On Windows/macOS a single recursive watch handles the whole tree at the
/// kernel level with no per-directory overhead, so walking is pure cost.
#[cfg(not(target_os = "linux"))]
fn setup_watches(watcher: &Mutex<RecommendedWatcher>, root: &Path) -> Result<usize, String> {
    watcher
        .lock()
        .map_err(|e| e.to_string())?
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch directory: {e}"))?;
    Ok(1)
}

pub fn start_watcher(
    app_handle: AppHandle,
    session_id: String,
    root_dir: PathBuf,
    state: &FileWatcherState,
) -> Result<(), String> {
    let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
    watchers.remove(&session_id);

    let matcher = build_matcher(&root_dir);

    let (tx, rx) = mpsc::channel::<Result<Event, notify::Error>>();

    let watcher = RecommendedWatcher::new(
        move |res| {
            let _ = tx.send(res);
        },
        Config::default(),
    )
    .map_err(|e| format!("Failed to create watcher: {e}"))?;
    let watcher = Arc::new(Mutex::new(watcher));

    let watch_count = setup_watches(&watcher, &root_dir)?;

    record_backend_event(
        &app_handle,
        "LOG",
        "watcher",
        Some(&session_id),
        "watcher.started",
        "Started file watcher",
        serde_json::json!({
            "rootDir": root_dir.to_string_lossy().to_string(),
            "watchCount": watch_count,
        }),
    );

    let sid = session_id.clone();
    let watcher_weak = Arc::downgrade(&watcher);
    std::thread::spawn(move || {
        event_loop(rx, watcher_weak, app_handle, sid, matcher);
    });

    watchers.insert(session_id, SessionWatcherHandle { watcher });
    Ok(())
}

fn event_loop(
    rx: mpsc::Receiver<Result<Event, notify::Error>>,
    #[cfg_attr(not(target_os = "linux"), allow(unused_variables))] watcher: Weak<
        Mutex<RecommendedWatcher>,
    >,
    app: AppHandle,
    session_id: String,
    matcher: Gitignore,
) {
    loop {
        let first = match rx.recv() {
            Ok(ev) => ev,
            Err(_) => break,
        };

        let mut batch = vec![first];
        let deadline = Instant::now() + Duration::from_millis(DEBOUNCE_MS);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match rx.recv_timeout(remaining) {
                Ok(ev) => batch.push(ev),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }

        let mut seen: HashMap<PathBuf, &'static str> = HashMap::new();
        let batch_start = Instant::now();

        for result in &batch {
            match result {
                Ok(event) => {
                    if let Some(kind_str) = event_kind_str(&event.kind) {
                        let is_create = matches!(event.kind, EventKind::Create(_));
                        for path in &event.paths {
                            let is_dir = path.is_dir();
                            if is_ignored(&matcher, path, is_dir) {
                                continue;
                            }
                            #[cfg(target_os = "linux")]
                            if is_create && is_dir {
                                if let Some(w) = watcher.upgrade() {
                                    if let Ok(mut w) = w.lock() {
                                        let _ = w.watch(path, RecursiveMode::NonRecursive);
                                    }
                                }
                            }
                            seen.insert(path.clone(), kind_str);
                        }
                    }
                }
                Err(e) => {
                    log::warn!("File watcher error for session {session_id}: {e}");
                    record_backend_event(
                        &app,
                        "WARN",
                        "watcher",
                        Some(&session_id),
                        "watcher.event_error",
                        "File watcher reported an error",
                        serde_json::json!({
                            "error": e.to_string(),
                        }),
                    );
                }
            }
        }

        if seen.is_empty() {
            continue;
        }

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let event_name = format!("fs-change-{session_id}");
        let unique_paths = seen.len();
        for (path, kind) in seen {
            let ev = FsChangeEvent {
                session_id: session_id.clone(),
                path: path.to_string_lossy().to_string(),
                kind: kind.to_string(),
                timestamp_ms: now,
            };
            if let Err(e) = app.emit(&event_name, &ev) {
                log::warn!("Failed to emit fs-change: {e}");
            }
        }
        record_backend_event(
            &app,
            if batch_start.elapsed().as_millis() >= 100 {
                "WARN"
            } else {
                "DEBUG"
            },
            "watcher",
            Some(&session_id),
            "watcher.batch_emitted",
            "Emitted debounced file watcher batch",
            serde_json::json!({
                "batchSize": batch.len(),
                "uniquePaths": unique_paths,
                "durationMs": batch_start.elapsed().as_millis() as u64,
            }),
        );
    }
}

pub fn stop_watcher(session_id: &str, state: &FileWatcherState) -> Result<(), String> {
    let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
    watchers.remove(session_id);
    Ok(())
}

pub fn add_watch_path(
    session_id: &str,
    path: &Path,
    state: &FileWatcherState,
) -> Result<(), String> {
    let watcher = {
        let watchers = state.watchers.lock().map_err(|e| e.to_string())?;
        watchers
            .get(session_id)
            .ok_or_else(|| format!("No watcher found for session {session_id}"))?
            .watcher
            .clone()
    };

    let (target, mode) = if path.is_dir() {
        (path.to_path_buf(), RecursiveMode::NonRecursive)
    } else if let Some(parent) = path.parent() {
        (parent.to_path_buf(), RecursiveMode::NonRecursive)
    } else {
        return Err("Cannot determine parent directory for path".into());
    };

    let mut guard = watcher.lock().map_err(|e| e.to_string())?;
    guard
        .watch(&target, mode)
        .map_err(|e| format!("Failed to watch path: {e}"))
}

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "__pycache__",
    ".next",
    "dist",
    "build",
    ".claude",
];

const IGNORED_EXTENSIONS: &[&str] = &["pyc", "o", "swp", "swo"];

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
    watcher: RecommendedWatcher,
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

fn should_ignore(path: &Path, gitignore_patterns: &[String]) -> bool {
    for component in path.components() {
        let name = component.as_os_str().to_string_lossy();
        if IGNORED_DIRS.iter().any(|d| *d == name.as_ref()) {
            return true;
        }
        if name == ".DS_Store" {
            return true;
        }
        for pattern in gitignore_patterns {
            if glob_match::glob_match(pattern, &name) {
                return true;
            }
        }
    }
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        if IGNORED_EXTENSIONS.iter().any(|e| *e == ext) {
            return true;
        }
    }
    false
}

fn parse_gitignore(root_dir: &Path) -> Vec<String> {
    let gitignore_path = root_dir.join(".gitignore");
    match std::fs::read_to_string(&gitignore_path) {
        Ok(content) => content
            .lines()
            .map(|l| l.trim())
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .map(|line| {
                let l = line.strip_suffix('/').unwrap_or(line);
                l.to_string()
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn event_kind_str(kind: &EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Create(_) => Some("created"),
        EventKind::Modify(_) => Some("modified"),
        EventKind::Remove(_) => Some("deleted"),
        _ => None,
    }
}

pub fn start_watcher(
    app_handle: AppHandle,
    session_id: String,
    root_dir: PathBuf,
    state: &FileWatcherState,
) -> Result<(), String> {
    let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
    watchers.remove(&session_id);

    let gitignore_patterns = parse_gitignore(&root_dir);

    let (tx, rx) = mpsc::channel::<Result<Event, notify::Error>>();

    let mut watcher = RecommendedWatcher::new(move |res| {
        let _ = tx.send(res);
    }, Config::default())
    .map_err(|e| format!("Failed to create watcher: {e}"))?;

    watcher
        .watch(&root_dir, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch directory: {e}"))?;

    let sid = session_id.clone();
    let root = root_dir.clone();
    let ignores = gitignore_patterns;
    std::thread::spawn(move || {
        event_loop(rx, &app_handle, &sid, &root, &ignores);
    });

    watchers.insert(session_id, SessionWatcherHandle { watcher });
    Ok(())
}

fn event_loop(
    rx: mpsc::Receiver<Result<Event, notify::Error>>,
    app: &AppHandle,
    session_id: &str,
    root_dir: &Path,
    gitignore_patterns: &[String],
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

        for result in &batch {
            match result {
                Ok(event) => {
                    if let Some(kind_str) = event_kind_str(&event.kind) {
                        for path in &event.paths {
                            let rel = path.strip_prefix(root_dir).unwrap_or(path);
                            if should_ignore(rel, gitignore_patterns) {
                                continue;
                            }
                            seen.insert(path.clone(), kind_str);
                        }
                    }
                }
                Err(e) => {
                    log::warn!("File watcher error for session {session_id}: {e}");
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
        for (path, kind) in seen {
            let ev = FsChangeEvent {
                session_id: session_id.to_string(),
                path: path.to_string_lossy().to_string(),
                kind: kind.to_string(),
                timestamp_ms: now,
            };
            if let Err(e) = app.emit(&event_name, &ev) {
                log::warn!("Failed to emit fs-change: {e}");
            }
        }
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
    let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
    if let Some(handle) = watchers.get_mut(session_id) {
        let mode = if path.is_dir() {
            RecursiveMode::NonRecursive
        } else if let Some(parent) = path.parent() {
            return handle
                .watcher
                .watch(parent, RecursiveMode::NonRecursive)
                .map_err(|e| format!("Failed to watch path: {e}"));
        } else {
            return Err("Cannot determine parent directory for path".into());
        };
        handle
            .watcher
            .watch(path, mode)
            .map_err(|e| format!("Failed to watch path: {e}"))
    } else {
        Err(format!("No watcher found for session {session_id}"))
    }
}

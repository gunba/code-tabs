//! Persistent Haiku child process — hooks directly into Claude.exe's stdin/stdout.
//!
//! Spawns `claude --model haiku` as a regular child process (NOT a PTY).
//! stdin/stdout are piped — no terminal emulation, no ink rendering, no ANSI.
//! The process stays alive; we write prompts to stdin and read responses from stdout.

use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

pub struct HaikuProcess {
    child: Child,
    stdin: tokio::process::ChildStdin,
    stdout_lines: Arc<Mutex<tokio::io::Lines<BufReader<tokio::process::ChildStdout>>>>,
}

pub struct HaikuState {
    proc: Option<HaikuProcess>,
    claude_path: Option<String>,
}

impl HaikuState {
    pub fn new() -> Self {
        Self { proc: None, claude_path: None }
    }
}

/// Spawn (or re-use) the persistent Haiku process.
/// Returns Ok(()) if ready, Err if spawn failed.
async fn ensure_process(state: &mut HaikuState) -> Result<(), String> {
    // Check if existing process is alive
    if let Some(ref mut proc) = state.proc {
        match proc.child.try_wait() {
            Ok(Some(_)) => { state.proc = None; } // Exited, respawn
            Ok(None) => return Ok(()),             // Still alive
            Err(_) => { state.proc = None; }       // Error, respawn
        }
    }

    let claude_path = state.claude_path.as_ref()
        .ok_or("Claude path not set")?
        .clone();

    let mut cmd = Command::new(&claude_path);
    cmd.args(["--model", "haiku", "--dangerously-skip-permissions", "-p", "--output-format", "text"]);
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn haiku: {}", e))?;

    let stdin = child.stdin.take().ok_or("No stdin")?;
    let stdout = child.stdout.take().ok_or("No stdout")?;
    let lines = Arc::new(Mutex::new(BufReader::new(stdout).lines()));

    state.proc = Some(HaikuProcess { child, stdin, stdout_lines: lines });
    Ok(())
}

/// Send a prompt to the persistent Haiku process and collect the response.
/// Uses `-p` mode: writes prompt to stdin, closes stdin, reads all stdout.
/// Then respawns the process for the next query (process exits after `-p`).
#[tauri::command]
pub async fn haiku_query(
    prompt: String,
    system_prompt: String,
    haiku_state: tauri::State<'_, Arc<Mutex<HaikuState>>>,
) -> Result<String, String> {
    let mut state = haiku_state.lock().await;
    ensure_process(&mut state).await?;

    let proc = state.proc.as_mut().ok_or("No haiku process")?;

    // Write the full prompt including system context as a single message
    let full_prompt = if system_prompt.is_empty() {
        prompt
    } else {
        format!("{}\n\n{}", system_prompt, prompt)
    };

    proc.stdin.write_all(full_prompt.as_bytes()).await
        .map_err(|e| format!("stdin write error: {}", e))?;

    // Close stdin to signal EOF — claude -p processes on EOF
    proc.stdin.shutdown().await
        .map_err(|e| format!("stdin shutdown error: {}", e))?;

    // Read all stdout lines until the process exits
    let lines = proc.stdout_lines.clone();
    let mut output = String::new();
    {
        let mut lines_guard = lines.lock().await;
        while let Ok(Some(line)) = lines_guard.next_line().await {
            if !output.is_empty() { output.push('\n'); }
            output.push_str(&line);
        }
    }

    // Process exited (stdin closed → -p mode completes → exits)
    // Clear the proc so next call respawns
    state.proc = None;

    if output.is_empty() {
        Err("Empty response from Haiku".into())
    } else {
        Ok(output)
    }
}

/// Set the claude CLI path for the haiku process.
#[tauri::command]
pub async fn haiku_set_path(
    path: String,
    haiku_state: tauri::State<'_, Arc<Mutex<HaikuState>>>,
) -> Result<(), String> {
    let mut state = haiku_state.lock().await;
    state.claude_path = Some(path);
    Ok(())
}

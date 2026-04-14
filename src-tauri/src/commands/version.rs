// [VA-03] Rust version commands: build info, CLI version check, CLI update with install method detection
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    pub app_version: String,
    pub claude_code_build_version: String,
}

#[tauri::command]
pub fn get_build_info() -> BuildInfo {
    BuildInfo {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        claude_code_build_version: env!("CLAUDE_CODE_BUILD_VERSION").to_string(),
    }
}

// Returns true on Linux + KDE + Wayland — the combination where Tauri's `decorations: false`
// is silently ignored by KWin (upstream tauri/wry bug, see GH issues #6162 / #6562). Frontend
// uses this to skip the custom Header on that combo and let KDE's native titlebar show.
#[tauri::command]
pub fn linux_use_native_chrome() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default();
    if session != "wayland" {
        return false;
    }
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default().to_uppercase();
    desktop.split(':').any(|s| s == "KDE")
}

#[tauri::command]
pub async fn check_latest_cli_version() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| format!("HTTP client error: {e}"))?;
        let resp = client
            .get("https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags")
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.text())
            .map_err(|e| format!("Failed to check npm: {e}"))?;
        let json: serde_json::Value =
            serde_json::from_str(&resp).map_err(|e| format!("Invalid JSON: {e}"))?;
        json["latest"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "No 'latest' field in npm dist-tags response".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Detect how Claude Code CLI was installed from its resolved path.
/// Normalizes path separators so Windows backslash paths match correctly.
fn detect_install_method(cli_path: &str) -> &'static str {
    let normalized = cli_path.replace('\\', "/").to_lowercase();
    if normalized.contains("homebrew") || normalized.contains("linuxbrew") {
        "brew"
    } else if normalized.contains("volta") {
        "volta"
    } else if normalized.contains("node_modules")
        || normalized.ends_with(".cmd")
        || normalized.ends_with(".ps1")
    {
        "npm"
    } else if normalized.contains(".local/share/claude/versions")
        || normalized.contains("claude/versions")
    {
        "binary"
    } else {
        "unknown"
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdateResult {
    pub method: String,
    pub success: bool,
    pub message: String,
}

fn run_update_command(program: &str, args: &[&str]) -> CliUpdateResult {
    let method = program.to_string();
    let mut cmd = std::process::Command::new(program);
    cmd.args(args);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    match cmd.output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            if output.status.success() {
                CliUpdateResult {
                    method,
                    success: true,
                    message: if stdout.is_empty() {
                        "Update completed".to_string()
                    } else {
                        stdout
                    },
                }
            } else {
                CliUpdateResult {
                    method,
                    success: false,
                    message: if stderr.is_empty() {
                        format!("Update failed with exit code {}", output.status)
                    } else {
                        stderr
                    },
                }
            }
        }
        // Program not found or failed to execute
        Err(e) => CliUpdateResult {
            method,
            success: false,
            message: format!("Failed to run {program}: {e}"),
        },
    }
}

#[tauri::command]
pub async fn update_cli() -> Result<CliUpdateResult, String> {
    tokio::task::spawn_blocking(|| {
        let cli_path = super::detect_claude_cli_sync()?;
        let method = detect_install_method(&cli_path);

        let result = match method {
            "brew" => run_update_command("brew", &["upgrade", "claude-code"]),
            "npm" => run_update_command("npm", &["update", "-g", "@anthropic-ai/claude-code"]),
            "volta" => {
                run_update_command("volta", &["install", "@anthropic-ai/claude-code@latest"])
            }
            // For binary installs and unknown, try the CLI's own self-updater
            _ => run_update_command(&cli_path, &["update"]),
        };

        Ok(CliUpdateResult {
            method: method.to_string(),
            ..result
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

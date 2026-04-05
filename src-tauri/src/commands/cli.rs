use crate::session::types::SessionConfig;

// [RC-05] CLI discovery: detect_claude_cli / check_cli_version / get_cli_help
#[tauri::command]
pub async fn detect_claude_cli() -> Result<String, String> {
    // Run on a background thread so the WebView event loop isn't blocked
    tokio::task::spawn_blocking(|| {
        detect_claude_cli_sync()
    }).await.map_err(|e| e.to_string())?
}

fn detect_claude_cli_sync() -> Result<String, String> {
    let which_cmd = if cfg!(target_os = "windows") { "where" } else { "which" };
    let mut cmd = std::process::Command::new(which_cmd);
    cmd.arg("claude");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = cmd.output()
        .map_err(|e| format!("Failed to search for claude: {}", e))?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if !path.is_empty() {
            return Ok(path);
        }
    }

    // Check common install locations
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    #[cfg(target_os = "windows")]
    let candidates = [
        home.join(".local").join("bin").join("claude.exe"),
        home.join(".npm-global").join("bin").join("claude.cmd"),
        home.join("AppData")
            .join("Roaming")
            .join("npm")
            .join("claude.cmd"),
        home.join("AppData")
        	.join("Local")
        	.join("Programs")
        	.join("npm-global")
        	.join("claude.cmd"),
    ];
    #[cfg(not(target_os = "windows"))]
    let candidates = [
        home.join(".npm-global").join("bin").join("claude"),
        home.join(".local").join("bin").join("claude"),
    ];

    for candidate in &candidates {
        if candidate.exists() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }

    Err("Claude CLI not found. Please install it: npm install -g @anthropic-ai/claude-code".into())
}

/// Run a `claude` CLI subcommand and return trimmed stdout on success.
/// Shared by check_cli_version, plugin_* commands, etc.
/// Resolves the full CLI path via `detect_claude_cli_sync()` so commands
/// work even when PATH doesn't include the install directory (e.g. Linux
/// AppImage / desktop launches).
fn run_claude_cli(args: &[&str], label: &str) -> Result<String, String> {
    let cli_path = detect_claude_cli_sync()?;
    let mut cmd = std::process::Command::new(&cli_path);
    cmd.args(args);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = cmd.output()
        .map_err(|e| format!("Failed to run {}: {}", label, e))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("{} failed: {}", label, if stderr.is_empty() { "unknown error".to_string() } else { stderr }))
    }
}

/// Run `claude --version` — async to avoid blocking the WebView.
#[tauri::command]
pub async fn check_cli_version() -> Result<String, String> {
    tokio::task::spawn_blocking(|| run_claude_cli(&["--version"], "claude --version"))
        .await.map_err(|e| e.to_string())?
}

/// Run `claude --help` — async to avoid blocking the WebView.
#[tauri::command]
pub async fn get_cli_help() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        let cli_path = detect_claude_cli_sync()?;
        let mut cmd = std::process::Command::new(&cli_path);
        cmd.arg("--help");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let output = cmd.output()
            .map_err(|e| format!("Failed to run claude --help: {}", e))?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            if !stderr.is_empty() { Ok(stderr) }
            else { Err("claude --help failed".into()) }
        }
    }).await.map_err(|e| e.to_string())?
}

// [RC-16] 5-step binary resolution: .cmd shim -> direct -> sibling node_modules -> legacy versions -> npm root -g
/// Read the Claude Code binary content for pattern scanning.
/// Resolution chain: direct CLI path -> .cmd shim -> sibling node_modules -> legacy versions dir -> npm root -g.
fn read_claude_binary(cli_path: Option<&str>) -> Result<String, String> {
    // Helper: read a file if it exists and is under 500MB, return lossy UTF-8
    let read_if_exists = |p: &std::path::Path| -> Option<String> {
        let meta = std::fs::metadata(p).ok()?;
        if meta.len() > 500 * 1024 * 1024 { return None; }
        let bytes = std::fs::read(p).ok()?;
        Some(String::from_utf8_lossy(&bytes).to_string())
    };

    // Helper: validate content looks like a Claude binary (has command registration patterns)
    let is_claude_content = |content: &str| -> bool {
        content.contains(r#"name:""#) && content.contains(r#"",description:""#)
    };

    // 1. Direct CLI path
    if let Some(path_str) = cli_path {
        let path = std::path::Path::new(path_str);

        // 2. Resolve .cmd shim — parse for quoted JS path
        if path_str.to_lowercase().ends_with(".cmd") {
            if let Ok(shim) = std::fs::read_to_string(path) {
                // .cmd shims contain lines like: "C:\path\to\node.exe" "C:\path\to\cli.js" %*
                for line in shim.lines() {
                    // Find quoted paths ending in .js
                    for segment in line.split('"') {
                        if segment.ends_with(".js") {
                            let js_path = std::path::Path::new(segment);
                            if let Some(content) = read_if_exists(js_path) {
                                if is_claude_content(&content) {
                                    return Ok(content);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Resolve symlink (Linux npm creates symlinks to node_modules)
        #[cfg(not(target_os = "windows"))]
        if path.is_symlink() {
            if let Ok(resolved) = std::fs::canonicalize(path) {
                if let Some(content) = read_if_exists(&resolved) {
                    if is_claude_content(&content) {
                        return Ok(content);
                    }
                }
            }
        }

        // Direct read of the CLI path itself (standalone exe or JS entry)
        if path.exists() {
            if let Some(content) = read_if_exists(path) {
                if is_claude_content(&content) {
                    return Ok(content);
                }
            }
        }

        // 3. Sibling node_modules
        if let Some(parent) = path.parent() {
            let sibling = parent.join("node_modules")
                .join("@anthropic-ai").join("claude-code").join("cli.js");
            if let Some(content) = read_if_exists(&sibling) {
                if is_claude_content(&content) {
                    return Ok(content);
                }
            }
        }
    }

    // 4. Legacy versions dir (~/.local/share/claude/versions/<latest>)
    if let Some(home) = dirs::home_dir() {
        let versions_dir = home.join(".local").join("share").join("claude").join("versions");
        if let Ok(entries) = std::fs::read_dir(&versions_dir) {
            let mut versions: Vec<_> = entries.flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            versions.sort();
            if let Some(v) = versions.last() {
                let binary_path = versions_dir.join(v);
                if let Some(content) = read_if_exists(&binary_path) {
                    if is_claude_content(&content) {
                        return Ok(content);
                    }
                }
            }
        }
    }

    // 5. npm root -g fallback
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;
    let mut npm_cmd = std::process::Command::new("npm");
    npm_cmd.args(["root", "-g"]);
    #[cfg(target_os = "windows")]
    npm_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    if let Ok(output) = npm_cmd.output()
    {
        let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !root.is_empty() {
            let npm_cli = std::path::Path::new(&root)
                .join("@anthropic-ai").join("claude-code").join("cli.js");
            if let Some(content) = read_if_exists(&npm_cli) {
                if is_claude_content(&content) {
                    return Ok(content);
                }
            }
        }
    }

    Err("Could not locate Claude Code binary".into())
}

// [RC-09] Slash command discovery: builtin from binary scan, plugin from command directories
/// Scan the Claude Code binary for built-in slash commands.
/// Two-step scan: finds name:"..." positions, then searches a brace-depth-bounded
/// window for descriptions (literal, reversed, computed/ternary, template literal).
#[tauri::command]
pub async fn discover_builtin_commands(cli_path: Option<String>) -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(move || discover_builtin_commands_sync(cli_path.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

fn discover_builtin_commands_sync(cli_path: Option<&str>) -> Result<Vec<serde_json::Value>, String> {
    let content = match read_claude_binary(cli_path) {
        Ok(c) => c,
        Err(_) => return Ok(Vec::new()),
    };

    let mut commands = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // Two-step scan: first find all name:"..." positions, then look for descriptions
    // in a window around each. This handles intervening properties (aliases, type, etc.),
    // reversed property order, computed descriptions (ternaries, getters), and template literals.
    let name_re = regex::Regex::new(r#"name:"([\w][\w-]*)""#).unwrap();
    let desc_literal_re = regex::Regex::new(r#"description:"([^"]*?)""#).unwrap();
    let desc_computed_re = regex::Regex::new(r#"description[^"]{0,80}"([^"]*?)""#).unwrap();
    let desc_template_re = regex::Regex::new(r#"description[^`]{0,80}`([^`]*?)`"#).unwrap();

    for name_match in name_re.find_iter(&content) {
        let name_cap = name_re.captures(&content[name_match.start()..]).unwrap();
        let name = name_cap[1].to_string();
        // Filter MCP prompt template fragments (name:"mcp__"+serverName+"__"+promptName)
        if name.contains("__") {
            continue;
        }
        let cmd = format!("/{}", name);
        if cmd.len() < 4 || !seen.insert(cmd.clone()) {
            continue;
        }

        // Look for description in a window around the name match.
        // Forward window: up to 500 chars after name, bounded by the enclosing object.
        // We track brace depth: { increments, } decrements. When depth reaches -1,
        // we've exited the current object. This correctly handles nested braces in
        // getter functions ({...}) and template literal interpolations (${...}).
        let fwd_start = name_match.end();
        let fwd_limit = (fwd_start + 500).min(content.len());
        let fwd_raw = &content[fwd_start..fwd_limit];
        let mut fwd_end = fwd_raw.len();
        let mut depth: i32 = 0;
        for (i, ch) in fwd_raw.char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth < 0 {
                        fwd_end = i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let fwd_window = &fwd_raw[..fwd_end];

        // Reverse window: up to 300 chars before name
        let rev_start = name_match.start().saturating_sub(300);
        let rev_window = &content[rev_start..name_match.start()];
        // Truncate at last } to stay within the same object
        let rev_window = match rev_window.rfind('}') {
            Some(pos) => &rev_window[pos + 1..],
            None => rev_window,
        };

        // Require a command-specific type marker in the surrounding window.
        // Real commands always declare type:"prompt", type:"local-jsx", or type:"local".
        // This filters highlight.js languages, HTML elements, signals, AWS SDK, crypto, etc.
        let has_command_type = fwd_window.contains(r#"type:"prompt""#)
            || fwd_window.contains(r#"type:"local-jsx""#)
            || fwd_window.contains(r#"type:"local""#)
            || rev_window.contains(r#"type:"prompt""#)
            || rev_window.contains(r#"type:"local-jsx""#)
            || rev_window.contains(r#"type:"local""#);
        if !has_command_type {
            continue;
        }

        // Skip hidden commands (debug/internal: heapdump, output-style, rate-limit-options)
        // Only matches literal isHidden:!0, not computed expressions like isHidden:someCondition
        if fwd_window.contains("isHidden:!0") || rev_window.contains("isHidden:!0") {
            continue;
        }

        // Try patterns in priority order — search both forward and reverse windows
        let strip_interpolations = |raw: &str| -> String {
            let re = regex::Regex::new(r#"\$\{[^}]*\}"#).unwrap();
            re.replace_all(raw, "").trim().to_string()
        };

        let desc = None
            // 1. Literal description in forward window
            .or_else(|| desc_literal_re.captures(fwd_window).map(|c| c[1].to_string()))
            // 2. Literal description in reverse window (reversed property order)
            .or_else(|| desc_literal_re.captures(rev_window).map(|c| c[1].to_string()))
            // 3. Computed description in forward window
            .or_else(|| desc_computed_re.captures(fwd_window).map(|c| c[1].to_string()))
            // 4. Computed description in reverse window
            .or_else(|| desc_computed_re.captures(rev_window).map(|c| c[1].to_string()))
            // 5. Template literal in forward window
            .or_else(|| desc_template_re.captures(fwd_window).map(|c| strip_interpolations(&c[1])))
            // 6. Template literal in reverse window
            .or_else(|| desc_template_re.captures(rev_window).map(|c| strip_interpolations(&c[1])))
            .unwrap_or_default();

        // Clean up escaped newlines in descriptions
        let desc = desc.replace("\\n", " ");
        commands.push(serde_json::json!({ "cmd": cmd, "desc": desc }));
    }

    // Filter out noise (internal tools, MCP tools, non-slash-commands)
    commands.retain(|c| {
        let cmd = c["cmd"].as_str().unwrap_or("");
        let desc = c["desc"].as_str().unwrap_or("");
        // Skip commands that look like CLI tools or MCP tools (very long descriptions about DOM/browser)
        !cmd.starts_with("/--") && !desc.contains("tab ID") && !desc.contains("DOM")
            && cmd.len() >= 4 && cmd.len() <= 30
    });

    Ok(commands)
}

/// Scan the Claude Code binary for settings schema definitions.
/// Extracts Zod schema patterns: keyName:u.type().optional().describe("...")
/// Returns discovered settings with key, type, description, choices.
#[tauri::command]
pub async fn discover_settings_schema(cli_path: Option<String>) -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(move || discover_settings_schema_sync(cli_path.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

fn discover_settings_schema_sync(cli_path: Option<&str>) -> Result<Vec<serde_json::Value>, String> {
    let content = match read_claude_binary(cli_path) {
        Ok(c) => c,
        Err(_) => return Ok(Vec::new()),
    };

    let mut fields = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // Pattern: keyName:u.type(args).optional().catch(...).describe("description")
    // The Zod schema in the binary uses a minified `u` variable.
    // We capture: key name, base type, optional args (for enum choices), and description.
    //
    // Match key:u.type( — then scan ahead for .describe("...") within ~300 chars
    let key_re = regex::Regex::new(
        r#"([a-zA-Z][a-zA-Z0-9]{2,40}):u\.(enum|string|boolean|number|array|record|object|lazy|union)\("#
    ).unwrap();

    for cap in key_re.captures_iter(&content) {
        let key = cap[1].to_string();
        let base_type = cap[2].to_string();

        // Skip internal/noise keys (too short, all-caps constants, common JS identifiers)
        if key.len() < 3 || key.chars().all(|c| c.is_uppercase()) {
            continue;
        }
        // Skip common JS/minification noise
        if matches!(key.as_str(),
            "type" | "name" | "value" | "message" | "data" | "error" | "status" |
            "content" | "role" | "input" | "output" | "result" | "text" | "key" |
            "description" | "title" | "path" | "args" | "options" | "config" |
            "params" | "command" | "event" | "action" | "state" | "context" |
            "source" | "target" | "children" | "parent" | "index" | "length"
        ) {
            continue;
        }

        if !seen.insert(key.clone()) {
            continue;
        }

        // Look at the ~400 chars after the match to find .describe("...") and enum choices
        let match_end = cap.get(0).unwrap().end();
        let lookahead = &content[match_end..std::cmp::min(match_end + 400, content.len())];

        // Extract description from .describe("...")
        let description = regex::Regex::new(r#"\.describe\("([^"]{4,200})"\)"#)
            .ok()
            .and_then(|re| re.captures(lookahead))
            .map(|c| c[1].replace("\\n", " "));

        // Only keep entries that have a description (filters out non-settings Zod schemas)
        let desc = match description {
            Some(d) => d,
            None => continue,
        };

        // Extract enum choices from u.enum(["a","b","c"])
        let choices: Option<Vec<String>> = if base_type == "enum" {
            regex::Regex::new(r#"\[([^\]]{1,200})\]"#)
                .ok()
                .and_then(|re| re.captures(lookahead))
                .map(|c| {
                    c[1].split(',')
                        .filter_map(|s| {
                            let trimmed = s.trim().trim_matches('"');
                            if !trimmed.is_empty() { Some(trimmed.to_string()) } else { None }
                        })
                        .collect()
                })
        } else {
            None
        };

        // Check for .optional()
        let optional = lookahead.contains(".optional()");

        // Map Zod type to our field type
        let field_type = match base_type.as_str() {
            "boolean" => "boolean",
            "number" => "number",
            "enum" => "enum",
            "array" => "stringArray",
            "record" => "stringMap",
            "object" | "lazy" | "union" => "object",
            _ => "string",
        };

        let mut entry = serde_json::json!({
            "key": key,
            "type": field_type,
            "description": desc,
            "optional": optional,
        });
        if let Some(c) = choices {
            entry["choices"] = serde_json::json!(c);
        }
        fields.push(entry);
    }

    // Sort alphabetically for consistency
    fields.sort_by(|a, b| {
        a["key"].as_str().unwrap_or("").cmp(b["key"].as_str().unwrap_or(""))
    });

    Ok(fields)
}

/// Discovered environment variable entry.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct DiscoveredEnvVar {
    pub name: String,
    pub description: String,
    pub category: String,
    pub documented: bool,
}

/// Mine the Claude CLI binary for environment variable names used via process.env.
/// Returns the hardcoded catalog merged with any additional names found in the binary.
#[tauri::command]
pub async fn discover_env_vars(cli_path: Option<String>) -> Result<Vec<DiscoveredEnvVar>, String> {
    tokio::task::spawn_blocking(move || discover_env_vars_sync(cli_path.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

fn env_var_catalog() -> Vec<DiscoveredEnvVar> {
    vec![
        DiscoveredEnvVar { name: "ANTHROPIC_API_KEY".into(), description: "Anthropic API key for authentication".into(), category: "api".into(), documented: true },
        DiscoveredEnvVar { name: "ANTHROPIC_BASE_URL".into(), description: "Custom API base URL (for proxies or alternative endpoints)".into(), category: "api".into(), documented: true },
        DiscoveredEnvVar { name: "ANTHROPIC_AUTH_TOKEN".into(), description: "Bearer token (alternative to API key)".into(), category: "api".into(), documented: true },
        DiscoveredEnvVar { name: "CLAUDE_CODE_API_KEY_HELPER_TTY".into(), description: "Program path that outputs an API key to stdout".into(), category: "api".into(), documented: true },
        DiscoveredEnvVar { name: "ANTHROPIC_MODEL".into(), description: "Default model override".into(), category: "model".into(), documented: true },
        DiscoveredEnvVar { name: "ANTHROPIC_SMALL_FAST_MODEL".into(), description: "Small/fast model for lightweight tasks".into(), category: "model".into(), documented: true },
        DiscoveredEnvVar { name: "CLAUDE_CODE_MAX_OUTPUT_TOKENS".into(), description: "Maximum output tokens per response".into(), category: "model".into(), documented: true },
        DiscoveredEnvVar { name: "CLAUDE_CODE_DISABLE_TELEMETRY".into(), description: "Disable usage telemetry (set to \"1\")".into(), category: "features".into(), documented: true },
        DiscoveredEnvVar { name: "CLAUDE_CODE_GIT_BASH_PATH".into(), description: "Path to Git Bash executable (Windows)".into(), category: "features".into(), documented: true },
        DiscoveredEnvVar { name: "CLAUDE_CODE_ENABLE_UNIFIED_READ_WRITE".into(), description: "Enable unified read+write tool".into(), category: "features".into(), documented: true },
        DiscoveredEnvVar { name: "BASH_DEFAULT_TIMEOUT_MS".into(), description: "Default bash command timeout in milliseconds".into(), category: "features".into(), documented: true },
        DiscoveredEnvVar { name: "BASH_MAX_TIMEOUT_MS".into(), description: "Maximum allowed bash timeout in milliseconds".into(), category: "features".into(), documented: true },
        DiscoveredEnvVar { name: "DISABLE_AUTOUPDATER".into(), description: "Disable automatic updates (set to \"1\")".into(), category: "features".into(), documented: true },
        DiscoveredEnvVar { name: "CLAUDE_CODE_USE_BEDROCK".into(), description: "Use AWS Bedrock instead of direct API (set to \"1\")".into(), category: "aws".into(), documented: true },
        DiscoveredEnvVar { name: "CLAUDE_CODE_BEDROCK_REGION".into(), description: "AWS region for Bedrock".into(), category: "aws".into(), documented: true },
        DiscoveredEnvVar { name: "AWS_PROFILE".into(), description: "AWS credential profile for Bedrock authentication".into(), category: "aws".into(), documented: true },
        DiscoveredEnvVar { name: "AWS_REGION".into(), description: "AWS region (fallback for Bedrock region)".into(), category: "aws".into(), documented: true },
        DiscoveredEnvVar { name: "CLAUDE_CODE_USE_VERTEX".into(), description: "Use Google Vertex AI instead of direct API (set to \"1\")".into(), category: "gcp".into(), documented: true },
        DiscoveredEnvVar { name: "ANTHROPIC_VERTEX_PROJECT_ID".into(), description: "Google Cloud project ID for Vertex AI".into(), category: "gcp".into(), documented: true },
        DiscoveredEnvVar { name: "ANTHROPIC_VERTEX_REGION".into(), description: "Google Cloud region for Vertex AI".into(), category: "gcp".into(), documented: true },
        DiscoveredEnvVar { name: "HTTP_PROXY".into(), description: "HTTP proxy server URL".into(), category: "network".into(), documented: true },
        DiscoveredEnvVar { name: "HTTPS_PROXY".into(), description: "HTTPS proxy server URL".into(), category: "network".into(), documented: true },
        DiscoveredEnvVar { name: "NO_PROXY".into(), description: "Comma-separated hosts to bypass proxy".into(), category: "network".into(), documented: true },
        DiscoveredEnvVar { name: "NODE_TLS_REJECT_UNAUTHORIZED".into(), description: "TLS cert validation — set \"0\" to disable (insecure)".into(), category: "network".into(), documented: true },
        DiscoveredEnvVar { name: "CLAUDE_CODE_SKIP_BINARY_CHECK".into(), description: "Skip binary integrity check on startup".into(), category: "debug".into(), documented: true },
    ]
}

fn discover_env_vars_sync(cli_path: Option<&str>) -> Result<Vec<DiscoveredEnvVar>, String> {
    let catalog = env_var_catalog();
    let catalog_names: std::collections::HashSet<String> =
        catalog.iter().map(|e| e.name.clone()).collect();

    let mut result: Vec<DiscoveredEnvVar> = catalog;

    // Attempt binary mining: look for process.env.VAR_NAME patterns in the JS bundle
    if let Ok(content) = read_claude_binary(cli_path) {
        let env_re = regex::Regex::new(r"process\.env\.([A-Z][A-Z0-9_]{2,})").unwrap();
        let mut seen: std::collections::HashSet<String> = catalog_names;

        for cap in env_re.captures_iter(&content) {
            let name = cap[1].to_string();
            if seen.insert(name.clone()) {
                result.push(DiscoveredEnvVar {
                    name,
                    description: String::new(),
                    category: "other".into(),
                    documented: false,
                });
            }
        }
    }

    // Sort: documented first, then by category, then by name
    result.sort_by(|a, b| {
        b.documented.cmp(&a.documented)
            .then(a.category.cmp(&b.category))
            .then(a.name.cmp(&b.name))
    });

    Ok(result)
}

// [CM-03] Fetch settings schema from schemastore.org (server-side to avoid CORS)
/// Fetch the Claude Code JSON Schema from schemastore.org.
/// Done server-side to avoid CORS restrictions in the WebView.
#[tauri::command]
pub async fn fetch_settings_schema() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        let url = "https://json.schemastore.org/claude-code-settings.json";
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| format!("HTTP client error: {}", e))?;
        client.get(url)
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.text())
            .map_err(|e| format!("Failed to fetch settings schema: {}", e))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Scan for plugin/custom command files in multiple locations.
#[tauri::command]
pub fn discover_plugin_commands(extra_dirs: Vec<String>) -> Result<Vec<serde_json::Value>, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let mut commands = Vec::new();

    fn scan_dir(dir: &std::path::Path, commands: &mut Vec<serde_json::Value>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    scan_dir(&path, commands);
                } else if path.file_name().and_then(|n| n.to_str()) == Some("SKILL.md") {
                    // Parse SKILL.md with YAML frontmatter
                    if let Ok(content) = std::fs::read_to_string(&path) {
                        if let Some(fm) = content.strip_prefix("---") {
                            if let Some(end) = fm.find("---") {
                                let meta = &fm[..end];
                                let name = meta.lines()
                                    .find(|l| l.trim().starts_with("name:"))
                                    .and_then(|l| l.trim().strip_prefix("name:"))
                                    .map(|s| s.trim().to_string());
                                let desc = meta.lines()
                                    .find(|l| l.trim().starts_with("description:"))
                                    .and_then(|l| l.trim().strip_prefix("description:"))
                                    .map(|s| s.trim().chars().take(120).collect::<String>());
                                if let Some(n) = name {
                                    commands.push(serde_json::json!({
                                        "cmd": format!("/{}", n),
                                        "desc": desc.unwrap_or_default()
                                    }));
                                }
                            }
                        }
                    }
                } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
                    if let Some(parent) = path.parent() {
                        if parent.file_name().and_then(|n| n.to_str()) == Some("commands") {
                            let name = path.file_stem()
                                .and_then(|s| s.to_str())
                                .unwrap_or("")
                                .to_string();
                            if !name.is_empty() {
                                let desc = std::fs::read_to_string(&path)
                                    .ok()
                                    .and_then(|c| c.lines().next().map(|l| l.trim().trim_start_matches('#').trim().to_string()))
                                    .unwrap_or_default();
                                commands.push(serde_json::json!({
                                    "cmd": format!("/{}", name),
                                    "desc": desc
                                }));
                            }
                        }
                    }
                }
            }
        }
    }

    // 1. Global plugins
    let plugins_dir = home.join(".claude").join("plugins");
    if plugins_dir.exists() {
        scan_dir(&plugins_dir, &mut commands);
    }

    // 2. User-level custom commands (~/.claude/commands/)
    let user_cmds = home.join(".claude").join("commands");
    if user_cmds.exists() {
        scan_dir(&user_cmds, &mut commands);
    }

    // 3. User-level skills (~/.claude/skills/)
    let user_skills = home.join(".claude").join("skills");
    if user_skills.exists() {
        scan_dir(&user_skills, &mut commands);
    }

    // 4. Project-level custom commands and skills for each provided directory
    for dir in &extra_dirs {
        let project_cmds = std::path::Path::new(dir).join(".claude").join("commands");
        if project_cmds.exists() {
            scan_dir(&project_cmds, &mut commands);
        }
        let project_skills = std::path::Path::new(dir).join(".claude").join("skills");
        if project_skills.exists() {
            scan_dir(&project_skills, &mut commands);
        }
    }

    // Dedup by command name
    let mut seen = std::collections::HashSet::new();
    commands.retain(|c| {
        let name = c["cmd"].as_str().unwrap_or("").to_string();
        seen.insert(name)
    });

    Ok(commands)
}

// [RC-02] SessionConfig -> CLI args (--resume, --session-id, --project-dir, etc.)
#[tauri::command]
pub fn build_claude_args(config: SessionConfig) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = Vec::new();

    if let Some(ref model) = config.model {
        args.push("--model".into());
        args.push(model.clone());
    }

    match config.permission_mode {
        crate::session::types::PermissionMode::Default => {}
        crate::session::types::PermissionMode::AcceptEdits => {
            args.push("--permission-mode".into());
            args.push("acceptEdits".into());
        }
        crate::session::types::PermissionMode::BypassPermissions => {
            args.push("--permission-mode".into());
            args.push("bypassPermissions".into());
        }
        crate::session::types::PermissionMode::DontAsk => {
            args.push("--permission-mode".into());
            args.push("dontAsk".into());
        }
        crate::session::types::PermissionMode::PlanMode => {
            args.push("--permission-mode".into());
            args.push("plan".into());
        }
        crate::session::types::PermissionMode::Auto => {
            args.push("--permission-mode".into());
            args.push("auto".into());
        }
    }

    if config.dangerously_skip_permissions {
        args.push("--dangerously-skip-permissions".into());
    }

    if let Some(ref prompt) = config.system_prompt {
        if !prompt.is_empty() {
            args.push("--system-prompt".into());
            args.push(prompt.clone());
        }
    }

    if let Some(ref prompt) = config.append_system_prompt {
        if !prompt.is_empty() {
            args.push("--append-system-prompt".into());
            args.push(prompt.clone());
        }
    }

    for tool in &config.allowed_tools {
        args.push("--allowedTools".into());
        args.push(tool.clone());
    }

    for tool in &config.disallowed_tools {
        args.push("--disallowedTools".into());
        args.push(tool.clone());
    }

    for dir in &config.additional_dirs {
        args.push("--add-dir".into());
        args.push(dir.clone());
    }

    if let Some(ref mcp) = config.mcp_config {
        if !mcp.is_empty() {
            args.push("--mcp-config".into());
            args.push(mcp.clone());
        }
    }

    if let Some(ref agent) = config.agent {
        if !agent.is_empty() {
            args.push("--agent".into());
            args.push(agent.clone());
        }
    }

    if let Some(ref effort) = config.effort {
        args.push("--effort".into());
        args.push(effort.clone());
    }

    if config.verbose {
        args.push("--verbose".into());
    }

    if config.debug {
        args.push("--debug".into());
    }

    if let Some(budget) = config.max_budget {
        args.push("--max-budget-usd".into());
        args.push(budget.to_string());
    }

    if config.project_dir {
        args.push("--project-dir".into());
        #[cfg(target_os = "windows")]
        args.push(config.working_dir.replace('/', "\\"));
        #[cfg(not(target_os = "windows"))]
        args.push(config.working_dir.clone());
    }

    if config.continue_session {
        args.push("--continue".into());
    } else if let Some(ref session_id) = config.resume_session {
        if !session_id.is_empty() {
            if config.fork_session {
                args.push("--fork-session".into());
                args.push(session_id.clone());
            } else {
                args.push("--resume".into());
                args.push(session_id.clone());
            }
        }
    }

    // [RS-05] Skip --session-id when using --resume or --continue
    // Claude CLI rejects the combination unless --fork-session is also specified.
    if !config.continue_session && config.resume_session.is_none() {
        if let Some(ref sid) = config.session_id {
            args.push("--session-id".into());
            args.push(sid.clone());
        }
    }

    // Append any raw extra flags
    if let Some(ref extra) = config.extra_flags {
        let extra = extra.trim();
        if !extra.is_empty() {
            for flag in extra.split_whitespace() {
                args.push(flag.to_string());
            }
        }
    }

    Ok(args)
}

/// Scan JSONL conversation history for slash command usage.
/// Walks ~/.claude/projects/*/*.jsonl, caps at 200 most recent files by mtime,
/// and counts `<command-name>X</command-name>` patterns.
#[tauri::command]
pub async fn scan_command_usage() -> Result<std::collections::HashMap<String, u64>, String> {
    tokio::task::spawn_blocking(scan_command_usage_sync)
        .await
        .map_err(|e| e.to_string())?
}

fn scan_command_usage_sync() -> Result<std::collections::HashMap<String, u64>, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let projects_dir = home.join(".claude").join("projects");
    if !projects_dir.exists() {
        return Ok(std::collections::HashMap::new());
    }

    // Collect all .jsonl files with their modification times
    let mut files: Vec<(std::time::SystemTime, std::path::PathBuf)> = Vec::new();
    let entries = std::fs::read_dir(&projects_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }
        if let Ok(dir_entries) = std::fs::read_dir(&path) {
            for file in dir_entries.flatten() {
                let fpath = file.path();
                if fpath.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
                if let Ok(meta) = std::fs::metadata(&fpath) {
                    let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
                    files.push((mtime, fpath));
                }
            }
        }
    }

    // Sort by mtime desc, cap at 200
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.truncate(200);

    use std::io::{BufRead, BufReader};

    let re = regex::Regex::new(r"<command-name>(/[\w-]+)</command-name>").unwrap();
    let mut counts: std::collections::HashMap<String, u64> = std::collections::HashMap::new();

    for (_, path) in &files {
        let file = match std::fs::File::open(path) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for line in BufReader::new(file).lines().flatten() {
            for cap in re.captures_iter(&line) {
                *counts.entry(cap[1].to_string()).or_insert(0) += 1;
            }
        }
    }

    Ok(counts)
}

// [RC-18] Plugin management IPC: list/install/uninstall/enable/disable via run_claude_cli

/// Run `claude plugin list --available --json` and return raw JSON output.
#[tauri::command]
pub async fn plugin_list() -> Result<String, String> {
    tokio::task::spawn_blocking(|| run_claude_cli(&["plugin", "list", "--available", "--json"], "claude plugin list"))
        .await.map_err(|e| e.to_string())?
}

/// Run `claude plugin install <name> --scope <scope>`.
#[tauri::command]
pub async fn plugin_install(name: String, scope: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_claude_cli(&["plugin", "install", &name, "--scope", &scope], "plugin install"))
        .await.map_err(|e| e.to_string())?
}

/// Run `claude plugin uninstall <name>`.
#[tauri::command]
pub async fn plugin_uninstall(name: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_claude_cli(&["plugin", "uninstall", &name], "plugin uninstall"))
        .await.map_err(|e| e.to_string())?
}

/// Run `claude plugin enable <name>`.
#[tauri::command]
pub async fn plugin_enable(name: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_claude_cli(&["plugin", "enable", &name], "plugin enable"))
        .await.map_err(|e| e.to_string())?
}

/// Run `claude plugin disable <name>`.
#[tauri::command]
pub async fn plugin_disable(name: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_claude_cli(&["plugin", "disable", &name], "plugin disable"))
        .await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique marker embedded in test content to prove the returned content
    /// came from our temp file rather than a system-installed Claude binary.
    const TEST_MARKER: &str = "TEST_MARKER_7f3a9c2e";

    /// Valid content with an embedded marker for origin verification.
    fn valid_content_with_marker() -> String {
        format!(r#"stuff name:"review",description:"Review code" {} more stuff"#, TEST_MARKER)
    }

    // --- read_claude_binary tests ---

    #[test]
    fn read_binary_direct_js_path_valid_content() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");
        let content = valid_content_with_marker();
        std::fs::write(&js_path, &content).unwrap();

        let result = read_claude_binary(Some(js_path.to_str().unwrap()));
        assert!(result.is_ok(), "should read valid JS file directly");
        let returned = result.unwrap();
        // Verify the content came from our temp file, not a system fallback
        assert!(returned.contains(TEST_MARKER), "should return content from the given path");
    }

    #[test]
    fn read_binary_direct_path_invalid_content_skipped() {
        // When the direct path has invalid content, read_claude_binary skips it
        // and falls through to later resolution steps. The function may still
        // succeed via system fallbacks (legacy versions dir, npm root -g).
        // We verify the direct path's content is NOT returned.
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");
        let invalid_with_marker = format!("console.log('{}');", TEST_MARKER);
        std::fs::write(&js_path, &invalid_with_marker).unwrap();

        let result = read_claude_binary(Some(js_path.to_str().unwrap()));
        match result {
            Ok(content) => {
                // If fallback succeeded, verify it did NOT return our invalid content
                assert!(!content.contains(TEST_MARKER),
                    "invalid content should be skipped; fallback returned system binary");
            }
            Err(_) => {
                // All fallbacks failed too — expected on machines without Claude
            }
        }
    }

    #[test]
    fn read_binary_cmd_shim_resolves_to_js() {
        let dir = tempfile::tempdir().unwrap();

        // Create the JS file with valid content and marker
        let js_path = dir.path().join("cli.js");
        let content = valid_content_with_marker();
        std::fs::write(&js_path, &content).unwrap();

        // Create a .cmd shim pointing to it (mimics npm's Windows shims)
        let cmd_path = dir.path().join("claude.cmd");
        let shim_content = format!(
            "@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \"{}\" %*\r\n) ELSE (\r\n  node  \"{}\" %*\r\n)",
            js_path.display(),
            js_path.display()
        );
        std::fs::write(&cmd_path, &shim_content).unwrap();

        let result = read_claude_binary(Some(cmd_path.to_str().unwrap()));
        assert!(result.is_ok(), "should resolve .cmd shim to JS file: {:?}", result.err());
        assert!(result.unwrap().contains(TEST_MARKER),
            "should return content from the .cmd shim's JS target");
    }

    #[test]
    fn read_binary_cmd_shim_invalid_js_not_returned() {
        let dir = tempfile::tempdir().unwrap();

        // Create JS file with INVALID content bearing a marker
        let js_path = dir.path().join("cli.js");
        let invalid_with_marker = format!("console.log('{}');", TEST_MARKER);
        std::fs::write(&js_path, &invalid_with_marker).unwrap();

        // Create a .cmd shim pointing to it
        let cmd_path = dir.path().join("claude.cmd");
        let shim_content = format!(
            "@\"%~dp0\\node.exe\" \"{}\" %*\r\n",
            js_path.display()
        );
        std::fs::write(&cmd_path, &shim_content).unwrap();

        let result = read_claude_binary(Some(cmd_path.to_str().unwrap()));
        match result {
            Ok(content) => {
                assert!(!content.contains(TEST_MARKER),
                    "invalid JS content via shim should not be returned");
            }
            Err(_) => {
                // All fallbacks failed — expected behavior
            }
        }
    }

    #[test]
    fn read_binary_cmd_shim_missing_js_not_returned() {
        let dir = tempfile::tempdir().unwrap();

        // .cmd shim points to a JS file that does not exist
        let cmd_path = dir.path().join("claude.cmd");
        let missing_path = dir.path().join("nonexistent.js");
        let shim_content = format!(
            "@\"node\" \"{}\" %*\r\n",
            missing_path.display()
        );
        std::fs::write(&cmd_path, &shim_content).unwrap();

        let result = read_claude_binary(Some(cmd_path.to_str().unwrap()));
        // The shim's target doesn't exist, so the .cmd resolution step fails.
        // The function may still succeed via later fallbacks.
        // We just verify it doesn't panic.
        let _ = result;
    }

    #[test]
    fn read_binary_sibling_node_modules_fallback() {
        let dir = tempfile::tempdir().unwrap();

        // Create the sibling node_modules structure with marked content
        let sibling_dir = dir.path()
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code");
        std::fs::create_dir_all(&sibling_dir).unwrap();
        let content = valid_content_with_marker();
        std::fs::write(sibling_dir.join("cli.js"), &content).unwrap();

        // Give an invalid direct path (non-.cmd file in same directory)
        let fake_bin = dir.path().join("claude");
        std::fs::write(&fake_bin, "not-valid-content").unwrap();

        let result = read_claude_binary(Some(fake_bin.to_str().unwrap()));
        assert!(result.is_ok(), "should fall through to sibling node_modules: {:?}", result.err());
        assert!(result.unwrap().contains(TEST_MARKER),
            "should return content from sibling node_modules");
    }

    #[test]
    fn read_binary_none_path_does_not_panic() {
        // With no cli_path, it tries legacy versions dir and npm root -g.
        // Whether it succeeds depends on system state — just verify no panic.
        let result = read_claude_binary(None);
        let _ = result;
    }

    #[test]
    fn read_binary_nonexistent_path_does_not_panic() {
        // Nonexistent direct path causes fallthrough to later steps.
        // Whether it ultimately succeeds depends on system state.
        let result = read_claude_binary(Some("/nonexistent/path/to/claude"));
        let _ = result;
    }

    // --- discover_builtin_commands_sync tests ---

    #[test]
    fn discover_builtin_extracts_commands() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        // Simulated minified binary content with command registrations
        let content = concat!(
            r#"var a={type:"prompt",name:"review",description:"Review code changes"}; "#,
            r#"var b={type:"local-jsx",name:"init",description:"Initialize a new project"}; "#,
            r#"var c={type:"local",name:"compact",description:"Compact conversation history"}; "#,
            r#"var d={type:"prompt",name:"bug-report",description:"Report a bug"};"#,
        );
        std::fs::write(&js_path, content).unwrap();

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        assert!(result.is_ok());
        let commands = result.unwrap();
        assert!(commands.len() >= 4, "should extract at least 4 commands, got {}", commands.len());

        let names: Vec<&str> = commands.iter()
            .filter_map(|c| c["cmd"].as_str())
            .collect();
        assert!(names.contains(&"/review"), "should contain /review");
        assert!(names.contains(&"/init"), "should contain /init");
        assert!(names.contains(&"/compact"), "should contain /compact");
        assert!(names.contains(&"/bug-report"), "should contain /bug-report (hyphens allowed)");
    }

    #[test]
    fn discover_builtin_deduplicates_commands() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = r#"var a={type:"local",name:"review",description:"First"};var b={type:"local",name:"review",description:"Second"}"#;
        std::fs::write(&js_path, content).unwrap();

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();
        let review_count = commands.iter()
            .filter(|c| c["cmd"].as_str() == Some("/review"))
            .count();
        assert_eq!(review_count, 1, "should deduplicate /review");
    }

    #[test]
    fn discover_builtin_filters_noise() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = concat!(
            r#"var a={type:"local",name:"review",description:"Review code"}; "#,
            r#"var b={type:"local",name:"browser-tool",description:"Interact with DOM elements"}"#,
        );
        std::fs::write(&js_path, content).unwrap();

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();
        let names: Vec<&str> = commands.iter()
            .filter_map(|c| c["cmd"].as_str())
            .collect();

        assert!(names.contains(&"/review"), "/review should be kept");
        assert!(!names.contains(&"/browser-tool"), "DOM-related tool should be filtered");
    }

    #[test]
    fn discover_builtin_cleans_escaped_newlines() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = r#"var a={type:"local",name:"review",description:"Line one\nLine two"}"#;
        std::fs::write(&js_path, content).unwrap();

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();
        let desc = commands[0]["desc"].as_str().unwrap();
        assert!(!desc.contains("\\n"), "escaped newlines should be replaced with spaces");
        assert!(desc.contains("Line one Line two"));
    }

    #[test]
    fn discover_builtin_no_commands_in_content() {
        // Content passes is_claude_content but has no extractable commands
        // besides the validation pattern itself.
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");
        // Minimal valid content — "ab" is too short to pass the >=4 char filter
        let content = r#"var a={type:"local",name:"ab",description:"Too short"}"#;
        std::fs::write(&js_path, content).unwrap();

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        assert!(result.is_ok());
        // /ab is only 3 chars, filtered by cmd.len() >= 4
        let commands = result.unwrap();
        let names: Vec<&str> = commands.iter()
            .filter_map(|c| c["cmd"].as_str())
            .collect();
        assert!(!names.contains(&"/ab"), "/ab should be filtered (too short)");
    }

    #[test]
    fn discover_builtin_intervening_properties() {
        // Commands with aliases/type/etc. between name and description
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = concat!(
            r#"var x={type:"local-jsx",name:"tasks",aliases:["bashes"],description:"List and manage background tasks",load:()=>null};"#,
            r#" var y={type:"local-jsx",name:"branch",aliases:["fork"],description:"Create a branch",argumentHint:"[name]",load:()=>null};"#,
            r#" var z={type:"local-jsx",name:"permissions",aliases:["allowed-tools"],description:"Manage allow and deny tool permission rules",load:()=>null};"#,
        );
        std::fs::write(&js_path, content).unwrap();

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();
        let names: Vec<&str> = commands.iter()
            .filter_map(|c| c["cmd"].as_str())
            .collect();

        assert!(names.contains(&"/tasks"), "should find /tasks with intervening aliases");
        assert!(names.contains(&"/branch"), "should find /branch with intervening aliases");
        assert!(names.contains(&"/permissions"), "should find /permissions with intervening aliases");

        let tasks_desc = commands.iter()
            .find(|c| c["cmd"].as_str() == Some("/tasks"))
            .and_then(|c| c["desc"].as_str())
            .unwrap();
        assert_eq!(tasks_desc, "List and manage background tasks");
    }

    #[test]
    fn discover_builtin_reversed_property_order() {
        // Commands where description comes before name in the object
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = concat!(
            r#"var x={description:"Restore the code and/or conversation to a previous point",name:"rewind",aliases:["checkpoint"],type:"local"};"#,
            r#" var y={description:"View release notes",name:"release-notes",type:"local",supportsNonInteractive:!0};"#,
        );
        std::fs::write(&js_path, content).unwrap();

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();
        let names: Vec<&str> = commands.iter()
            .filter_map(|c| c["cmd"].as_str())
            .collect();

        assert!(names.contains(&"/rewind"), "should find /rewind with reversed order");
        assert!(names.contains(&"/release-notes"), "should find /release-notes with reversed order");

        let rewind_desc = commands.iter()
            .find(|c| c["cmd"].as_str() == Some("/rewind"))
            .and_then(|c| c["desc"].as_str())
            .unwrap();
        assert!(rewind_desc.contains("Restore"), "rewind should have its description");
    }

    #[test]
    fn discover_builtin_computed_description() {
        // Commands with ternary or function-call descriptions
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = concat!(
            r#"var x={type:"local-jsx",name:"login",description:yv$()?"Switch Anthropic accounts":"Sign in with your Anthropic account",load:()=>null};"#,
            r#" var y={type:"local-jsx",name:"terminal-setup",description:M6==="Apple"?"Enable Option key":"Install Shift key",load:()=>null};"#,
        );
        std::fs::write(&js_path, content).unwrap();

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();
        let names: Vec<&str> = commands.iter()
            .filter_map(|c| c["cmd"].as_str())
            .collect();

        assert!(names.contains(&"/login"), "should find /login with computed description");
        assert!(names.contains(&"/terminal-setup"), "should find /terminal-setup with computed description");

        let login_desc = commands.iter()
            .find(|c| c["cmd"].as_str() == Some("/login"))
            .and_then(|c| c["desc"].as_str())
            .unwrap();
        assert!(login_desc.contains("Anthropic"), "login should have first branch of ternary as description");
    }

    #[test]
    fn discover_builtin_template_literal_description() {
        // Commands with template literal (backtick) descriptions
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = r#"var x={type:"local-jsx",name:"model",get description(){return`Set the AI model for Claude Code (currently ${Bw(Zf())})`}}"#;
        std::fs::write(&js_path, content).unwrap();

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();
        let names: Vec<&str> = commands.iter()
            .filter_map(|c| c["cmd"].as_str())
            .collect();

        assert!(names.contains(&"/model"), "should find /model with template literal description");

        let model_desc = commands.iter()
            .find(|c| c["cmd"].as_str() == Some("/model"))
            .and_then(|c| c["desc"].as_str())
            .unwrap();
        assert!(model_desc.contains("Set the AI model"), "model should have template literal text");
        assert!(!model_desc.contains("${"), "interpolations should be stripped");
    }

    #[test]
    fn discover_builtin_name_only_fallback() {
        // Commands with no extractable description get empty desc
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        // Name exists but description is a bare variable reference (no quoted strings nearby).
        // Include a standard-pattern command (with object boundary) so content passes is_claude_content.
        let content = concat!(
            r#"var z={type:"local",name:"review",description:"Review code"};"#,
            r#"var x={type:"local",name:"fast",get description(){return someVar},load:()=>null}"#,
        );
        std::fs::write(&js_path, content).unwrap();

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();
        let names: Vec<&str> = commands.iter()
            .filter_map(|c| c["cmd"].as_str())
            .collect();

        assert!(names.contains(&"/fast"), "should find /fast even without extractable description");

        let fast_desc = commands.iter()
            .find(|c| c["cmd"].as_str() == Some("/fast"))
            .and_then(|c| c["desc"].as_str())
            .unwrap();
        assert_eq!(fast_desc, "", "should have empty description as fallback");
    }

    #[test]
    fn discover_builtin_no_cross_object_theft() {
        // A command with no description must not steal the next object's description
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = concat!(
            r#"var a={name:"foo",type:"local",load:()=>null};"#,
            r#"var b={type:"local",name:"bar",description:"Bar description",load:()=>null};"#,
        );
        std::fs::write(&js_path, content).unwrap();

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();

        let foo_desc = commands.iter()
            .find(|c| c["cmd"].as_str() == Some("/foo"))
            .and_then(|c| c["desc"].as_str())
            .unwrap();
        let bar_desc = commands.iter()
            .find(|c| c["cmd"].as_str() == Some("/bar"))
            .and_then(|c| c["desc"].as_str())
            .unwrap();

        assert_eq!(foo_desc, "", "/foo should not steal /bar's description");
        assert_eq!(bar_desc, "Bar description", "/bar should keep its own description");
    }

    #[test]
    fn discover_builtin_rejects_non_command_names() {
        // highlight.js languages, signals, HTML elements — all lack type:"prompt/local/local-jsx"
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = concat!(
            r#"var real={type:"prompt",name:"commit",description:"Create a git commit"}; "#,
            r#"{name:"Python",value:"python"}; "#,
            r#"{name:"SIGABRT",number:6,action:"core",description:"Aborted",standard:"ansi"}; "#,
            r#"NK({tag:"div",name:"HTMLDivElement",ctor:function($,q,K){i_.call(this,$,q,K)}})"#,
        );
        std::fs::write(&js_path, content).unwrap();

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();
        let names: Vec<&str> = commands.iter()
            .filter_map(|c| c["cmd"].as_str())
            .collect();

        assert!(names.contains(&"/commit"), "real command should be found");
        assert!(!names.contains(&"/Python"), "highlight.js language should be filtered");
        assert!(!names.contains(&"/SIGABRT"), "signal should be filtered");
        assert!(!names.contains(&"/HTMLDivElement"), "HTML element should be filtered");
    }

    #[test]
    fn discover_builtin_filters_hidden_commands() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = concat!(
            r#"var a={type:"local",name:"heapdump",description:"Dump the JS heap",isHidden:!0,load:()=>null};"#,
            r#"var b={type:"local-jsx",name:"help",description:"Show help",load:()=>null};"#,
        );
        std::fs::write(&js_path, content).unwrap();

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();
        let names: Vec<&str> = commands.iter()
            .filter_map(|c| c["cmd"].as_str())
            .collect();

        assert!(!names.contains(&"/heapdump"), "isHidden:!0 command should be filtered");
        assert!(names.contains(&"/help"), "visible command should be kept");
    }

    #[test]
    fn discover_builtin_filters_mcp_template_names() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = concat!(
            r#"var a={type:"prompt",name:"mcp__",description:"MCP prompt"}; "#,
            r#"var b={type:"local-jsx",name:"mcp",description:"Manage MCP servers"};"#,
        );
        std::fs::write(&js_path, content).unwrap();

        let result = discover_builtin_commands_sync(Some(js_path.to_str().unwrap()));
        let commands = result.unwrap();
        let names: Vec<&str> = commands.iter()
            .filter_map(|c| c["cmd"].as_str())
            .collect();

        assert!(!names.contains(&"/mcp__"), "MCP template fragment should be filtered");
        assert!(names.contains(&"/mcp"), "real /mcp command should be kept");
    }

    // --- discover_settings_schema_sync tests ---

    #[test]
    fn discover_schema_extracts_boolean_field() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        // Must also pass is_claude_content validation
        let content = concat!(
            r#"name:"init",description:"Initialize" "#,
            r#"verboseMode:u.boolean().optional().describe("Enable verbose logging")"#,
        );
        std::fs::write(&js_path, content).unwrap();

        let result = discover_settings_schema_sync(Some(js_path.to_str().unwrap()));
        assert!(result.is_ok());
        let fields = result.unwrap();
        let verbose = fields.iter().find(|f| f["key"] == "verboseMode");
        assert!(verbose.is_some(), "should find verboseMode field");
        let v = verbose.unwrap();
        assert_eq!(v["type"], "boolean");
        assert_eq!(v["optional"], true);
        assert!(v["description"].as_str().unwrap().contains("verbose logging"));
    }

    #[test]
    fn discover_schema_extracts_enum_with_choices() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = concat!(
            r#"name:"init",description:"Initialize" "#,
            r#"themeMode:u.enum(["light","dark","system"]).optional().describe("UI theme preference")"#,
        );
        std::fs::write(&js_path, content).unwrap();

        let result = discover_settings_schema_sync(Some(js_path.to_str().unwrap()));
        let fields = result.unwrap();
        let theme = fields.iter().find(|f| f["key"] == "themeMode");
        assert!(theme.is_some(), "should find themeMode field");
        let t = theme.unwrap();
        assert_eq!(t["type"], "enum");
        let choices: Vec<&str> = t["choices"].as_array().unwrap()
            .iter().filter_map(|v| v.as_str()).collect();
        assert_eq!(choices, vec!["light", "dark", "system"]);
    }

    #[test]
    fn discover_schema_skips_noise_keys() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        // "type", "name", "value" are in the skip list
        let content = concat!(
            r#"name:"init",description:"Initialize" "#,
            r#"type:u.string().describe("Should be skipped") "#,
            r#"value:u.string().describe("Should be skipped") "#,
            r#"customSetting:u.string().describe("Should be kept")"#,
        );
        std::fs::write(&js_path, content).unwrap();

        let result = discover_settings_schema_sync(Some(js_path.to_str().unwrap()));
        let fields = result.unwrap();
        let keys: Vec<&str> = fields.iter()
            .filter_map(|f| f["key"].as_str())
            .collect();
        assert!(!keys.contains(&"type"), "noise key 'type' should be skipped");
        assert!(!keys.contains(&"value"), "noise key 'value' should be skipped");
        assert!(keys.contains(&"customSetting"), "valid key should be kept");
    }

    #[test]
    fn discover_schema_skips_fields_without_describe() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        // Separate the two fields with enough distance that noDescription's lookahead
        // cannot reach hasDescription's .describe(). The lookahead window is 400 chars.
        // Use non-alphanumeric padding so regex key boundaries work correctly.
        let padding = ";".repeat(500);
        let content = format!(
            r#"name:"init",description:"Initialize" noDescription:u.boolean().optional() {}hasDescription:u.boolean().optional().describe("Has a description")"#,
            padding
        );
        std::fs::write(&js_path, content).unwrap();

        let result = discover_settings_schema_sync(Some(js_path.to_str().unwrap()));
        let fields = result.unwrap();
        let keys: Vec<&str> = fields.iter()
            .filter_map(|f| f["key"].as_str())
            .collect();
        assert!(!keys.contains(&"noDescription"), "field without .describe() should be skipped");
        assert!(keys.contains(&"hasDescription"), "field with .describe() should be kept");
    }

    #[test]
    fn discover_schema_no_schemas_in_content() {
        // Content passes is_claude_content but has no Zod patterns
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");
        let content = r#"name:"init",description:"Initialize" no zod here"#;
        std::fs::write(&js_path, content).unwrap();

        let result = discover_settings_schema_sync(Some(js_path.to_str().unwrap()));
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty(), "no Zod patterns means no schema fields");
    }

    #[test]
    fn discover_schema_sorts_alphabetically() {
        let dir = tempfile::tempdir().unwrap();
        let js_path = dir.path().join("cli.js");

        let content = concat!(
            r#"name:"init",description:"Initialize" "#,
            r#"zebraSetting:u.string().describe("Zebra setting") "#,
            r#"alphaSetting:u.string().describe("Alpha setting") "#,
            r#"middleSetting:u.string().describe("Middle setting")"#,
        );
        std::fs::write(&js_path, content).unwrap();

        let result = discover_settings_schema_sync(Some(js_path.to_str().unwrap()));
        let fields = result.unwrap();
        let keys: Vec<&str> = fields.iter()
            .filter_map(|f| f["key"].as_str())
            .collect();
        assert_eq!(keys, vec!["alphaSetting", "middleSetting", "zebraSetting"], "should be sorted alphabetically");
    }

    // --- build_claude_args tests ---

    #[test]
    fn build_args_project_dir_preserves_forward_slashes() {
        let config = SessionConfig {
            working_dir: "/home/user/project".into(),
            project_dir: true,
            ..Default::default()
        };
        let args = build_claude_args(config).unwrap();
        let idx = args.iter().position(|a| a == "--project-dir").unwrap();
        let dir_arg = &args[idx + 1];
        #[cfg(not(target_os = "windows"))]
        assert_eq!(dir_arg, "/home/user/project", "Linux paths must keep forward slashes");
        #[cfg(target_os = "windows")]
        assert_eq!(dir_arg, "\\home\\user\\project", "Windows should normalize to backslashes");
    }
}

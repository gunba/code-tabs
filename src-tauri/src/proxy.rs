use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use tauri::{Emitter, State};

use crate::session::types::{ModelProvider, ModelRoute, ProviderConfig, SystemPromptRule};

// ── Proxy state ──────────────────────────────────────────────────────

pub struct ProxyInner {
    pub config: ProviderConfig,
    pub rules: Vec<SystemPromptRule>,
    pub port: Option<u16>,
    pub shutdown_tx: Option<oneshot::Sender<()>>,
    pub clients: HashMap<String, reqwest::Client>,
    pub default_client: reqwest::Client,
    pub traffic_log_files: HashMap<String, std::io::BufWriter<std::fs::File>>,
    pub traffic_log_paths: HashMap<String, std::path::PathBuf>,
}

pub struct ProxyState(pub Arc<Mutex<ProxyInner>>);

impl ProxyState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(ProxyInner {
            config: ProviderConfig::default(),
            rules: Vec::new(),
            port: None,
            shutdown_tx: None,
            clients: HashMap::new(),
            default_client: build_plain_client(),
            traffic_log_files: HashMap::new(),
            traffic_log_paths: HashMap::new(),
        })))
    }
}

// ── Client builders ──────────────────────────────────────────────────

fn build_plain_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .expect("plain reqwest client must build")
}

fn build_client_for_provider(provider: &ModelProvider) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300));

    if let Some(ref proxy_url) = provider.socks5_proxy {
        let proxy = reqwest::Proxy::all(proxy_url)
            .map_err(|e| format!("Invalid SOCKS5 proxy for '{}': {e}", provider.name))?;
        builder = builder.proxy(proxy);
    }

    builder.build().map_err(|e| format!("Client build failed for '{}': {e}", provider.name))
}

fn build_client_map(config: &ProviderConfig) -> Result<HashMap<String, reqwest::Client>, String> {
    let mut clients = HashMap::new();
    for provider in &config.providers {
        if provider.socks5_proxy.is_some() {
            clients.insert(provider.id.clone(), build_client_for_provider(provider)?);
        }
    }
    Ok(clients)
}

// ── Commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_api_proxy(
    config: ProviderConfig,
    proxy_state: State<'_, ProxyState>,
    app: tauri::AppHandle,
) -> Result<u16, String> {
    let inner = proxy_state.0.clone();

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Proxy bind failed: {e}"))?;
    let port = listener.local_addr().map_err(|e| format!("{e}"))?.port();

    let clients = build_client_map(&config)?;
    let default_client = build_plain_client();

    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();

    {
        let mut s = inner.lock().map_err(|e| e.to_string())?;
        s.config = config;
        s.port = Some(port);
        s.shutdown_tx = Some(shutdown_tx);
        s.clients = clients;
        s.default_client = default_client.clone();
    }

    let state = inner.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                result = listener.accept() => {
                    match result {
                        Ok((stream, _)) => {
                            let (config, clients, default_client, rules) = match state.lock() {
                                Ok(s) => (s.config.clone(), s.clients.clone(), s.default_client.clone(), s.rules.clone()),
                                Err(_) => continue,
                            };
                            let a = app.clone();
                            let st = state.clone();
                            tokio::spawn(async move {
                                if let Err(e) = handle_connection(stream, config, clients, default_client, rules, a, st).await {
                                    log::debug!("proxy connection error: {e}");
                                }
                            });
                        }
                        Err(e) => {
                            log::warn!("proxy accept error: {e}");
                            break;
                        }
                    }
                }
                _ = &mut shutdown_rx => {
                    break;
                }
            }
        }
    });

    Ok(port)
}

#[tauri::command]
pub fn stop_api_proxy(proxy_state: State<'_, ProxyState>) -> Result<(), String> {
    let mut s = proxy_state.0.lock().map_err(|e| e.to_string())?;
    if let Some(tx) = s.shutdown_tx.take() {
        let _ = tx.send(());
    }
    s.port = None;
    s.clients.clear();
    Ok(())
}

#[tauri::command]
pub fn update_provider_config(
    config: ProviderConfig,
    proxy_state: State<'_, ProxyState>,
) -> Result<(), String> {
    let clients = build_client_map(&config)?;
    let mut s = proxy_state.0.lock().map_err(|e| e.to_string())?;
    s.config = config;
    s.clients = clients;
    Ok(())
}

#[tauri::command]
pub fn get_proxy_port(proxy_state: State<'_, ProxyState>) -> Result<Option<u16>, String> {
    let s = proxy_state.0.lock().map_err(|e| e.to_string())?;
    Ok(s.port)
}

#[tauri::command]
pub fn update_system_prompt_rules(
    rules: Vec<SystemPromptRule>,
    proxy_state: State<'_, ProxyState>,
) -> Result<(), String> {
    // Validate all enabled rule patterns at config time
    for rule in &rules {
        if rule.enabled && !rule.pattern.is_empty() {
            let inline_flags: String = rule.flags.chars().filter(|c| *c != 'g').collect();
            let pattern = if inline_flags.is_empty() {
                rule.pattern.clone()
            } else {
                format!("(?{}){}", inline_flags, rule.pattern)
            };
            let _ = regex::Regex::new(&pattern)
                .map_err(|e| format!("Invalid regex '{}': {}", rule.pattern, e))?;
        }
    }
    let mut s = proxy_state.0.lock().map_err(|e| e.to_string())?;
    s.rules = rules;
    Ok(())
}

// ── Traffic logging commands ─────────────────────────────────────────

#[tauri::command]
pub fn start_traffic_log(session_id: String, proxy_state: State<'_, ProxyState>) -> Result<String, String> {
    let dir = crate::commands::get_session_data_dir(&session_id)?;
    let path = dir.join("traffic.jsonl");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to create traffic log: {}", e))?;
    let writer = std::io::BufWriter::new(file);
    let mut s = proxy_state.0.lock().map_err(|e| e.to_string())?;
    s.traffic_log_files.insert(session_id.clone(), writer);
    s.traffic_log_paths.insert(session_id, path.clone());
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn stop_traffic_log(session_id: String, proxy_state: State<'_, ProxyState>) -> Result<(), String> {
    let mut s = proxy_state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut writer) = s.traffic_log_files.get_mut(&session_id) {
        use std::io::Write;
        let _ = writer.flush();
    }
    s.traffic_log_files.remove(&session_id);
    s.traffic_log_paths.remove(&session_id);
    Ok(())
}

#[tauri::command]
pub fn get_traffic_log_path(session_id: String, proxy_state: State<'_, ProxyState>) -> Result<Option<String>, String> {
    let s = proxy_state.0.lock().map_err(|e| e.to_string())?;
    Ok(s.traffic_log_paths.get(&session_id).map(|p| p.to_string_lossy().to_string()))
}

// cleanup_traffic_logs removed — unified cleanup via commands::cleanup_session_data

// ── Connection handler ───────────────────────────────────────────────

async fn handle_connection(
    mut stream: tokio::net::TcpStream,
    config: ProviderConfig,
    clients: HashMap<String, reqwest::Client>,
    default_client: reqwest::Client,
    rules: Vec<SystemPromptRule>,
    app: tauri::AppHandle,
    proxy_state: Arc<Mutex<ProxyInner>>,
) -> Result<(), Box<dyn std::error::Error>> {
    // Read full request
    let mut buf: Vec<u8> = Vec::new();
    let mut tmp = [0u8; 65536];

    loop {
        let n = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            stream.read(&mut tmp),
        )
        .await??;

        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&tmp[..n]);

        if let Some(hend) = find_header_end(&buf) {
            if let Some(cl) = extract_content_length(&String::from_utf8_lossy(&buf[..hend])) {
                if buf.len() >= hend + cl {
                    break;
                }
            } else {
                break;
            }
        }

        if buf.len() > 50 * 1024 * 1024 {
            send_error(&mut stream, 413, "Request too large").await;
            return Ok(());
        }
    }

    let (method, raw_path, headers, body) = match parse_request(&buf) {
        Some(r) => r,
        None => {
            send_error(&mut stream, 400, "Bad request").await;
            return Ok(());
        }
    };

    // Extract session ID from /s/{id}/... path prefix and strip it
    let (session_id, path) = extract_session_id(&raw_path);

    // Determine if traffic logging is active for this session
    let should_log = session_id.as_ref().map_or(false, |id| {
        proxy_state.lock().ok().map_or(false, |s| s.traffic_log_files.contains_key(id))
    });

    // Route: extract model, find matching route + provider, rewrite if needed
    let model = extract_model(&body);
    let (route, provider) = route_request(model.as_deref(), &config);

    let rewrite = route.and_then(|r| r.rewrite_model.as_deref());
    let mut final_body = match rewrite {
        Some(new_model) => rewrite_model_in_body(&body, new_model),
        None => body.to_vec(),
    };
    if !rules.is_empty() {
        final_body = rewrite_system_prompt_in_body(&final_body, &rules);
    }

    // Emit routing event for debug panel visibility
    let _ = app.emit("proxy-route", serde_json::json!({
        "model": model.as_deref().unwrap_or("(none)"),
        "provider": provider.name,
        "rewrite": rewrite,
        "path": path,
    }));

    // Build upstream URL
    let url = format!("{}{}", provider.base_url.trim_end_matches('/'), path);

    // Build upstream request
    let client = clients.get(&provider.id).unwrap_or(&default_client);
    let http_method = reqwest::Method::from_bytes(method.as_bytes())
        .unwrap_or(reqwest::Method::POST);
    let mut req = client.request(http_method, &url);

    let has_provider_key = provider.api_key.is_some();
    for (k, v) in &headers {
        let lower = k.to_lowercase();
        if lower == "host" || lower == "content-length" {
            continue;
        }
        // When provider has its own key, strip all auth headers and replace with provider key
        if has_provider_key && (lower == "x-api-key" || lower == "authorization") {
            continue;
        }
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some(ref key) = provider.api_key {
        req = req.header("x-api-key", key);
    }

    // Capture request body for traffic logging before it's consumed
    let final_body_for_log = if should_log { Some(final_body.clone()) } else { None };
    let req_start = std::time::Instant::now();
    let req_ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();
    let log_model = model.clone();
    let log_provider = provider.name.clone();
    let log_rewrite = rewrite.map(|s| s.to_string());
    let log_method = method.clone();
    let log_path = path.clone();
    let log_session_id = session_id.clone();

    req = req.body(final_body);

    // Send upstream request
    let mut resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            if should_log {
                write_traffic_entry(
                    &proxy_state, &log_session_id, req_ts, req_start,
                    &log_method, &log_path, &log_model, &log_provider, &log_rewrite,
                    &final_body_for_log, 502, b"",
                );
            }
            send_error(&mut stream, 502, &format!("Upstream error: {e}")).await;
            return Ok(());
        }
    };

    let status_code = resp.status().as_u16();
    let status_text = resp.status().canonical_reason().unwrap_or("Unknown");

    // Write response status + headers
    let mut resp_hdrs = format!("HTTP/1.1 {status_code} {status_text}\r\n");
    for (k, v) in resp.headers() {
        let lower = k.as_str().to_lowercase();
        if lower == "transfer-encoding" || lower == "content-length" {
            continue;
        }
        let val = v.to_str().unwrap_or("");
        resp_hdrs.push_str(&format!("{k}: {val}\r\n"));
    }
    resp_hdrs.push_str("Connection: close\r\n\r\n");
    stream.write_all(resp_hdrs.as_bytes()).await?;

    // Stream response body — flush each chunk immediately for SSE
    let mut resp_buf: Option<Vec<u8>> = if should_log { Some(Vec::with_capacity(8192)) } else { None };
    while let Some(chunk) = resp.chunk().await? {
        stream.write_all(&chunk).await?;
        stream.flush().await?;
        if let Some(ref mut buf) = resp_buf {
            buf.extend_from_slice(&chunk);
        }
    }

    // Write traffic log entry after response completes
    if let Some(resp_bytes) = resp_buf {
        write_traffic_entry(
            &proxy_state, &log_session_id, req_ts, req_start,
            &log_method, &log_path, &log_model, &log_provider, &log_rewrite,
            &final_body_for_log, status_code, &resp_bytes,
        );
    }

    Ok(())
}

/// Decompress gzip bytes to a UTF-8 string, falling back to lossy conversion.
fn decompress_if_gzip(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        use std::io::Read;
        let mut decoder = flate2::read::GzDecoder::new(bytes);
        let mut decompressed = Vec::new();
        if decoder.read_to_end(&mut decompressed).is_ok() {
            return String::from_utf8_lossy(&decompressed).into_owned();
        }
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn write_traffic_entry(
    proxy_state: &Arc<Mutex<ProxyInner>>,
    session_id: &Option<String>,
    req_ts: f64,
    req_start: std::time::Instant,
    method: &str,
    path: &str,
    model: &Option<String>,
    provider: &str,
    rewrite: &Option<String>,
    req_body: &Option<Vec<u8>>,
    status: u16,
    resp_bytes: &[u8],
) {
    let sid = match session_id {
        Some(id) => id,
        None => return,
    };
    let dur_ms = req_start.elapsed().as_millis() as u64;
    let req_str = req_body.as_ref().map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
    let resp_str = decompress_if_gzip(resp_bytes);
    let req_len = req_body.as_ref().map(|b| b.len()).unwrap_or(0);

    let line = serde_json::json!({
        "ts": req_ts,
        "dur_ms": dur_ms,
        "session_id": sid,
        "method": method,
        "path": path,
        "model": model.as_deref().unwrap_or("(none)"),
        "provider": provider,
        "rewrite": rewrite,
        "req_len": req_len,
        "req": req_str,
        "status": status,
        "resp_len": resp_bytes.len(),
        "resp": resp_str,
    });

    if let Ok(mut s) = proxy_state.lock() {
        if let Some(ref mut writer) = s.traffic_log_files.get_mut(sid) {
            use std::io::Write;
            let _ = writeln!(writer, "{}", line);
            let _ = writer.flush();
        }
    }
}

// ── Routing ─────────────────────────────────────────────────────────

/// Find the first matching route and its provider. Falls back to default provider.
fn route_request<'a>(
    model: Option<&str>,
    config: &'a ProviderConfig,
) -> (Option<&'a ModelRoute>, &'a ModelProvider) {
    let default_provider = config
        .providers
        .iter()
        .find(|p| p.id == config.default_provider_id)
        .or_else(|| config.providers.first());

    let m = match model {
        Some(m) => m,
        None => return (None, default_provider.unwrap_or_else(|| &FALLBACK_PROVIDER)),
    };

    for route in &config.routes {
        if glob_match::glob_match(&route.pattern, m) {
            let provider = config
                .providers
                .iter()
                .find(|p| p.id == route.provider_id)
                .or(default_provider)
                .unwrap_or(&FALLBACK_PROVIDER);
            return (Some(route), provider);
        }
    }

    (None, default_provider.unwrap_or(&FALLBACK_PROVIDER))
}

static FALLBACK_PROVIDER: ModelProvider = ModelProvider {
    id: String::new(),
    name: String::new(),
    base_url: String::new(),
    api_key: None,
    socks5_proxy: None,
};

fn rewrite_model_in_body(body: &[u8], new_model: &str) -> Vec<u8> {
    if let Ok(mut json) = serde_json::from_slice::<serde_json::Value>(body) {
        if let Some(obj) = json.as_object_mut() {
            obj.insert(
                "model".to_string(),
                serde_json::Value::String(new_model.to_string()),
            );
        }
        serde_json::to_vec(&json).unwrap_or_else(|_| body.to_vec())
    } else {
        body.to_vec()
    }
}

fn rewrite_system_prompt_in_body(body: &[u8], rules: &[SystemPromptRule]) -> Vec<u8> {
    let enabled: Vec<&SystemPromptRule> = rules.iter().filter(|r| r.enabled && !r.pattern.is_empty()).collect();
    if enabled.is_empty() {
        return body.to_vec();
    }
    let mut json = match serde_json::from_slice::<serde_json::Value>(body) {
        Ok(j) => j,
        Err(_) => return body.to_vec(),
    };
    let system = match json.get_mut("system") {
        Some(s) => s,
        None => return serde_json::to_vec(&json).unwrap_or_else(|_| body.to_vec()),
    };
    apply_rules_to_system_value(system, &enabled);
    serde_json::to_vec(&json).unwrap_or_else(|_| body.to_vec())
}

fn apply_rules_to_system_value(system: &mut serde_json::Value, rules: &[&SystemPromptRule]) {
    match system {
        serde_json::Value::String(s) => {
            *s = apply_rules_to_text(s, rules);
        }
        serde_json::Value::Array(arr) => {
            for item in arr.iter_mut() {
                if let Some(obj) = item.as_object_mut() {
                    if obj.get("type").and_then(|v| v.as_str()) == Some("text") {
                        if let Some(text_val) = obj.get_mut("text") {
                            if let serde_json::Value::String(ref mut s) = text_val {
                                *s = apply_rules_to_text(s, rules);
                            }
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

fn apply_rules_to_text(text: &str, rules: &[&SystemPromptRule]) -> String {
    let mut result = text.to_string();
    for rule in rules {
        let inline_flags: String = rule.flags.chars().filter(|c| *c != 'g').collect();
        let pattern = if inline_flags.is_empty() {
            rule.pattern.clone()
        } else {
            format!("(?{}){}", inline_flags, rule.pattern)
        };
        if let Ok(re) = regex::Regex::new(&pattern) {
            result = re.replace_all(&result, &rule.replacement).into_owned();
        }
    }
    result
}

// ── Helpers ──────────────────────────────────────────────────────────

/// Extract session ID from `/s/{id}/...` path prefix.
/// Returns `(Some(id), stripped_path)` or `(None, original_path)`.
fn extract_session_id(path: &str) -> (Option<String>, String) {
    if let Some(rest) = path.strip_prefix("/s/") {
        if let Some(slash_pos) = rest.find('/') {
            let id = &rest[..slash_pos];
            let remaining = &rest[slash_pos..];
            return (Some(id.to_string()), remaining.to_string());
        }
    }
    (None, path.to_string())
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    for i in 0..buf.len().saturating_sub(3) {
        if buf[i..i + 4] == [b'\r', b'\n', b'\r', b'\n'] {
            return Some(i + 4);
        }
    }
    None
}

fn extract_content_length(headers: &str) -> Option<usize> {
    for line in headers.lines() {
        let lower = line.to_lowercase();
        if lower.starts_with("content-length:") {
            return line.split(':').nth(1)?.trim().parse().ok();
        }
    }
    None
}

fn parse_request(buf: &[u8]) -> Option<(String, String, Vec<(String, String)>, Vec<u8>)> {
    let hend = find_header_end(buf)?;
    let hdr = String::from_utf8_lossy(&buf[..hend - 4]);
    let mut lines = hdr.lines();
    let req_line = lines.next()?;
    let mut parts = req_line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut headers = Vec::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    Some((method, path, headers, buf[hend..].to_vec()))
}

fn extract_model(body: &[u8]) -> Option<String> {
    let json: serde_json::Value = serde_json::from_slice(body).ok()?;
    json.get("model")?.as_str().map(|s| s.to_string())
}

async fn send_error(stream: &mut tokio::net::TcpStream, status: u16, msg: &str) {
    let body = serde_json::json!({
        "type": "error",
        "error": { "type": "proxy_error", "message": msg }
    }).to_string();
    let reason = match status {
        400 => "Bad Request",
        413 => "Too Large",
        500 => "Internal Error",
        502 => "Bad Gateway",
        _ => "Error",
    };
    let resp = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len(),
    );
    let _ = stream.write_all(resp.as_bytes()).await;
    let _ = stream.flush().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_route_request_default() {
        let config = ProviderConfig::default();
        let (route, provider) = route_request(Some("anything"), &config);
        assert!(route.is_some());
        assert_eq!(provider.id, "anthropic");
    }

    #[test]
    fn test_route_request_pattern_match() {
        let config = ProviderConfig {
            providers: vec![
                ModelProvider {
                    id: "glm".into(),
                    name: "GLM".into(),
                    base_url: "https://api.z.ai/api/anthropic".into(),
                    api_key: Some("k".into()),
                    socks5_proxy: None,
                },
                ModelProvider {
                    id: "anthropic".into(),
                    name: "Anthropic".into(),
                    base_url: "https://api.anthropic.com".into(),
                    api_key: None,
                    socks5_proxy: None,
                },
            ],
            routes: vec![
                ModelRoute {
                    id: "r1".into(),
                    pattern: "glm-*".into(),
                    rewrite_model: None,
                    provider_id: "glm".into(),
                },
                ModelRoute {
                    id: "r2".into(),
                    pattern: "*".into(),
                    rewrite_model: None,
                    provider_id: "anthropic".into(),
                },
            ],
            default_provider_id: "anthropic".into(),
        };
        let (_, p) = route_request(Some("glm-5.0"), &config);
        assert_eq!(p.id, "glm");
        let (_, p) = route_request(Some("claude-opus-4-6"), &config);
        assert_eq!(p.id, "anthropic");
    }

    #[test]
    fn test_route_request_with_rewrite() {
        let config = ProviderConfig {
            providers: vec![
                ModelProvider {
                    id: "glm".into(),
                    name: "GLM".into(),
                    base_url: "https://api.z.ai/api/anthropic".into(),
                    api_key: Some("k".into()),
                    socks5_proxy: None,
                },
                ModelProvider {
                    id: "anthropic".into(),
                    name: "Anthropic".into(),
                    base_url: "https://api.anthropic.com".into(),
                    api_key: None,
                    socks5_proxy: None,
                },
            ],
            routes: vec![
                ModelRoute {
                    id: "r1".into(),
                    pattern: "claude-haiku-*".into(),
                    rewrite_model: Some("glm-5.0".into()),
                    provider_id: "glm".into(),
                },
                ModelRoute {
                    id: "r2".into(),
                    pattern: "*".into(),
                    rewrite_model: None,
                    provider_id: "anthropic".into(),
                },
            ],
            default_provider_id: "anthropic".into(),
        };
        let (route, provider) = route_request(Some("claude-haiku-4-5-20251001"), &config);
        assert_eq!(provider.id, "glm");
        assert_eq!(
            route.unwrap().rewrite_model.as_deref(),
            Some("glm-5.0")
        );
    }

    #[test]
    fn test_route_request_no_model() {
        let config = ProviderConfig::default();
        let (route, provider) = route_request(None, &config);
        assert!(route.is_none());
        assert_eq!(provider.id, "anthropic");
    }

    #[test]
    fn test_route_ordering_first_match_wins() {
        let config = ProviderConfig {
            providers: vec![
                ModelProvider {
                    id: "a".into(),
                    name: "A".into(),
                    base_url: "http://a".into(),
                    api_key: None,
                    socks5_proxy: None,
                },
                ModelProvider {
                    id: "b".into(),
                    name: "B".into(),
                    base_url: "http://b".into(),
                    api_key: None,
                    socks5_proxy: None,
                },
            ],
            routes: vec![
                ModelRoute {
                    id: "r1".into(),
                    pattern: "claude-*".into(),
                    rewrite_model: None,
                    provider_id: "a".into(),
                },
                ModelRoute {
                    id: "r2".into(),
                    pattern: "claude-haiku-*".into(),
                    rewrite_model: None,
                    provider_id: "b".into(),
                },
            ],
            default_provider_id: "a".into(),
        };
        // "claude-*" matches first, even though "claude-haiku-*" is more specific
        let (_, p) = route_request(Some("claude-haiku-4-5"), &config);
        assert_eq!(p.id, "a");
    }

    #[test]
    fn test_route_provider_missing_fallback() {
        let config = ProviderConfig {
            providers: vec![ModelProvider {
                id: "anthropic".into(),
                name: "Anthropic".into(),
                base_url: "https://api.anthropic.com".into(),
                api_key: None,
                socks5_proxy: None,
            }],
            routes: vec![ModelRoute {
                id: "r1".into(),
                pattern: "*".into(),
                rewrite_model: None,
                provider_id: "nonexistent".into(),
            }],
            default_provider_id: "anthropic".into(),
        };
        // Route matches but provider_id "nonexistent" doesn't exist -> falls back to default
        let (route, provider) = route_request(Some("test"), &config);
        assert!(route.is_some());
        assert_eq!(provider.id, "anthropic");
    }

    #[test]
    fn test_rewrite_model() {
        let body = br#"{"model":"claude-haiku-4-5-20251001","messages":[]}"#;
        let rewritten = rewrite_model_in_body(body, "glm-5.0");
        let json: serde_json::Value = serde_json::from_slice(&rewritten).unwrap();
        assert_eq!(json["model"], "glm-5.0");
        // Other fields preserved
        assert!(json["messages"].is_array());
    }

    #[test]
    fn test_rewrite_model_invalid_json() {
        let body = b"not json";
        let rewritten = rewrite_model_in_body(body, "glm-5.0");
        assert_eq!(rewritten, body);
    }

    #[test]
    fn test_extract_model() {
        let b = br#"{"model":"claude-opus-4-6","messages":[]}"#;
        assert_eq!(extract_model(b), Some("claude-opus-4-6".into()));
    }

    #[test]
    fn test_find_header_end() {
        assert_eq!(
            find_header_end(b"GET / HTTP/1.1\r\nHost: x\r\n\r\nbody"),
            Some(27)
        );
    }

    #[test]
    fn test_content_length() {
        assert_eq!(
            extract_content_length("POST /v1/messages HTTP/1.1\r\nContent-Length: 42\r\n"),
            Some(42)
        );
    }

    // ── SOCKS5 client builder tests ──────────────────────────────────

    #[test]
    fn test_build_client_map_no_proxy() {
        let config = ProviderConfig::default();
        let clients = build_client_map(&config).unwrap();
        assert!(clients.is_empty(), "no providers have socks5_proxy, map should be empty");
    }

    #[test]
    fn test_build_client_map_with_proxy() {
        let config = ProviderConfig {
            providers: vec![
                ModelProvider {
                    id: "proxied".into(),
                    name: "Proxied".into(),
                    base_url: "https://api.example.com".into(),
                    api_key: None,
                    socks5_proxy: Some("socks5h://user:pass@127.0.0.1:1080".into()),
                },
                ModelProvider {
                    id: "direct".into(),
                    name: "Direct".into(),
                    base_url: "https://api.anthropic.com".into(),
                    api_key: None,
                    socks5_proxy: None,
                },
            ],
            routes: vec![],
            default_provider_id: "direct".into(),
        };
        let clients = build_client_map(&config).unwrap();
        assert_eq!(clients.len(), 1, "only proxied provider should be in map");
        assert!(clients.contains_key("proxied"), "proxied provider should have a client");
        assert!(!clients.contains_key("direct"), "direct provider should not be in map");
    }

    #[test]
    fn test_build_client_map_invalid_proxy_url() {
        let config = ProviderConfig {
            providers: vec![ModelProvider {
                id: "bad".into(),
                name: "Bad".into(),
                base_url: "https://api.example.com".into(),
                api_key: None,
                socks5_proxy: Some("not a valid url!!!".into()),
            }],
            routes: vec![],
            default_provider_id: "bad".into(),
        };
        let result = build_client_map(&config);
        assert!(result.is_err(), "invalid proxy URL should return Err");
    }

    // ── System prompt rewrite tests ──────────────────────────────────────

    fn make_rule(name: &str, pattern: &str, replacement: &str, flags: &str, enabled: bool) -> SystemPromptRule {
        SystemPromptRule {
            id: format!("rule-{}", name),
            name: name.to_string(),
            pattern: pattern.to_string(),
            replacement: replacement.to_string(),
            flags: flags.to_string(),
            enabled,
        }
    }

    #[test]
    fn test_rewrite_system_prompt_string() {
        let body = r#"{"model":"claude-opus-4-6","system":"You are Claude, a helpful assistant.","messages":[]}"#;
        let rules = vec![make_rule("rename", "Claude", "Assistant", "g", true)];
        let result = rewrite_system_prompt_in_body(body.as_bytes(), &rules);
        let json: serde_json::Value = serde_json::from_slice(&result).unwrap();
        assert_eq!(json["system"], "You are Assistant, a helpful assistant.");
        assert_eq!(json["model"], "claude-opus-4-6");
    }

    #[test]
    fn test_rewrite_system_prompt_array() {
        let body = r#"{"model":"test","system":[{"type":"text","text":"You are Claude."},{"type":"text","text":"Be helpful."}],"messages":[]}"#;
        let rules = vec![make_rule("rename", "Claude", "Assistant", "g", true)];
        let result = rewrite_system_prompt_in_body(body.as_bytes(), &rules);
        let json: serde_json::Value = serde_json::from_slice(&result).unwrap();
        let sys = json["system"].as_array().unwrap();
        assert_eq!(sys[0]["text"], "You are Assistant.");
        assert_eq!(sys[1]["text"], "Be helpful.");
    }

    #[test]
    fn test_rewrite_system_prompt_multiple_rules() {
        let body = r#"{"system":"Hello world","messages":[]}"#;
        let rules = vec![
            make_rule("r1", "Hello", "Hi", "g", true),
            make_rule("r2", "world", "earth", "g", true),
        ];
        let result = rewrite_system_prompt_in_body(body.as_bytes(), &rules);
        let json: serde_json::Value = serde_json::from_slice(&result).unwrap();
        assert_eq!(json["system"], "Hi earth");
    }

    #[test]
    fn test_rewrite_system_prompt_disabled_rule_skipped() {
        let body = r#"{"system":"Hello Claude","messages":[]}"#;
        let rules = vec![make_rule("off", "Claude", "Assistant", "g", false)];
        let result = rewrite_system_prompt_in_body(body.as_bytes(), &rules);
        let json: serde_json::Value = serde_json::from_slice(&result).unwrap();
        assert_eq!(json["system"], "Hello Claude");
    }

    #[test]
    fn test_rewrite_system_prompt_empty_rules() {
        let body = r#"{"system":"Hello","messages":[]}"#;
        let result = rewrite_system_prompt_in_body(body.as_bytes(), &[]);
        assert_eq!(result, body.as_bytes());
    }

    #[test]
    fn test_rewrite_system_prompt_no_system_field() {
        let body = r#"{"model":"test","messages":[]}"#;
        let rules = vec![make_rule("r", "x", "y", "g", true)];
        let result = rewrite_system_prompt_in_body(body.as_bytes(), &rules);
        let json: serde_json::Value = serde_json::from_slice(&result).unwrap();
        assert!(json.get("system").is_none());
        assert_eq!(json["model"], "test");
    }

    #[test]
    fn test_rewrite_system_prompt_invalid_json() {
        let body = b"not json";
        let rules = vec![make_rule("r", "x", "y", "g", true)];
        let result = rewrite_system_prompt_in_body(body, &rules);
        assert_eq!(result, body);
    }

    #[test]
    fn test_rewrite_system_prompt_case_insensitive() {
        let body = r#"{"system":"CLAUDE claude Claude","messages":[]}"#;
        let rules = vec![make_rule("ci", "claude", "Assistant", "gi", true)];
        let result = rewrite_system_prompt_in_body(body.as_bytes(), &rules);
        let json: serde_json::Value = serde_json::from_slice(&result).unwrap();
        assert_eq!(json["system"], "Assistant Assistant Assistant");
    }

    #[test]
    fn test_rewrite_system_prompt_capture_groups() {
        let body = r#"{"system":"Use (tools) wisely","messages":[]}"#;
        let rules = vec![make_rule("cg", r#"\((\w+)\)"#, "[$1]", "g", true)];
        let result = rewrite_system_prompt_in_body(body.as_bytes(), &rules);
        let json: serde_json::Value = serde_json::from_slice(&result).unwrap();
        assert_eq!(json["system"], "Use [tools] wisely");
    }

    #[test]
    fn test_rewrite_system_prompt_empty_pattern_skipped() {
        let body = r#"{"system":"Hello","messages":[]}"#;
        let rules = vec![make_rule("empty", "", "x", "g", true)];
        let result = rewrite_system_prompt_in_body(body.as_bytes(), &rules);
        let json: serde_json::Value = serde_json::from_slice(&result).unwrap();
        assert_eq!(json["system"], "Hello");
    }
}

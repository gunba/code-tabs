//! Slim prompt-rewrite proxy.
//!
// [SP-01] Slim proxy: prompt rewrite + traffic logging only; Anthropic
// and OpenAI are forwarded unchanged except for rule application on the
// provider-native prompt field.
//! What this module is: a localhost HTTP forwarder for Claude Code's
//! `POST /v1/messages` traffic and Codex's OpenAI Responses traffic. It
//! applies user-defined regex rules to Claude's `system` field or
//! OpenAI's `instructions` field (PromptsTab) before forwarding to the
//! original provider, and optionally tees request/response to a
//! per-session `traffic.jsonl`. That's it.
//!
//! What it isn't (and used to be): an Anthropic↔OpenAI translator, a
//! provider router, an OAuth client, a compression engine. All of
//! that lived in `proxy/codex/` and `proxy/compress/` and is gone.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use tauri::State;

use crate::observability::{
    record_backend_event, record_backend_perf_end, record_backend_perf_fail,
    record_backend_perf_start,
};
use crate::session::types::SystemPromptRule;

// ── Proxy state ──────────────────────────────────────────────────────

pub struct ProxyInner {
    pub rules: Vec<SystemPromptRule>,
    pub port: Option<u16>,
    pub shutdown_tx: Option<oneshot::Sender<()>>,
    pub default_client: reqwest::Client,
    pub traffic_log_files: HashMap<String, std::io::BufWriter<std::fs::File>>,
    pub traffic_log_paths: HashMap<String, std::path::PathBuf>,
    pub rule_match_counts: HashMap<String, u64>,
}

pub struct ProxyState(pub Arc<Mutex<ProxyInner>>);

impl ProxyState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(ProxyInner {
            rules: Vec::new(),
            port: None,
            shutdown_tx: None,
            default_client: build_plain_client(),
            traffic_log_files: HashMap::new(),
            traffic_log_paths: HashMap::new(),
            rule_match_counts: HashMap::new(),
        })))
    }
}

fn build_plain_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .expect("plain reqwest client must build")
}

// ── Commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_api_proxy(
    proxy_state: State<'_, ProxyState>,
    app: tauri::AppHandle,
) -> Result<u16, String> {
    let inner = proxy_state.0.clone();
    let span_start = std::time::Instant::now();
    let span_data = serde_json::json!({});
    record_backend_perf_start(
        &app,
        "proxy",
        None,
        "proxy.start_api_proxy",
        span_data.clone(),
    );

    let result: Result<u16, String> = async {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("Proxy bind failed: {e}"))?;
        let port = listener.local_addr().map_err(|e| format!("{e}"))?.port();

        let default_client = build_plain_client();
        let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();

        {
            let mut s = inner.lock().map_err(|e| e.to_string())?;
            s.port = Some(port);
            s.shutdown_tx = Some(shutdown_tx);
            s.default_client = default_client.clone();
        }

        record_backend_event(
            &app,
            "LOG",
            "proxy",
            None,
            "proxy.started",
            "API proxy started",
            serde_json::json!({ "port": port }),
        );

        let state = inner.clone();
        let app_for_loop = app.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    result = listener.accept() => {
                        match result {
                            Ok((stream, addr)) => {
                                record_backend_event(
                                    &app_for_loop,
                                    "DEBUG",
                                    "proxy",
                                    None,
                                    "proxy.connection_accepted",
                                    "Accepted proxy client connection",
                                    serde_json::json!({ "remoteAddr": addr.to_string() }),
                                );
                                let (default_client, rules) = match state.lock() {
                                    Ok(s) => (s.default_client.clone(), s.rules.clone()),
                                    Err(_) => continue,
                                };
                                let a = app_for_loop.clone();
                                let st = state.clone();
                                tokio::spawn(async move {
                                    if let Err(e) = handle_connection(stream, default_client, rules, a, st).await {
                                        log::debug!("proxy connection error: {e}");
                                    }
                                });
                            }
                            Err(e) => {
                                log::warn!("proxy accept error: {e}");
                                record_backend_event(
                                    &app_for_loop,
                                    "WARN",
                                    "proxy",
                                    None,
                                    "proxy.accept_failed",
                                    "Proxy accept failed",
                                    serde_json::json!({ "error": e.to_string() }),
                                );
                                break;
                            }
                        }
                    }
                    _ = &mut shutdown_rx => {
                        record_backend_event(
                            &app_for_loop,
                            "LOG",
                            "proxy",
                            None,
                            "proxy.shutdown_requested",
                            "Proxy shutdown requested",
                            serde_json::json!({}),
                        );
                        break;
                    }
                }
            }
        });

        Ok(port)
    }
    .await;

    match result {
        Ok(port) => {
            record_backend_perf_end(
                &app,
                "proxy",
                None,
                "proxy.start_api_proxy",
                span_start,
                250,
                span_data,
                serde_json::json!({ "port": port }),
            );
            Ok(port)
        }
        Err(err) => {
            record_backend_perf_fail(
                &app,
                "proxy",
                None,
                "proxy.start_api_proxy",
                span_start,
                span_data,
                serde_json::json!({}),
                &err,
            );
            Err(err)
        }
    }
}

#[tauri::command]
pub fn update_system_prompt_rules(
    rules: Vec<SystemPromptRule>,
    proxy_state: State<'_, ProxyState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let span_start = std::time::Instant::now();
    let span_data = serde_json::json!({
        "ruleCount": rules.len(),
        "enabledRuleCount": rules.iter().filter(|rule| rule.enabled).count(),
    });
    record_backend_perf_start(
        &app,
        "proxy",
        None,
        "proxy.update_system_prompt_rules",
        span_data.clone(),
    );
    let result = (|| -> Result<(), String> {
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
        let active_ids: std::collections::HashSet<String> =
            rules.iter().map(|r| r.id.clone()).collect();
        s.rule_match_counts.retain(|id, _| active_ids.contains(id));
        s.rules = rules;
        Ok(())
    })();
    match result {
        Ok(()) => {
            record_backend_event(
                &app,
                "LOG",
                "proxy",
                None,
                "proxy.system_prompt_rules_updated",
                "Updated system prompt rewrite rules",
                serde_json::json!({}),
            );
            record_backend_perf_end(
                &app,
                "proxy",
                None,
                "proxy.update_system_prompt_rules",
                span_start,
                250,
                span_data,
                serde_json::json!({}),
            );
            Ok(())
        }
        Err(err) => {
            record_backend_perf_fail(
                &app,
                "proxy",
                None,
                "proxy.update_system_prompt_rules",
                span_start,
                span_data,
                serde_json::json!({}),
                &err,
            );
            Err(err)
        }
    }
}

// [CM-32] Per-session rule match counters: HashMap<ruleId, count>;
// incremented on each proxy match; get_rule_match_counts exposes it
// to the frontend (PromptsTab polls every 2s).
#[tauri::command]
pub fn get_rule_match_counts(
    proxy_state: State<'_, ProxyState>,
) -> Result<HashMap<String, u64>, String> {
    let s = proxy_state.0.lock().map_err(|e| e.to_string())?;
    Ok(s.rule_match_counts.clone())
}

#[tauri::command]
pub fn start_traffic_log(
    session_id: String,
    proxy_state: State<'_, ProxyState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let span_start = std::time::Instant::now();
    let span_data = serde_json::json!({ "sessionId": session_id });
    record_backend_perf_start(
        &app,
        "traffic",
        Some(&session_id),
        "traffic.start_log",
        span_data.clone(),
    );
    let result = (|| -> Result<String, String> {
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
        s.traffic_log_paths.insert(session_id.clone(), path.clone());
        Ok(path.to_string_lossy().to_string())
    })();
    match result {
        Ok(path) => {
            record_backend_event(
                &app,
                "LOG",
                "traffic",
                Some(&session_id),
                "traffic.log_started",
                "Started traffic log",
                serde_json::json!({ "path": path }),
            );
            record_backend_perf_end(
                &app,
                "traffic",
                Some(&session_id),
                "traffic.start_log",
                span_start,
                250,
                span_data,
                serde_json::json!({ "path": path }),
            );
            Ok(path)
        }
        Err(err) => {
            record_backend_perf_fail(
                &app,
                "traffic",
                Some(&session_id),
                "traffic.start_log",
                span_start,
                span_data,
                serde_json::json!({}),
                &err,
            );
            Err(err)
        }
    }
}

#[tauri::command]
pub fn stop_traffic_log(
    session_id: String,
    proxy_state: State<'_, ProxyState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let span_start = std::time::Instant::now();
    let span_data = serde_json::json!({ "sessionId": session_id });
    record_backend_perf_start(
        &app,
        "traffic",
        Some(&session_id),
        "traffic.stop_log",
        span_data.clone(),
    );
    let result = (|| -> Result<(), String> {
        let mut s = proxy_state.0.lock().map_err(|e| e.to_string())?;
        if let Some(ref mut writer) = s.traffic_log_files.get_mut(&session_id) {
            use std::io::Write;
            let _ = writer.flush();
        }
        s.traffic_log_files.remove(&session_id);
        s.traffic_log_paths.remove(&session_id);
        Ok(())
    })();
    match result {
        Ok(()) => {
            record_backend_event(
                &app,
                "LOG",
                "traffic",
                Some(&session_id),
                "traffic.log_stopped",
                "Stopped traffic log",
                serde_json::json!({}),
            );
            record_backend_perf_end(
                &app,
                "traffic",
                Some(&session_id),
                "traffic.stop_log",
                span_start,
                250,
                span_data,
                serde_json::json!({}),
            );
            Ok(())
        }
        Err(err) => {
            record_backend_perf_fail(
                &app,
                "traffic",
                Some(&session_id),
                "traffic.stop_log",
                span_start,
                span_data,
                serde_json::json!({}),
                &err,
            );
            Err(err)
        }
    }
}

// ── Connection handling ─────────────────────────────────────────────

const ANTHROPIC_UPSTREAM_BASE_URL: &str = "https://api.anthropic.com";
const OPENAI_UPSTREAM_BASE_URL: &str = "https://api.openai.com";
const CHATGPT_UPSTREAM_BASE_URL: &str = "https://chatgpt.com";

// [SP-02] Per-request upstream resolver: anthropic / openai / chatgpt routing + path matchers + Responses API instructions rewrite (Codex/OpenAI Responses analog of Claude system field). ChatGpt covers the chatgpt.com/backend-api/codex endpoints used by Codex sessions authenticated via ChatGPT subscription; OpenAi covers api.openai.com/v1 used by API-key-authenticated sessions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UpstreamKind {
    Anthropic,
    OpenAi,
    ChatGpt,
}

impl UpstreamKind {
    fn base_url(self) -> &'static str {
        match self {
            UpstreamKind::Anthropic => ANTHROPIC_UPSTREAM_BASE_URL,
            UpstreamKind::OpenAi => OPENAI_UPSTREAM_BASE_URL,
            UpstreamKind::ChatGpt => CHATGPT_UPSTREAM_BASE_URL,
        }
    }

    fn label(self) -> &'static str {
        match self {
            UpstreamKind::Anthropic => "anthropic",
            UpstreamKind::OpenAi => "openai",
            UpstreamKind::ChatGpt => "chatgpt",
        }
    }
}

fn path_matches_endpoint(path: &str, endpoint: &str) -> bool {
    path == endpoint
        || path.strip_prefix(endpoint).map_or(false, |suffix| {
            suffix.starts_with('?') || suffix.starts_with('/')
        })
}

fn is_anthropic_endpoint(path: &str) -> bool {
    path_matches_endpoint(path, "/v1/messages") || path_matches_endpoint(path, "/v1/complete")
}

fn is_openai_responses_endpoint(path: &str) -> bool {
    path_matches_endpoint(path, "/v1/responses")
}

// Match exactly the Codex Responses endpoint on chatgpt.com — NOT a broad
// `/backend-api/codex/` prefix. Codex hits adjacent endpoints there
// (account/usage/etc.) that should pass through unrewritten.
fn is_chatgpt_responses_endpoint(path: &str) -> bool {
    path_matches_endpoint(path, "/backend-api/codex/responses")
}

fn resolve_upstream(path: &str) -> UpstreamKind {
    if is_anthropic_endpoint(path) {
        UpstreamKind::Anthropic
    } else if path.starts_with("/backend-api/codex/") || path == "/backend-api/codex" {
        UpstreamKind::ChatGpt
    } else if path.starts_with("/v1/") {
        UpstreamKind::OpenAi
    } else {
        UpstreamKind::Anthropic
    }
}

async fn handle_connection(
    mut stream: tokio::net::TcpStream,
    default_client: reqwest::Client,
    rules: Vec<SystemPromptRule>,
    app: tauri::AppHandle,
    proxy_state: Arc<Mutex<ProxyInner>>,
) -> std::io::Result<()> {
    // Read the request (headers + body) up to 50 MiB.
    let mut buf = Vec::with_capacity(8192);
    loop {
        let mut tmp = [0u8; 8192];
        let n = stream.read(&mut tmp).await?;
        if n == 0 {
            break;
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

    // /s/{id}/... session-scoped prefix is stripped for the upstream call
    // but kept around for traffic-log lookup.
    let (session_id, path) = extract_session_id(&raw_path);

    let should_log = session_id.as_ref().map_or(false, |id| {
        proxy_state
            .lock()
            .ok()
            .map_or(false, |s| s.traffic_log_files.contains_key(id))
    });

    let model = extract_model(&body);

    let upstream = resolve_upstream(&path);
    let rewritable_prompt_endpoint = match upstream {
        UpstreamKind::Anthropic => is_anthropic_endpoint(&path),
        UpstreamKind::OpenAi => is_openai_responses_endpoint(&path),
        UpstreamKind::ChatGpt => is_chatgpt_responses_endpoint(&path),
    };

    // Apply prompt rewrite rules to the provider-native prompt field:
    // Claude/Anthropic => `system`, OpenAI / ChatGPT Responses => `instructions`
    // (same wire shape on both endpoints).
    let (final_body, matched_ids) = if rules.is_empty() || !rewritable_prompt_endpoint {
        (body.to_vec(), Vec::new())
    } else {
        match upstream {
            UpstreamKind::Anthropic => rewrite_system_prompt_in_body(&body, &rules),
            UpstreamKind::OpenAi | UpstreamKind::ChatGpt => {
                rewrite_openai_instructions_in_body(&body, &rules)
            }
        }
    };
    if !matched_ids.is_empty() {
        if let Ok(mut s) = proxy_state.lock() {
            for id in &matched_ids {
                *s.rule_match_counts.entry(id.clone()).or_insert(0) += 1;
            }
        }
    }

    record_backend_event(
        &app,
        "DEBUG",
        "proxy",
        session_id.as_deref(),
        "proxy.route_resolved",
        "Resolved proxy route",
        serde_json::json!({
            "method": method,
            "rawPath": raw_path,
            "path": path,
            "upstream": upstream.label(),
            "sessionScoped": session_id.is_some(),
            "requestModel": model,
            "promptRulesEligible": rewritable_prompt_endpoint,
            "promptRulesApplied": !matched_ids.is_empty(),
            "shouldLogTraffic": should_log,
        }),
    );

    // Build upstream request. This is routing only, not provider translation:
    // headers and request bodies otherwise pass through unchanged.
    let url = format!("{}{}", upstream.base_url().trim_end_matches('/'), path);
    let http_method =
        reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::POST);
    let mut req = default_client.request(http_method, &url);
    for (k, v) in &headers {
        let lower = k.to_lowercase();
        if lower == "host" || lower == "content-length" {
            continue;
        }
        req = req.header(k.as_str(), v.as_str());
    }

    let final_body_for_log = if should_log {
        Some(final_body.clone())
    } else {
        None
    };
    let req_start = std::time::Instant::now();
    let req_ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();
    let log_method = method.clone();
    let log_path = path.clone();
    let log_session_id = session_id.clone();
    let log_model = model.clone();
    let route_span_data = serde_json::json!({
        "method": log_method,
        "path": log_path,
        "model": log_model,
        "upstream": upstream.label(),
        "shouldLogTraffic": should_log,
    });
    record_backend_perf_start(
        &app,
        "proxy",
        log_session_id.as_deref(),
        "proxy.route_request",
        route_span_data.clone(),
    );

    req = req.body(final_body);

    let mut resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let error_message = e.to_string();
            if should_log {
                write_traffic_entry(
                    &proxy_state,
                    &log_session_id,
                    req_ts,
                    req_start,
                    &log_method,
                    &log_path,
                    &log_model,
                    &final_body_for_log,
                    502,
                    b"",
                );
            }
            record_backend_perf_fail(
                &app,
                "proxy",
                log_session_id.as_deref(),
                "proxy.route_request",
                req_start,
                route_span_data.clone(),
                serde_json::json!({}),
                &error_message,
            );
            record_backend_event(
                &app,
                "WARN",
                "proxy",
                log_session_id.as_deref(),
                "proxy.request_failed",
                "Upstream proxy request failed",
                serde_json::json!({
                    "durationMs": req_start.elapsed().as_millis() as u64,
                    "method": log_method,
                    "path": log_path,
                    "upstream": upstream.label(),
                    "model": log_model,
                    "error": error_message,
                }),
            );
            send_error(&mut stream, 502, &format!("Upstream error: {e}")).await;
            return Ok(());
        }
    };

    let status_code = resp.status().as_u16();
    let status_text = resp.status().canonical_reason().unwrap_or("Unknown");

    // [WX-01] Cloudflare's edge tags every Anthropic / OpenAI response with
    // `cf-ipcountry`. Forward the value to the weather module for ambient-
    // viz weather. Fire-and-forget; never blocks the response stream.
    if let Some(cc) = resp
        .headers()
        .get("cf-ipcountry")
        .and_then(|v| v.to_str().ok())
    {
        crate::weather::set_country(cc);
    }

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

    let mut resp_buf: Option<Vec<u8>> = if should_log {
        Some(Vec::with_capacity(8192))
    } else {
        None
    };
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?
    {
        stream.write_all(&chunk).await?;
        stream.flush().await?;
        if let Some(ref mut buf) = resp_buf {
            buf.extend_from_slice(&chunk);
        }
    }

    if let Some(resp_bytes) = resp_buf {
        write_traffic_entry(
            &proxy_state,
            &log_session_id,
            req_ts,
            req_start,
            &log_method,
            &log_path,
            &log_model,
            &final_body_for_log,
            status_code,
            &resp_bytes,
        );
    }

    record_backend_perf_end(
        &app,
        "proxy",
        log_session_id.as_deref(),
        "proxy.route_request",
        req_start,
        1000,
        route_span_data,
        serde_json::json!({ "status": status_code }),
    );
    record_backend_event(
        &app,
        "LOG",
        "proxy",
        log_session_id.as_deref(),
        "proxy.request_completed",
        "Proxy request completed",
        serde_json::json!({
            "durationMs": req_start.elapsed().as_millis() as u64,
            "method": log_method,
            "path": log_path,
            "upstream": upstream.label(),
            "model": log_model,
            "status": status_code,
        }),
    );

    Ok(())
}

// ── Traffic log helpers ─────────────────────────────────────────────

fn decompress_if_gzip(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        use std::io::Read;
        let mut decoder = flate2::read::GzDecoder::new(bytes);
        let mut decoded = String::new();
        if decoder.read_to_string(&mut decoded).is_ok() {
            return decoded;
        }
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn build_traffic_entry_json(
    req_ts: f64,
    dur_ms: u64,
    sid: &str,
    method: &str,
    path: &str,
    model: &Option<String>,
    req_body: &Option<Vec<u8>>,
    status: u16,
    resp_bytes: &[u8],
) -> Value {
    let req_str = req_body
        .as_ref()
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .unwrap_or_default();
    let resp_str = decompress_if_gzip(resp_bytes);
    let req_len = req_body.as_ref().map(|b| b.len()).unwrap_or(0);

    serde_json::json!({
        "ts": req_ts,
        "dur_ms": dur_ms,
        "session_id": sid,
        "method": method,
        "path": path,
        "model": model.as_deref().unwrap_or("(none)"),
        "req_len": req_len,
        "req": req_str,
        "status": status,
        "resp_len": resp_bytes.len(),
        "resp": resp_str,
    })
}

pub(crate) fn write_traffic_entry(
    proxy_state: &Arc<Mutex<ProxyInner>>,
    session_id: &Option<String>,
    req_ts: f64,
    req_start: std::time::Instant,
    method: &str,
    path: &str,
    model: &Option<String>,
    req_body: &Option<Vec<u8>>,
    status: u16,
    resp_bytes: &[u8],
) {
    let sid = match session_id {
        Some(id) => id,
        None => return,
    };
    let dur_ms = req_start.elapsed().as_millis() as u64;
    let line = build_traffic_entry_json(
        req_ts, dur_ms, sid, method, path, model, req_body, status, resp_bytes,
    );

    if let Ok(mut s) = proxy_state.lock() {
        if let Some(ref mut writer) = s.traffic_log_files.get_mut(sid) {
            use std::io::Write;
            let _ = writeln!(writer, "{}", line);
            let _ = writer.flush();
        }
    }
}

// ── System prompt rule application ──────────────────────────────────

fn rewrite_system_prompt_in_body(
    body: &[u8],
    rules: &[SystemPromptRule],
) -> (Vec<u8>, Vec<String>) {
    let enabled: Vec<&SystemPromptRule> = rules
        .iter()
        .filter(|r| r.enabled && !r.pattern.is_empty())
        .collect();
    if enabled.is_empty() {
        return (body.to_vec(), Vec::new());
    }
    let mut json = match serde_json::from_slice::<serde_json::Value>(body) {
        Ok(j) => j,
        Err(_) => return (body.to_vec(), Vec::new()),
    };
    let system = match json.get_mut("system") {
        Some(s) => s,
        None => {
            return (
                serde_json::to_vec(&json).unwrap_or_else(|_| body.to_vec()),
                Vec::new(),
            );
        }
    };
    let mut matched: Vec<String> = Vec::new();
    apply_rules_to_system_value(system, &enabled, &mut matched);
    (
        serde_json::to_vec(&json).unwrap_or_else(|_| body.to_vec()),
        matched,
    )
}

fn rewrite_openai_instructions_in_body(
    body: &[u8],
    rules: &[SystemPromptRule],
) -> (Vec<u8>, Vec<String>) {
    let enabled: Vec<&SystemPromptRule> = rules
        .iter()
        .filter(|r| r.enabled && !r.pattern.is_empty())
        .collect();
    if enabled.is_empty() {
        return (body.to_vec(), Vec::new());
    }
    let mut json = match serde_json::from_slice::<serde_json::Value>(body) {
        Ok(j) => j,
        Err(_) => return (body.to_vec(), Vec::new()),
    };
    let instructions = match json.get_mut("instructions") {
        Some(serde_json::Value::String(s)) => s,
        _ => return (body.to_vec(), Vec::new()),
    };
    let mut matched: Vec<String> = Vec::new();
    *instructions = apply_rules_to_text(instructions, &enabled, &mut matched);
    (
        serde_json::to_vec(&json).unwrap_or_else(|_| body.to_vec()),
        matched,
    )
}

fn apply_rules_to_system_value(
    system: &mut serde_json::Value,
    rules: &[&SystemPromptRule],
    matched: &mut Vec<String>,
) {
    match system {
        serde_json::Value::String(s) => {
            *s = apply_rules_to_text(s, rules, matched);
        }
        serde_json::Value::Array(arr) => {
            for item in arr.iter_mut() {
                if let Some(obj) = item.as_object_mut() {
                    if obj.get("type").and_then(|v| v.as_str()) == Some("text") {
                        if let Some(text_val) = obj.get_mut("text") {
                            if let serde_json::Value::String(ref mut s) = text_val {
                                *s = apply_rules_to_text(s, rules, matched);
                            }
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

fn apply_rules_to_text(
    text: &str,
    rules: &[&SystemPromptRule],
    matched: &mut Vec<String>,
) -> String {
    let mut result = text.to_string();
    for rule in rules {
        let inline_flags: String = rule.flags.chars().filter(|c| *c != 'g').collect();
        let pattern = if inline_flags.is_empty() {
            rule.pattern.clone()
        } else {
            format!("(?{}){}", inline_flags, rule.pattern)
        };
        if let Ok(re) = regex::Regex::new(&pattern) {
            let replaced = re.replace_all(&result, &rule.replacement).into_owned();
            if replaced != result {
                if !matched.contains(&rule.id) {
                    matched.push(rule.id.clone());
                }
                result = replaced;
            }
        }
    }
    result
}

// ── HTTP parsing helpers ────────────────────────────────────────────

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
    })
    .to_string();
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

    fn make_rule(id: &str, pattern: &str, replacement: &str, enabled: bool) -> SystemPromptRule {
        SystemPromptRule {
            id: id.into(),
            name: id.into(),
            pattern: pattern.into(),
            flags: String::new(),
            replacement: replacement.into(),
            enabled,
        }
    }

    #[test]
    fn test_extract_model() {
        let body = br#"{"model":"claude-sonnet-4-5","messages":[]}"#;
        assert_eq!(extract_model(body), Some("claude-sonnet-4-5".into()));
    }

    #[test]
    fn test_extract_model_missing() {
        let body = br#"{"messages":[]}"#;
        assert_eq!(extract_model(body), None);
    }

    #[test]
    fn test_find_header_end() {
        let buf = b"GET / HTTP/1.1\r\nHost: x\r\n\r\nbody";
        assert_eq!(find_header_end(buf), Some(27));
    }

    #[test]
    fn test_content_length() {
        let h = "POST / HTTP/1.1\r\nContent-Length: 42\r\n";
        assert_eq!(extract_content_length(h), Some(42));
    }

    #[test]
    fn test_extract_session_id_present() {
        let (sid, p) = extract_session_id("/s/abc123/v1/messages");
        assert_eq!(sid.as_deref(), Some("abc123"));
        assert_eq!(p, "/v1/messages");
    }

    #[test]
    fn test_extract_session_id_absent() {
        let (sid, p) = extract_session_id("/v1/messages");
        assert_eq!(sid, None);
        assert_eq!(p, "/v1/messages");
    }

    #[test]
    fn test_rewrite_system_prompt_string() {
        let body = br#"{"model":"x","system":"hello world","messages":[]}"#;
        let rule = make_rule("r1", "hello", "goodbye", true);
        let (out, matched) = rewrite_system_prompt_in_body(body, &[rule]);
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["system"], "goodbye world");
        assert_eq!(matched, vec!["r1".to_string()]);
    }

    #[test]
    fn test_rewrite_system_prompt_array() {
        let body = br#"{"model":"x","system":[{"type":"text","text":"alpha beta"}],"messages":[]}"#;
        let rule = make_rule("r1", "alpha", "ALPHA", true);
        let (out, matched) = rewrite_system_prompt_in_body(body, &[rule]);
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["system"][0]["text"], "ALPHA beta");
        assert_eq!(matched, vec!["r1".to_string()]);
    }

    #[test]
    fn test_rewrite_system_prompt_disabled_rule_skipped() {
        let body = br#"{"model":"x","system":"hello","messages":[]}"#;
        let rule = make_rule("r1", "hello", "goodbye", false);
        let (out, matched) = rewrite_system_prompt_in_body(body, &[rule]);
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["system"], "hello");
        assert!(matched.is_empty());
    }

    #[test]
    fn test_rewrite_system_prompt_empty_rules() {
        let body = br#"{"model":"x","system":"hello","messages":[]}"#;
        let (out, matched) = rewrite_system_prompt_in_body(body, &[]);
        assert_eq!(out, body);
        assert!(matched.is_empty());
    }

    #[test]
    fn test_rewrite_system_prompt_multiple_rules() {
        let body = br#"{"model":"x","system":"foo bar baz","messages":[]}"#;
        let rules = vec![
            make_rule("r1", "foo", "FOO", true),
            make_rule("r2", "baz", "BAZ", true),
        ];
        let (out, matched) = rewrite_system_prompt_in_body(body, &rules);
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["system"], "FOO bar BAZ");
        assert_eq!(matched.len(), 2);
        assert!(matched.contains(&"r1".into()));
        assert!(matched.contains(&"r2".into()));
    }

    #[test]
    fn test_rewrite_openai_instructions_prompt() {
        let body = br#"{"model":"gpt-5.2","instructions":"hello world","input":[]}"#;
        let rule = make_rule("r1", "hello", "goodbye", true);
        let (out, matched) = rewrite_openai_instructions_in_body(body, &[rule]);
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["instructions"], "goodbye world");
        assert_eq!(matched, vec!["r1".to_string()]);
    }

    #[test]
    fn test_rewrite_openai_instructions_missing_is_noop() {
        let body = br#"{"model":"gpt-5.2","input":[]}"#;
        let rule = make_rule("r1", "hello", "goodbye", true);
        let (out, matched) = rewrite_openai_instructions_in_body(body, &[rule]);
        assert_eq!(out, body);
        assert!(matched.is_empty());
    }

    #[test]
    fn test_resolve_upstream_routes_provider_native_endpoints() {
        assert_eq!(resolve_upstream("/v1/messages"), UpstreamKind::Anthropic);
        assert_eq!(
            resolve_upstream("/v1/messages/count_tokens"),
            UpstreamKind::Anthropic
        );
        assert_eq!(resolve_upstream("/v1/responses"), UpstreamKind::OpenAi);
        assert_eq!(resolve_upstream("/v1/models"), UpstreamKind::OpenAi);
        assert_eq!(
            resolve_upstream("/backend-api/codex/responses"),
            UpstreamKind::ChatGpt
        );
        assert_eq!(
            resolve_upstream("/backend-api/codex/account"),
            UpstreamKind::ChatGpt
        );
    }

    #[test]
    fn test_is_chatgpt_responses_endpoint_is_exact_match() {
        assert!(is_chatgpt_responses_endpoint("/backend-api/codex/responses"));
        assert!(is_chatgpt_responses_endpoint(
            "/backend-api/codex/responses?stream=true"
        ));
        assert!(is_chatgpt_responses_endpoint(
            "/backend-api/codex/responses/123"
        ));
        // Non-responses paths under the same prefix must NOT match — they
        // should pass through to chatgpt.com without prompt-rewrite.
        assert!(!is_chatgpt_responses_endpoint(
            "/backend-api/codex/account"
        ));
        assert!(!is_chatgpt_responses_endpoint("/backend-api/codex"));
        assert!(!is_chatgpt_responses_endpoint("/v1/responses"));
    }

    #[test]
    fn test_chatgpt_upstream_rewrites_instructions() {
        // Routing test: confirm a request targeted at the ChatGPT-codex
        // Responses endpoint runs through the same instructions-rewrite
        // path as the api.openai.com Responses endpoint.
        let path = "/backend-api/codex/responses";
        let upstream = resolve_upstream(path);
        assert_eq!(upstream, UpstreamKind::ChatGpt);
        let rewritable = match upstream {
            UpstreamKind::Anthropic => is_anthropic_endpoint(path),
            UpstreamKind::OpenAi => is_openai_responses_endpoint(path),
            UpstreamKind::ChatGpt => is_chatgpt_responses_endpoint(path),
        };
        assert!(rewritable);

        let body = br#"{"model":"gpt-5.2","instructions":"hello world","input":[]}"#;
        let rule = make_rule("r1", "hello", "goodbye", true);
        let (out, matched) = rewrite_openai_instructions_in_body(body, &[rule]);
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["instructions"], "goodbye world");
        assert_eq!(matched, vec!["r1".to_string()]);
    }

    #[test]
    fn test_build_traffic_entry_basic_shape() {
        let entry = build_traffic_entry_json(
            1234.5,
            42,
            "sid-1",
            "POST",
            "/v1/messages",
            &Some("sonnet".into()),
            &Some(b"{}".to_vec()),
            200,
            b"hello",
        );
        assert_eq!(entry["session_id"], "sid-1");
        assert_eq!(entry["method"], "POST");
        assert_eq!(entry["model"], "sonnet");
        assert_eq!(entry["status"], 200);
        assert_eq!(entry["resp_len"], 5);
    }
}

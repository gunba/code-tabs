use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use tauri::{Emitter, State};

use crate::observability::{
    record_backend_event, record_backend_perf_end, record_backend_perf_fail,
    record_backend_perf_start,
};
use crate::session::types::{ModelMapping, ModelProvider, ProviderConfig, SystemPromptRule};

pub mod codex;
pub mod compress;

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
    pub session_providers: HashMap<String, String>,
    pub session_requested_models: HashMap<String, String>,
    pub session_launch_models: HashMap<String, String>,
    pub codex_auth: codex::auth::CodexAuthState,
    pub codex_client: reqwest::Client,
    pub compression_enabled: bool,
    pub rule_match_counts: HashMap<String, u64>,
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
            session_providers: HashMap::new(),
            session_requested_models: HashMap::new(),
            session_launch_models: HashMap::new(),
            codex_auth: codex::auth::CodexAuthState::new(
                dirs::data_local_dir()
                    .unwrap_or_default()
                    .join("claude-tabs"),
            ),
            codex_client: build_plain_client(),
            compression_enabled: false,
            rule_match_counts: HashMap::new(),
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
    let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(300));

    if let Some(ref proxy_url) = provider.socks5_proxy {
        let proxy = reqwest::Proxy::all(proxy_url)
            .map_err(|e| format!("Invalid SOCKS5 proxy for '{}': {e}", provider.name))?;
        builder = builder.proxy(proxy);
    }

    builder
        .build()
        .map_err(|e| format!("Client build failed for '{}': {e}", provider.name))
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
    let span_start = std::time::Instant::now();
    let span_data = serde_json::json!({
        "providerCount": config.providers.len(),
    });
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

        record_backend_event(
            &app,
            "LOG",
            "proxy",
            None,
            "proxy.started",
            "API proxy started",
            serde_json::json!({
                "port": port,
            }),
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
                                    serde_json::json!({
                                        "remoteAddr": addr.to_string(),
                                    }),
                                );
                                let (config, clients, default_client, rules, session_providers, session_requested_models, session_launch_models, compression_enabled) = match state.lock() {
                                    Ok(s) => (
                                        s.config.clone(),
                                        s.clients.clone(),
                                        s.default_client.clone(),
                                        s.rules.clone(),
                                        s.session_providers.clone(),
                                        s.session_requested_models.clone(),
                                        s.session_launch_models.clone(),
                                        s.compression_enabled,
                                    ),
                                    Err(_) => continue,
                                };
                                let a = app_for_loop.clone();
                                let st = state.clone();
                                tokio::spawn(async move {
                                    if let Err(e) = handle_connection(stream, config, clients, default_client, rules, session_providers, session_requested_models, session_launch_models, compression_enabled, a, st).await {
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
                                    serde_json::json!({
                                        "error": e.to_string(),
                                    }),
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
    }.await;

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
pub fn update_provider_config(
    config: ProviderConfig,
    proxy_state: State<'_, ProxyState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let span_start = std::time::Instant::now();
    let span_data = serde_json::json!({
        "providerCount": config.providers.len(),
    });
    record_backend_perf_start(
        &app,
        "proxy",
        None,
        "proxy.update_provider_config",
        span_data.clone(),
    );
    let result = (|| -> Result<(), String> {
        let clients = build_client_map(&config)?;
        let mut s = proxy_state.0.lock().map_err(|e| e.to_string())?;
        s.config = config;
        s.clients = clients;
        Ok(())
    })();
    match result {
        Ok(()) => {
            record_backend_event(
                &app,
                "LOG",
                "proxy",
                None,
                "proxy.provider_config_updated",
                "Updated proxy provider config",
                serde_json::json!({}),
            );
            record_backend_perf_end(
                &app,
                "proxy",
                None,
                "proxy.update_provider_config",
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
                "proxy.update_provider_config",
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
pub fn bind_session_provider(
    session_id: String,
    provider_id: String,
    request_model: Option<String>,
    launch_model: Option<String>,
    proxy_state: State<'_, ProxyState>,
) -> Result<(), String> {
    let mut s = proxy_state.0.lock().map_err(|e| e.to_string())?;
    s.session_providers
        .insert(session_id.clone(), provider_id);
    match request_model.filter(|value| !value.is_empty()) {
        Some(model) => {
            s.session_requested_models.insert(session_id.clone(), model);
        }
        None => {
            s.session_requested_models.remove(&session_id);
        }
    }
    match launch_model.filter(|value| !value.is_empty()) {
        Some(model) => {
            s.session_launch_models.insert(session_id, model);
        }
        None => {
            s.session_launch_models.remove(&session_id);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn unbind_session_provider(
    session_id: String,
    proxy_state: State<'_, ProxyState>,
) -> Result<(), String> {
    let mut s = proxy_state.0.lock().map_err(|e| e.to_string())?;
    s.session_providers.remove(&session_id);
    s.session_requested_models.remove(&session_id);
    s.session_launch_models.remove(&session_id);
    Ok(())
}

// ── Codex auth commands ─────────────────────────────────────────────

#[tauri::command]
pub async fn codex_login(
    proxy_state: State<'_, ProxyState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let (auth_url, verifier, state) = codex::auth::build_auth_url();

    // Open browser for OAuth
    open::that(&auth_url).map_err(|e| format!("Failed to open browser: {e}"))?;

    // Wait for callback in background, then exchange code
    let app_clone = app.clone();
    let inner = proxy_state.0.clone();
    tokio::spawn(async move {
        match codex::auth::wait_for_callback(&state).await {
            Ok(code) => match codex::auth::exchange_code(&code, &verifier).await {
                Ok(tokens) => {
                    let email = tokens.email.clone();
                    if let Ok(s) = inner.lock() {
                        s.codex_auth.set_tokens(tokens);
                    }
                    let _ = app_clone.emit(
                        "codex-auth-changed",
                        serde_json::json!({
                            "loggedIn": true,
                            "email": email,
                        }),
                    );
                }
                Err(e) => {
                    let _ = app_clone.emit(
                        "codex-auth-changed",
                        serde_json::json!({
                            "loggedIn": false,
                            "error": e,
                        }),
                    );
                }
            },
            Err(e) => {
                let _ = app_clone.emit(
                    "codex-auth-changed",
                    serde_json::json!({
                        "loggedIn": false,
                        "error": e,
                    }),
                );
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn codex_logout(proxy_state: State<'_, ProxyState>) -> Result<(), String> {
    let s = proxy_state.0.lock().map_err(|e| e.to_string())?;
    s.codex_auth.clear();
    Ok(())
}

#[derive(serde::Serialize)]
pub struct CodexAuthStatus {
    pub logged_in: bool,
    pub email: Option<String>,
}

#[tauri::command]
pub fn codex_auth_status(proxy_state: State<'_, ProxyState>) -> Result<CodexAuthStatus, String> {
    let s = proxy_state.0.lock().map_err(|e| e.to_string())?;
    Ok(CodexAuthStatus {
        logged_in: s.codex_auth.is_logged_in(),
        email: s.codex_auth.get_email(),
    })
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

// ── Rule match counts ──────────────────────────────────────────────
// [CM-32] Per-session rule match counters: HashMap<ruleId, count>; incremented on each proxy match; get_rule_match_counts exposes it to frontend

#[tauri::command]
pub fn get_rule_match_counts(
    proxy_state: State<'_, ProxyState>,
) -> Result<HashMap<String, u64>, String> {
    let s = proxy_state.0.lock().map_err(|e| e.to_string())?;
    Ok(s.rule_match_counts.clone())
}

// ── Compression toggle ─────────────────────────────────────────────

#[tauri::command]
pub fn set_compression_enabled(
    enabled: bool,
    proxy_state: State<'_, ProxyState>,
) -> Result<(), String> {
    let mut s = proxy_state.0.lock().map_err(|e| e.to_string())?;
    s.compression_enabled = enabled;
    Ok(())
}

#[tauri::command]
pub fn get_compression_enabled(proxy_state: State<'_, ProxyState>) -> Result<bool, String> {
    let s = proxy_state.0.lock().map_err(|e| e.to_string())?;
    Ok(s.compression_enabled)
}

// ── Traffic logging commands ─────────────────────────────────────────

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

// cleanup_traffic_logs removed — unified cleanup via commands::cleanup_session_data

fn has_1m_suffix(model: &str) -> bool {
    model.to_ascii_lowercase().contains("[1m]")
}

fn claude_model_family(model: &str) -> Option<&'static str> {
    let lower = model.to_ascii_lowercase();
    if lower.contains("haiku") {
        Some("haiku")
    } else if lower.contains("sonnet") {
        Some("sonnet")
    } else if lower.contains("best") || lower.contains("opusplan") || lower.contains("opus") {
        Some("opus")
    } else {
        None
    }
}

fn matches_bound_launch_model(request_model: Option<&str>, launch_model: Option<&str>) -> bool {
    let (Some(request_model), Some(launch_model)) = (request_model, launch_model) else {
        return false;
    };

    if request_model.eq_ignore_ascii_case(launch_model) {
        return true;
    }

    let request_family = claude_model_family(request_model);
    let launch_family = claude_model_family(launch_model);
    request_family.is_some()
        && request_family == launch_family
        && has_1m_suffix(request_model) == has_1m_suffix(launch_model)
}

fn resolve_codex_upstream_request_model(
    session_id: Option<&str>,
    request_model: &Option<String>,
    launch_model: &Option<String>,
    session_requested_models: &HashMap<String, String>,
) -> Option<String> {
    let bound_requested_model = session_id.and_then(|sid| session_requested_models.get(sid));

    if request_model.is_none() {
        return bound_requested_model.cloned();
    }

    if matches_bound_launch_model(
        request_model.as_deref(),
        launch_model.as_deref(),
    ) {
        return bound_requested_model.cloned().or_else(|| request_model.clone());
    }

    request_model.clone()
}

// ── Connection handler ───────────────────────────────────────────────

async fn handle_connection(
    mut stream: tokio::net::TcpStream,
    config: ProviderConfig,
    clients: HashMap<String, reqwest::Client>,
    default_client: reqwest::Client,
    rules: Vec<SystemPromptRule>,
    session_providers: HashMap<String, String>,
    session_requested_models: HashMap<String, String>,
    session_launch_models: HashMap<String, String>,
    compression_enabled: bool,
    app: tauri::AppHandle,
    proxy_state: Arc<Mutex<ProxyInner>>,
) -> Result<(), Box<dyn std::error::Error>> {
    // Read full request
    let mut buf: Vec<u8> = Vec::new();
    let mut tmp = [0u8; 65536];

    loop {
        let n = tokio::time::timeout(std::time::Duration::from_secs(30), stream.read(&mut tmp))
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
        proxy_state
            .lock()
            .ok()
            .map_or(false, |s| s.traffic_log_files.contains_key(id))
    });

    // Route: look up session's provider, then apply its model mappings
    let model = extract_model(&body);
    let provider = resolve_session_provider(session_id.as_deref(), &session_providers, &config);
    let bound_launch_model = session_id
        .as_deref()
        .and_then(|sid| session_launch_models.get(sid).cloned());
    // [PR-10] OpenAI Codex sessions keep a client-visible Claude carrier model
    // for Claude Code while routing upstream with the original requested model.
    let upstream_request_model = if provider.kind == "openai_codex" {
        resolve_codex_upstream_request_model(
            session_id.as_deref(),
            &model,
            &bound_launch_model,
            &session_requested_models,
        )
    } else {
        model.clone()
    };

    let rewrite = upstream_request_model
        .as_deref()
        .and_then(|m| apply_model_mappings(m, &provider.model_mappings));
    let mut final_body = if provider.kind == "openai_codex" {
        body.to_vec()
    } else {
        match rewrite.as_deref() {
            Some(new_model) => rewrite_model_in_body(&body, new_model),
            None => body.to_vec(),
        }
    };
    if !rules.is_empty() {
        let (rewritten, matched_ids) = rewrite_system_prompt_in_body(&final_body, &rules);
        final_body = rewritten;
        if !matched_ids.is_empty() {
            if let Ok(mut s) = proxy_state.lock() {
                for id in &matched_ids {
                    *s.rule_match_counts.entry(id.clone()).or_insert(0) += 1;
                }
            }
        }
    }
    // Compress tool_result content (after system prompt rules, before forwarding)
    let compression_stats = if compression_enabled && provider.kind != "openai_codex" {
        let (compressed, stats) = compress::compress_tool_results_in_body(&final_body);
        final_body = compressed;
        stats
    } else {
        compress::CompressionStats::default()
    };
    let route_event_data = serde_json::json!({
        "method": method,
        "rawPath": raw_path,
        "path": path,
        "sessionScoped": session_id.is_some(),
        "requestModel": model,
        "boundLaunchModel": bound_launch_model,
        "upstreamRequestModel": upstream_request_model,
        "providerId": provider.id,
        "provider": provider.name,
        "providerKind": provider.kind,
        "rewrite": rewrite,
        "systemPromptRulesApplied": !rules.is_empty(),
        "shouldLogTraffic": should_log,
        "compression": {
            "toolResultsFound": compression_stats.tool_results_found,
            "toolResultsCompressed": compression_stats.tool_results_compressed,
            "originalBytes": compression_stats.original_bytes,
            "compressedBytes": compression_stats.compressed_bytes,
            "savedBytes": compression_stats.saved_bytes(),
            "savedPct": (compression_stats.saved_pct() * 10.0).round() / 10.0,
        },
    });
    let route_traffic_meta = serde_json::json!({
        "route": route_event_data.clone(),
    });

    record_backend_event(
        &app,
        "DEBUG",
        "proxy",
        session_id.as_deref(),
        "proxy.route_resolved",
        "Resolved proxy route",
        route_event_data,
    );

    // Emit routing event for debug panel visibility
    let _ = app.emit(
        "proxy-route",
        serde_json::json!({
            "model": upstream_request_model.as_deref().or(model.as_deref()).unwrap_or("(none)"),
            "clientModel": model.as_deref().unwrap_or("(none)"),
            "provider": provider.name,
            "rewrite": rewrite,
            "path": path,
        }),
    );

    // Dispatch by provider kind
    if provider.kind == "openai_codex" {
        return codex::handle_request(
            &mut stream,
            &method,
            &path,
            &headers,
            &final_body,
            provider,
            &proxy_state,
            session_id.as_deref(),
            &app,
            should_log,
            &model,
            &upstream_request_model,
            &rewrite,
            compression_enabled,
        )
        .await;
    }

    // ── Anthropic-compatible provider: passthrough with model rewrite ──

    // Build upstream URL
    let base_url = provider
        .base_url
        .as_deref()
        .unwrap_or("https://api.anthropic.com");
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);

    // Build upstream request
    let client = clients.get(&provider.id).unwrap_or(&default_client);
    let http_method =
        reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::POST);
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
    let log_model = model.clone();
    let log_provider = provider.name.clone();
    let log_rewrite = rewrite.clone();
    let log_method = method.clone();
    let log_path = path.clone();
    let log_session_id = session_id.clone();
    let route_span_data = serde_json::json!({
        "method": log_method,
        "path": log_path,
        "model": log_model,
        "provider": log_provider,
        "rewrite": log_rewrite,
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

    // Send upstream request
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
                    &log_provider,
                    &log_rewrite,
                    &final_body_for_log,
                    502,
                    b"",
                    Some(route_traffic_meta.clone()),
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
                    "model": log_model,
                    "provider": log_provider,
                    "rewrite": log_rewrite,
                    "error": error_message,
                }),
            );
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
    let mut resp_buf: Option<Vec<u8>> = if should_log {
        Some(Vec::with_capacity(8192))
    } else {
        None
    };
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
            &proxy_state,
            &log_session_id,
            req_ts,
            req_start,
            &log_method,
            &log_path,
            &log_model,
            &log_provider,
            &log_rewrite,
            &final_body_for_log,
            status_code,
            &resp_bytes,
            Some(route_traffic_meta.clone()),
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
        serde_json::json!({
            "status": status_code,
        }),
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
            "model": log_model,
            "provider": log_provider,
            "rewrite": log_rewrite,
            "status": status_code,
        }),
    );

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

fn build_traffic_entry_json(
    req_ts: f64,
    dur_ms: u64,
    sid: &str,
    method: &str,
    path: &str,
    model: &Option<String>,
    provider: &str,
    rewrite: &Option<String>,
    req_body: &Option<Vec<u8>>,
    status: u16,
    resp_bytes: &[u8],
    extra_meta: Option<Value>,
) -> Value {
    let req_str = req_body
        .as_ref()
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .unwrap_or_default();
    let resp_str = decompress_if_gzip(resp_bytes);
    let req_len = req_body.as_ref().map(|b| b.len()).unwrap_or(0);

    let mut entry = serde_json::json!({
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

    if let Some(extra_meta) = extra_meta {
        if let Some(entry_obj) = entry.as_object_mut() {
            match extra_meta {
                serde_json::Value::Object(extra_obj) => {
                    entry_obj.extend(extra_obj);
                }
                other => {
                    entry_obj.insert("meta".to_string(), other);
                }
            }
        }
    }

    entry
}

pub(crate) fn write_traffic_entry(
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
    extra_meta: Option<Value>,
) {
    let sid = match session_id {
        Some(id) => id,
        None => return,
    };
    let dur_ms = req_start.elapsed().as_millis() as u64;
    let line = build_traffic_entry_json(
        req_ts, dur_ms, sid, method, path, model, provider, rewrite, req_body, status, resp_bytes,
        extra_meta,
    );

    if let Ok(mut s) = proxy_state.lock() {
        if let Some(ref mut writer) = s.traffic_log_files.get_mut(sid) {
            use std::io::Write;
            let _ = writeln!(writer, "{}", line);
            let _ = writer.flush();
        }
    }
}

// ── Routing ─────────────────────────────────────────────────────────

/// [PR-01] Resolve /s/{sessionId} traffic through the bound provider first,
/// then fall back to the default provider.
fn resolve_session_provider<'a>(
    session_id: Option<&str>,
    session_providers: &HashMap<String, String>,
    config: &'a ProviderConfig,
) -> &'a ModelProvider {
    let default_provider = config
        .providers
        .iter()
        .find(|p| p.id == config.default_provider_id)
        .or_else(|| config.providers.first());

    if let Some(sid) = session_id {
        if let Some(pid) = session_providers.get(sid) {
            if let Some(provider) = config.providers.iter().find(|p| &p.id == pid) {
                return provider;
            }
        }
    }

    default_provider.unwrap_or(&FALLBACK_PROVIDER)
}

/// Match model against a provider's model mappings. Returns the rewrite model if matched.
fn apply_model_mappings(model: &str, mappings: &[ModelMapping]) -> Option<String> {
    for mapping in mappings {
        if glob_match::glob_match(&mapping.pattern, model) {
            return mapping.rewrite_model.clone();
        }
    }
    None
}

static FALLBACK_PROVIDER: ModelProvider = ModelProvider {
    id: String::new(),
    name: String::new(),
    kind: String::new(),
    predefined: false,
    model_mappings: Vec::new(),
    known_models: Vec::new(),

    base_url: None,
    api_key: None,
    socks5_proxy: None,
    codex_primary_model: None,
    codex_small_model: None,
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

fn rewrite_system_prompt_in_body(body: &[u8], rules: &[SystemPromptRule]) -> (Vec<u8>, Vec<String>) {
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

    fn make_provider(
        id: &str,
        name: &str,
        base_url: &str,
        api_key: Option<&str>,
        socks5: Option<&str>,
    ) -> ModelProvider {
        ModelProvider {
            id: id.into(),
            name: name.into(),
            kind: "anthropic_compatible".into(),
            predefined: false,
            model_mappings: Vec::new(),
            known_models: Vec::new(),

            base_url: Some(base_url.into()),
            api_key: api_key.map(|s| s.into()),
            socks5_proxy: socks5.map(|s| s.into()),
            codex_primary_model: None,
            codex_small_model: None,
        }
    }

    // ── Session-provider resolution tests ────────────────────────────

    #[test]
    fn test_resolve_session_provider_default() {
        let config = ProviderConfig::default();
        let sp = HashMap::new();
        let provider = resolve_session_provider(Some("sess-1"), &sp, &config);
        assert_eq!(provider.id, "anthropic");
    }

    #[test]
    fn test_resolve_session_provider_bound() {
        let config = ProviderConfig {
            providers: vec![
                make_provider(
                    "glm",
                    "GLM",
                    "https://api.z.ai/api/anthropic",
                    Some("k"),
                    None,
                ),
                make_provider(
                    "anthropic",
                    "Anthropic",
                    "https://api.anthropic.com",
                    None,
                    None,
                ),
            ],
            default_provider_id: "anthropic".into(),
        };
        let mut sp = HashMap::new();
        sp.insert("sess-1".to_string(), "glm".to_string());
        let provider = resolve_session_provider(Some("sess-1"), &sp, &config);
        assert_eq!(provider.id, "glm");
        // Unbound session falls back to default
        let provider = resolve_session_provider(Some("sess-2"), &sp, &config);
        assert_eq!(provider.id, "anthropic");
    }

    #[test]
    fn test_resolve_session_provider_no_session() {
        let config = ProviderConfig::default();
        let sp = HashMap::new();
        let provider = resolve_session_provider(None, &sp, &config);
        assert_eq!(provider.id, "anthropic");
    }

    #[test]
    fn test_resolve_session_provider_missing_provider_fallback() {
        let config = ProviderConfig {
            providers: vec![make_provider(
                "anthropic",
                "Anthropic",
                "https://api.anthropic.com",
                None,
                None,
            )],
            default_provider_id: "anthropic".into(),
        };
        let mut sp = HashMap::new();
        sp.insert("sess-1".to_string(), "nonexistent".to_string());
        // Bound to nonexistent provider -> falls back to default
        let provider = resolve_session_provider(Some("sess-1"), &sp, &config);
        assert_eq!(provider.id, "anthropic");
    }

    #[test]
    fn test_resolve_codex_upstream_request_model_uses_bound_requested_model_for_launch_carrier() {
        let mut requested = HashMap::new();
        requested.insert("sess-1".to_string(), "gpt-5.4".to_string());

        let resolved = resolve_codex_upstream_request_model(
            Some("sess-1"),
            &Some("claude-opus-4-6[1m]".into()),
            &Some("opus[1m]".into()),
            &requested,
        );

        assert_eq!(resolved, Some("gpt-5.4".into()));
    }

    #[test]
    fn test_resolve_codex_upstream_request_model_honors_live_model_switches() {
        let mut requested = HashMap::new();
        requested.insert("sess-1".to_string(), "gpt-5.4".to_string());

        let resolved = resolve_codex_upstream_request_model(
            Some("sess-1"),
            &Some("claude-haiku-4-5".into()),
            &Some("opus[1m]".into()),
            &requested,
        );

        assert_eq!(resolved, Some("claude-haiku-4-5".into()));
    }

    // ── Model mapping tests ─────────────────────────────────────────

    #[test]
    fn test_apply_model_mappings_match() {
        let mappings = vec![
            ModelMapping {
                id: "m1".into(),
                pattern: "claude-haiku-*".into(),
                rewrite_model: Some("glm-5.0".into()),
                context_window: None,
            },
            ModelMapping {
                id: "m2".into(),
                pattern: "*".into(),
                rewrite_model: None,
                context_window: None,
            },
        ];
        assert_eq!(
            apply_model_mappings("claude-haiku-4-5", &mappings),
            Some("glm-5.0".into())
        );
    }

    #[test]
    fn test_apply_model_mappings_no_rewrite() {
        let mappings = vec![ModelMapping {
            id: "m1".into(),
            pattern: "*".into(),
            rewrite_model: None,
            context_window: None,
        }];
        assert_eq!(apply_model_mappings("claude-opus-4-6", &mappings), None);
    }

    #[test]
    fn test_apply_model_mappings_first_match_wins() {
        let mappings = vec![
            ModelMapping {
                id: "m1".into(),
                pattern: "claude-*".into(),
                rewrite_model: Some("a".into()),
                context_window: None,
            },
            ModelMapping {
                id: "m2".into(),
                pattern: "claude-haiku-*".into(),
                rewrite_model: Some("b".into()),
                context_window: None,
            },
        ];
        // "claude-*" matches first, even though "claude-haiku-*" is more specific
        assert_eq!(
            apply_model_mappings("claude-haiku-4-5", &mappings),
            Some("a".into())
        );
    }

    #[test]
    fn test_apply_model_mappings_no_match() {
        let mappings = vec![ModelMapping {
            id: "m1".into(),
            pattern: "glm-*".into(),
            rewrite_model: Some("x".into()),
            context_window: None,
        }];
        assert_eq!(apply_model_mappings("claude-opus-4-6", &mappings), None);
    }

    #[test]
    fn test_apply_model_mappings_empty() {
        assert_eq!(apply_model_mappings("anything", &[]), None);
    }

    // ── Model rewrite tests ─────────────────────────────────────────

    #[test]
    fn test_rewrite_model() {
        let body = br#"{"model":"claude-haiku-4-5-20251001","messages":[]}"#;
        let rewritten = rewrite_model_in_body(body, "glm-5.0");
        let json: serde_json::Value = serde_json::from_slice(&rewritten).unwrap();
        assert_eq!(json["model"], "glm-5.0");
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

    #[test]
    fn test_build_traffic_entry_includes_extra_metadata() {
        let entry = build_traffic_entry_json(
            123.0,
            45,
            "sess-1",
            "POST",
            "/v1/messages",
            &Some("claude-opus-4-6".into()),
            "Codex",
            &Some("gpt-5.4".into()),
            &Some(br#"{"model":"claude-opus-4-6"}"#.to_vec()),
            200,
            br#"{"type":"message"}"#,
            Some(serde_json::json!({
                "route": {
                    "providerId": "openai-codex",
                    "providerKind": "openai_codex",
                },
                "translation": {
                    "proxy": "codex",
                    "upstreamMode": "streaming",
                    "summary": {
                        "upstreamToolCallCount": 3,
                    },
                },
            })),
        );

        assert_eq!(entry["route"]["providerId"], "openai-codex");
        assert_eq!(entry["translation"]["upstreamMode"], "streaming");
        assert_eq!(entry["translation"]["summary"]["upstreamToolCallCount"], 3);
        assert_eq!(entry["rewrite"], "gpt-5.4");
    }

    // ── SOCKS5 client builder tests ──────────────────────────────────

    #[test]
    fn test_build_client_map_no_proxy() {
        let config = ProviderConfig::default();
        let clients = build_client_map(&config).unwrap();
        assert!(
            clients.is_empty(),
            "no providers have socks5_proxy, map should be empty"
        );
    }

    #[test]
    fn test_build_client_map_with_proxy() {
        let config = ProviderConfig {
            providers: vec![
                make_provider(
                    "proxied",
                    "Proxied",
                    "https://api.example.com",
                    None,
                    Some("socks5h://user:pass@127.0.0.1:1080"),
                ),
                make_provider("direct", "Direct", "https://api.anthropic.com", None, None),
            ],
            default_provider_id: "direct".into(),
        };
        let clients = build_client_map(&config).unwrap();
        assert_eq!(clients.len(), 1, "only proxied provider should be in map");
        assert!(
            clients.contains_key("proxied"),
            "proxied provider should have a client"
        );
        assert!(
            !clients.contains_key("direct"),
            "direct provider should not be in map"
        );
    }

    #[test]
    fn test_build_client_map_invalid_proxy_url() {
        let config = ProviderConfig {
            providers: vec![make_provider(
                "bad",
                "Bad",
                "https://api.example.com",
                None,
                Some("not a valid url!!!"),
            )],
            default_provider_id: "bad".into(),
        };
        let result = build_client_map(&config);
        assert!(result.is_err(), "invalid proxy URL should return Err");
    }

    // ── System prompt rewrite tests ──────────────────────────────────────

    fn make_rule(
        name: &str,
        pattern: &str,
        replacement: &str,
        flags: &str,
        enabled: bool,
    ) -> SystemPromptRule {
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
        let (result, _matched) = rewrite_system_prompt_in_body(body.as_bytes(), &rules);
        let json: serde_json::Value = serde_json::from_slice(&result).unwrap();
        assert_eq!(json["system"], "You are Assistant, a helpful assistant.");
        assert_eq!(json["model"], "claude-opus-4-6");
    }

    #[test]
    fn test_rewrite_system_prompt_array() {
        let body = r#"{"model":"test","system":[{"type":"text","text":"You are Claude."},{"type":"text","text":"Be helpful."}],"messages":[]}"#;
        let rules = vec![make_rule("rename", "Claude", "Assistant", "g", true)];
        let (result, _matched) = rewrite_system_prompt_in_body(body.as_bytes(), &rules);
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
        let (result, _matched) = rewrite_system_prompt_in_body(body.as_bytes(), &rules);
        let json: serde_json::Value = serde_json::from_slice(&result).unwrap();
        assert_eq!(json["system"], "Hi earth");
    }

    #[test]
    fn test_rewrite_system_prompt_disabled_rule_skipped() {
        let body = r#"{"system":"Hello Claude","messages":[]}"#;
        let rules = vec![make_rule("off", "Claude", "Assistant", "g", false)];
        let (result, _matched) = rewrite_system_prompt_in_body(body.as_bytes(), &rules);
        let json: serde_json::Value = serde_json::from_slice(&result).unwrap();
        assert_eq!(json["system"], "Hello Claude");
    }

    #[test]
    fn test_rewrite_system_prompt_empty_rules() {
        let body = r#"{"system":"Hello","messages":[]}"#;
        let (result, _matched) = rewrite_system_prompt_in_body(body.as_bytes(), &[]);
        assert_eq!(result, body.as_bytes());
    }

    #[test]
    fn test_rewrite_system_prompt_no_system_field() {
        let body = r#"{"model":"test","messages":[]}"#;
        let rules = vec![make_rule("r", "x", "y", "g", true)];
        let (result, _matched) = rewrite_system_prompt_in_body(body.as_bytes(), &rules);
        let json: serde_json::Value = serde_json::from_slice(&result).unwrap();
        assert!(json.get("system").is_none());
        assert_eq!(json["model"], "test");
    }

    #[test]
    fn test_rewrite_system_prompt_invalid_json() {
        let body = b"not json";
        let rules = vec![make_rule("r", "x", "y", "g", true)];
        let (result, _matched) = rewrite_system_prompt_in_body(body, &rules);
        assert_eq!(result, body);
    }

    #[test]
    fn test_rewrite_system_prompt_case_insensitive() {
        let body = r#"{"system":"CLAUDE claude Claude","messages":[]}"#;
        let rules = vec![make_rule("ci", "claude", "Assistant", "gi", true)];
        let (result, _matched) = rewrite_system_prompt_in_body(body.as_bytes(), &rules);
        let json: serde_json::Value = serde_json::from_slice(&result).unwrap();
        assert_eq!(json["system"], "Assistant Assistant Assistant");
    }

    #[test]
    fn test_rewrite_system_prompt_capture_groups() {
        let body = r#"{"system":"Use (tools) wisely","messages":[]}"#;
        let rules = vec![make_rule("cg", r#"\((\w+)\)"#, "[$1]", "g", true)];
        let (result, _matched) = rewrite_system_prompt_in_body(body.as_bytes(), &rules);
        let json: serde_json::Value = serde_json::from_slice(&result).unwrap();
        assert_eq!(json["system"], "Use [tools] wisely");
    }

    #[test]
    fn test_rewrite_system_prompt_empty_pattern_skipped() {
        let body = r#"{"system":"Hello","messages":[]}"#;
        let rules = vec![make_rule("empty", "", "x", "g", true)];
        let (result, _matched) = rewrite_system_prompt_in_body(body.as_bytes(), &rules);
        let json: serde_json::Value = serde_json::from_slice(&result).unwrap();
        assert_eq!(json["system"], "Hello");
    }

    #[test]
    fn test_rewrite_system_prompt_reports_matched_ids() {
        let body = r#"{"system":"Hello world","messages":[]}"#;
        let rules = vec![
            make_rule("hit", "Hello", "Hi", "g", true),
            make_rule("miss", "nope", "x", "g", true),
            make_rule("hit2", "world", "earth", "g", true),
        ];
        let (_result, matched) = rewrite_system_prompt_in_body(body.as_bytes(), &rules);
        assert_eq!(matched, vec!["rule-hit".to_string(), "rule-hit2".to_string()]);
    }

    #[test]
    fn test_rewrite_system_prompt_matched_ids_deduped_across_array() {
        let body = r#"{"system":[{"type":"text","text":"Hello Claude"},{"type":"text","text":"Goodbye Claude"}],"messages":[]}"#;
        let rules = vec![make_rule("r", "Claude", "Assistant", "g", true)];
        let (_result, matched) = rewrite_system_prompt_in_body(body.as_bytes(), &rules);
        assert_eq!(matched, vec!["rule-r".to_string()]);
    }
}

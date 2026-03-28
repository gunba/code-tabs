use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use tauri::{Emitter, State};

use crate::session::types::{ModelProvider, ModelRoute, ProviderConfig};

// ── Proxy state ──────────────────────────────────────────────────────

pub struct ProxyInner {
    pub config: ProviderConfig,
    pub port: Option<u16>,
    pub shutdown_tx: Option<oneshot::Sender<()>>,
    pub client: Option<reqwest::Client>,
}

pub struct ProxyState(pub Arc<Mutex<ProxyInner>>);

impl ProxyState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(ProxyInner {
            config: ProviderConfig::default(),
            port: None,
            shutdown_tx: None,
            client: None,
        })))
    }
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

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("Client build failed: {e}"))?;

    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();

    {
        let mut s = inner.lock().map_err(|e| e.to_string())?;
        s.config = config;
        s.port = Some(port);
        s.shutdown_tx = Some(shutdown_tx);
        s.client = Some(client.clone());
    }

    let state = inner.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                result = listener.accept() => {
                    match result {
                        Ok((stream, _)) => {
                            let config = match state.lock() {
                                Ok(s) => s.config.clone(),
                                Err(_) => continue,
                            };
                            let c = client.clone();
                            let a = app.clone();
                            tokio::spawn(async move {
                                if let Err(e) = handle_connection(stream, config, c, a).await {
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
    s.client = None;
    Ok(())
}

#[tauri::command]
pub fn update_provider_config(
    config: ProviderConfig,
    proxy_state: State<'_, ProxyState>,
) -> Result<(), String> {
    let mut s = proxy_state.0.lock().map_err(|e| e.to_string())?;
    s.config = config;
    Ok(())
}

#[tauri::command]
pub fn get_proxy_port(proxy_state: State<'_, ProxyState>) -> Result<Option<u16>, String> {
    let s = proxy_state.0.lock().map_err(|e| e.to_string())?;
    Ok(s.port)
}

// ── Connection handler ───────────────────────────────────────────────

async fn handle_connection(
    mut stream: tokio::net::TcpStream,
    config: ProviderConfig,
    client: reqwest::Client,
    app: tauri::AppHandle,
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

    let (method, path, headers, body) = match parse_request(&buf) {
        Some(r) => r,
        None => {
            send_error(&mut stream, 400, "Bad request").await;
            return Ok(());
        }
    };

    // Route: extract model, find matching route + provider, rewrite if needed
    let model = extract_model(&body);
    let (route, provider) = route_request(model.as_deref(), &config);

    let rewrite = route.and_then(|r| r.rewrite_model.as_deref());
    let final_body = match rewrite {
        Some(new_model) => rewrite_model_in_body(&body, new_model),
        None => body.to_vec(),
    };

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
    req = req.body(final_body);

    // Send upstream request
    let mut resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
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
    while let Some(chunk) = resp.chunk().await? {
        stream.write_all(&chunk).await?;
        stream.flush().await?;
    }

    Ok(())
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

// ── Helpers ──────────────────────────────────────────────────────────

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
                },
                ModelProvider {
                    id: "anthropic".into(),
                    name: "Anthropic".into(),
                    base_url: "https://api.anthropic.com".into(),
                    api_key: None,
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
                },
                ModelProvider {
                    id: "anthropic".into(),
                    name: "Anthropic".into(),
                    base_url: "https://api.anthropic.com".into(),
                    api_key: None,
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
                },
                ModelProvider {
                    id: "b".into(),
                    name: "B".into(),
                    base_url: "http://b".into(),
                    api_key: None,
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
}

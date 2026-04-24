pub mod auth;
pub mod response_shape;
pub mod stream;
pub mod translate_req;
pub mod translate_resp;
pub mod types;

use crate::observability::{
    record_backend_event, record_backend_perf_end, record_backend_perf_fail,
    record_backend_perf_start,
};
use crate::session::types::ModelProvider;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use tokio::io::AsyncWriteExt;

const CODEX_API_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_CLI_ORIGINATOR: &str = "codex_cli_rs";

/// [PR-06] Codex upstream requests send CLI-style identity headers so
/// OpenAI usage/reporting can classify interactive Claude Tabs traffic
/// consistently instead of falling back to generic client buckets.
fn codex_identity_headers(session_id: Option<&str>) -> Vec<(&'static str, String)> {
    let version = env!("CARGO_PKG_VERSION");
    let mut headers = vec![
        ("originator", CODEX_CLI_ORIGINATOR.to_string()),
        (
            "user-agent",
            format!(
                "{CODEX_CLI_ORIGINATOR}/{version} ({} {}; claude-tabs/{version})",
                std::env::consts::OS,
                std::env::consts::ARCH,
            ),
        ),
    ];
    if let Some(id) = session_id.filter(|value| !value.is_empty()) {
        headers.push(("session_id", id.to_string()));
        headers.push(("x-client-request-id", id.to_string()));
    }
    headers
}

/// [PR-04] Short Claude aliases resolve to the configured primary or small
/// OpenAI Codex model before the upstream request is built.
/// Resolve the Codex model name from the request model and provider config.
fn resolve_codex_model(model: Option<&str>, provider: &ModelProvider) -> String {
    let primary = provider.codex_primary_model.as_deref().unwrap_or("gpt-5.5");
    let small = provider
        .codex_small_model
        .as_deref()
        .unwrap_or("gpt-5.5-mini");

    let model = match model {
        Some(m) => m,
        None => return primary.to_string(),
    };

    // Strip [1m] context suffix and ANSI formatting codes
    let cleaned = model.to_lowercase().replace("[1m]", "").trim().to_string();
    // Strip remaining ANSI bracket codes (e.g., bold markers from subagents)
    let cleaned: String = {
        let mut s = cleaned;
        while let Some(start) = s.find('[') {
            if let Some(end) = s[start..].find(']') {
                s = format!("{}{}", &s[..start], &s[start + end + 1..]);
            } else {
                break;
            }
        }
        s
    };

    if cleaned.contains("haiku") {
        return small.to_string();
    }
    if cleaned.contains("best")
        || cleaned.contains("opusplan")
        || cleaned.contains("sonnet")
        || cleaned.contains("opus")
        || cleaned.starts_with("claude")
    {
        return primary.to_string();
    }

    // Not a Claude model — could be a Codex model name already, pass through
    model.to_string()
}

/// [PR-02] Translate Anthropic-style requests and streaming responses
/// through the OpenAI Responses API for the OpenAI Codex provider.
const DEFAULT_CODEX_CONTEXT_WINDOW: u64 = 272_000;
const DEFAULT_CODEX_MAX_OUTPUT: u64 = 128_000;

fn synthetic_codex_context_window(provider: &ModelProvider) -> u64 {
    provider
        .known_models
        .iter()
        .filter_map(|model| model.context_window)
        .max()
        .or_else(|| {
            provider
                .model_mappings
                .iter()
                .filter_map(|mapping| mapping.context_window)
                .max()
        })
        .unwrap_or(DEFAULT_CODEX_CONTEXT_WINDOW)
}

fn push_synthetic_model(
    models: &mut Vec<Value>,
    seen_ids: &mut HashSet<String>,
    id: &str,
    display_name: &str,
    context_window: u64,
) {
    if id.is_empty() || !seen_ids.insert(id.to_string()) {
        return;
    }

    models.push(serde_json::json!({
        "id": id,
        "type": "model",
        "display_name": display_name,
        "created_at": "2025-01-01T00:00:00Z",
        "max_input_tokens": context_window,
        "max_tokens": context_window.min(DEFAULT_CODEX_MAX_OUTPUT),
    }));
}

/// [PR-12] Synthetic Codex `/v1/models` metadata derives from provider
/// catalog state so future model additions inherit context data without
/// hardcoded GPT-family assumptions in the proxy.
/// Build a synthetic Anthropic `/v1/models` response for the Codex provider.
fn build_synthetic_models_response(provider: &ModelProvider) -> Vec<u8> {
    let primary = provider.codex_primary_model.as_deref().unwrap_or("gpt-5.5");
    let small = provider
        .codex_small_model
        .as_deref()
        .unwrap_or("gpt-5.5-mini");
    let default_context_window = synthetic_codex_context_window(provider);
    let mut data = Vec::new();
    let mut seen_ids = HashSet::new();

    for model in &provider.known_models {
        push_synthetic_model(
            &mut data,
            &mut seen_ids,
            &model.id,
            &model.label,
            model.context_window.unwrap_or(default_context_window),
        );
    }

    // Ensure primary and small always appear (deduped by seen_ids).
    push_synthetic_model(
        &mut data,
        &mut seen_ids,
        primary,
        primary,
        default_context_window,
    );
    push_synthetic_model(
        &mut data,
        &mut seen_ids,
        small,
        small,
        default_context_window,
    );

    let first_id = data
        .first()
        .and_then(|entry| entry.get("id"))
        .and_then(|value| value.as_str())
        .unwrap_or(primary);
    let last_id = data
        .last()
        .and_then(|entry| entry.get("id"))
        .and_then(|value| value.as_str())
        .unwrap_or(first_id);

    let models = serde_json::json!({
        "data": data,
        "has_more": false,
        "first_id": first_id,
        "last_id": last_id,
    });
    serde_json::to_vec(&models).unwrap_or_default()
}

/// [PR-05] Traffic logs persist the translated upstream OpenAI request payload
/// so proxy rewrites can be compared against the raw Anthropic request body.
fn codex_traffic_meta(
    provider: &ModelProvider,
    session_scoped: bool,
    client_model: &Option<String>,
    upstream_request_model: &Option<String>,
    rewrite: &Option<String>,
    codex_model: &str,
    upstream_mode: &str,
    translated_request_body: &[u8],
    translated_request_len: usize,
    summary: Option<&response_shape::ResponseTranslationSummary>,
) -> Value {
    let mut translation = json!({
        "proxy": "codex",
        "upstreamMode": upstream_mode,
        "clientModel": client_model,
        "upstreamRequestModel": upstream_request_model,
        "resolvedCodexModel": codex_model,
        "translatedRequestLen": translated_request_len,
        "translatedRequest": serde_json::from_slice::<Value>(translated_request_body)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(translated_request_body).into_owned())),
    });
    if let Some(summary) = summary {
        if let Some(obj) = translation.as_object_mut() {
            obj.insert(
                "summary".to_string(),
                serde_json::to_value(summary).unwrap_or_else(|_| json!({})),
            );
        }
    }

    json!({
        "route": {
            "sessionScoped": session_scoped,
            "providerId": provider.id,
            "provider": provider.name,
            "providerKind": provider.kind,
            "clientModel": client_model,
            "upstreamRequestModel": upstream_request_model,
            "rewrite": rewrite,
            "resolvedCodexModel": codex_model,
        },
        "translation": translation,
    })
}

pub async fn handle_request(
    tcp_stream: &mut tokio::net::TcpStream,
    method: &str,
    path: &str,
    _headers: &[(String, String)],
    body: &[u8],
    provider: &ModelProvider,
    proxy_state: &Arc<Mutex<super::ProxyInner>>,
    session_id: Option<&str>,
    app: &tauri::AppHandle,
    should_log: bool,
    client_model: &Option<String>,
    upstream_request_model: &Option<String>,
    rewrite: &Option<String>,
    compression_enabled: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    // Intercept model listing — return synthetic metadata with correct context windows
    if method == "GET"
        && (path == "/v1/models"
            || path.starts_with("/v1/models?")
            || path.starts_with("/v1/models/"))
    {
        let body = build_synthetic_models_response(provider);
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body.len(),
        );
        tcp_stream.write_all(resp.as_bytes()).await?;
        tcp_stream.write_all(&body).await?;
        tcp_stream.flush().await?;
        record_backend_event(
            app,
            "DEBUG",
            "proxy",
            session_id,
            "codex.synthetic_models",
            "Served synthetic model metadata",
            serde_json::json!({}),
        );
        return Ok(());
    }

    let span_start = std::time::Instant::now();
    let session_id_owned = session_id.map(|s| s.to_string());
    let req_ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();
    let req_body_for_log = if should_log {
        Some(body.to_vec())
    } else {
        None
    };

    // Get client from persistent state
    let codex_client = {
        let s = proxy_state.lock().map_err(|e| e.to_string())?;
        s.codex_client.clone()
    };

    // Get access token from persistent state, refreshing if needed.
    let codex_auth = {
        let s = proxy_state.lock().map_err(|e| e.to_string())?;
        s.codex_auth.clone()
    };
    let access_token = match codex_auth.get_access_token().await {
        Ok(token) => token,
        Err(err) => {
            record_backend_event(
                app,
                "WARN",
                "proxy",
                session_id,
                "codex.auth_failed",
                &format!("Codex auth failed: {err}"),
                serde_json::json!({}),
            );
            send_error(tcp_stream, 401, &format!("Codex auth failed: {err}")).await;
            return Ok(());
        }
    };

    // [PR-14] Claude Code periodically pings /v1/messages with a minimal
    // {max_tokens:1, messages:[{role:"user", content:"quota"}]} body to verify
    // auth/quota is live. Auth is already verified above, so short-circuit a
    // canned 200 without hitting upstream (the Codex backend would 400 on the
    // missing `instructions` field and it wastes tokens regardless).
    if is_quota_probe(body) {
        let probe_streaming = serde_json::from_slice::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v.get("stream").and_then(|s| s.as_bool()))
            .unwrap_or(true);
        let probe_model = client_model
            .clone()
            .or_else(|| extract_model_from_body(body))
            .unwrap_or_else(|| "claude-opus-4-6".to_string());
        record_backend_event(
            app,
            "DEBUG",
            "proxy",
            session_id,
            "codex.quota_probe",
            "Short-circuited Claude Code quota probe",
            serde_json::json!({ "streaming": probe_streaming, "model": probe_model }),
        );
        let _ = send_quota_probe_response(tcp_stream, probe_streaming, &probe_model).await;
        return Ok(());
    }

    // Extract model from request and resolve to Codex model
    let req_model = client_model
        .clone()
        .or_else(|| extract_model_from_body(body));
    let routed_model = upstream_request_model.clone().or_else(|| req_model.clone());
    let codex_model = resolve_codex_model(routed_model.as_deref(), provider);

    record_backend_event(
        app,
        "DEBUG",
        "proxy",
        session_id,
        "codex.translate_request",
        &format!(
            "Codex: {} -> {}",
            routed_model.as_deref().unwrap_or("(none)"),
            codex_model
        ),
        serde_json::json!({
            "clientModel": req_model,
            "upstreamRequestModel": routed_model,
            "codexModel": codex_model,
        }),
    );

    // Translate request
    let codex_body = match translate_req::translate_request(body, &codex_model, compression_enabled) {
        Ok(b) => b,
        Err(e) => {
            record_backend_event(
                app,
                "ERR",
                "proxy",
                session_id,
                "codex.translate_request_failed",
                &format!("Translation failed: {e}"),
                serde_json::json!({}),
            );
            send_error(tcp_stream, 400, &format!("Request translation failed: {e}")).await;
            return Ok(());
        }
    };
    // [PR-05] Preserve the translated request body only when traffic logging is
    // enabled so observability shows both the raw and rewritten payloads.
    let codex_body_for_log = if should_log {
        Some(codex_body.clone())
    } else {
        None
    };

    let is_streaming = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("stream").and_then(|s| s.as_bool()))
        .unwrap_or(true);

    let original_model = req_model.as_deref().unwrap_or("claude-opus-4-6");
    let upstream_mode = if is_streaming {
        "streaming"
    } else {
        "non_streaming"
    };
    let translated_request_len = codex_body.len();
    let codex_span_data = serde_json::json!({
        "model": codex_model,
        "streaming": is_streaming,
        "bodyLen": translated_request_len,
    });

    record_backend_event(
        app,
        "DEBUG",
        "proxy",
        session_id,
        "codex.request_prepared",
        "Prepared Codex upstream request",
        serde_json::json!({
            "clientModel": req_model,
            "upstreamRequestModel": routed_model,
            "originalModel": original_model,
            "codexModel": codex_model,
            "rewrite": rewrite,
            "upstreamMode": upstream_mode,
            "translatedBodyLen": translated_request_len,
        }),
    );

    record_backend_perf_start(
        app,
        "proxy",
        session_id,
        "codex.upstream_request",
        codex_span_data.clone(),
    );

    // Send to OpenAI using persistent client
    let mut request = codex_client
        .post(CODEX_API_URL)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Content-Type", "application/json");
    for (name, value) in codex_identity_headers(session_id) {
        request = request.header(name, value);
    }
    let request = if is_streaming {
        request.header("Accept", "text/event-stream")
    } else {
        request
    };

    let resp = match request.body(codex_body).send().await {
        Ok(r) => r,
        Err(e) => {
            if should_log {
                super::write_traffic_entry(
                    proxy_state,
                    &session_id_owned,
                    req_ts,
                    span_start,
                    "POST",
                    "/v1/messages",
                    client_model,
                    &provider.name,
                    rewrite,
                    &req_body_for_log,
                    502,
                    b"",
                    Some(codex_traffic_meta(
                        provider,
                        session_id.is_some(),
                        client_model,
                        &routed_model,
                        rewrite,
                        &codex_model,
                        upstream_mode,
                        codex_body_for_log.as_deref().unwrap_or(&[]),
                        translated_request_len,
                        None,
                    )),
                );
            }
            record_backend_perf_fail(
                app,
                "proxy",
                session_id,
                "codex.upstream_request",
                span_start,
                codex_span_data.clone(),
                serde_json::json!({}),
                e.to_string(),
            );
            record_backend_event(
                app,
                "ERR",
                "proxy",
                session_id,
                "codex.upstream_failed",
                &format!("Upstream failed: {e}"),
                serde_json::json!({}),
            );
            send_error(tcp_stream, 502, &format!("Codex upstream failed: {e}")).await;
            return Ok(());
        }
    };

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        if should_log {
            super::write_traffic_entry(
                proxy_state,
                &session_id_owned,
                req_ts,
                span_start,
                "POST",
                "/v1/messages",
                client_model,
                &provider.name,
                rewrite,
                &req_body_for_log,
                status,
                body.as_bytes(),
                Some(codex_traffic_meta(
                    provider,
                    session_id.is_some(),
                    client_model,
                    &routed_model,
                    rewrite,
                    &codex_model,
                    upstream_mode,
                    codex_body_for_log.as_deref().unwrap_or(&[]),
                    translated_request_len,
                    None,
                )),
            );
        }
        record_backend_perf_fail(
            app,
            "proxy",
            session_id,
            "codex.upstream_request",
            span_start,
            codex_span_data.clone(),
            serde_json::json!({ "status": status }),
            format!("Codex API {status}"),
        );
        record_backend_event(
            app,
            "WARN",
            "proxy",
            session_id,
            "codex.api_error",
            &format!("Codex API {status}"),
            serde_json::json!({ "status": status, "body": body }),
        );
        send_codex_upstream_error(tcp_stream, status, &body, is_streaming).await;
        return Ok(());
    }

    if is_streaming {
        // Streaming response — translate SSE events
        let resp_headers = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n";
        tcp_stream.write_all(resp_headers.as_bytes()).await?;

        let mut translator = stream::StreamTranslator::new(original_model);
        tcp_stream.write_all(&translator.message_start()).await?;
        tcp_stream.flush().await?;

        use futures_util::StreamExt;
        let mut byte_stream = resp.bytes_stream();
        let mut buffer = String::new();
        let mut chunk_count = 0usize;
        let mut line_count = 0usize;
        let mut translated_write_count = 0usize;
        let mut chunk_error: Option<String> = None;
        let mut resp_log_buf: Vec<u8> = if should_log {
            Vec::with_capacity(8192)
        } else {
            Vec::new()
        };

        while let Some(chunk) = byte_stream.next().await {
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    chunk_error = Some(e.to_string());
                    record_backend_event(
                        app,
                        "WARN",
                        "proxy",
                        session_id,
                        "codex.stream_chunk_error",
                        &format!("Stream chunk error: {e}"),
                        serde_json::json!({}),
                    );
                    break;
                }
            };
            chunk_count += 1;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(newline_pos) = buffer.find('\n') {
                let line = buffer[..newline_pos].trim().to_string();
                buffer = buffer[newline_pos + 1..].to_string();
                if line.is_empty() {
                    continue;
                }
                line_count += 1;

                let output = translator.process_line(&line);
                if !output.is_empty() {
                    translated_write_count += 1;
                    if should_log {
                        resp_log_buf.extend_from_slice(&output);
                    }
                    tcp_stream.write_all(&output).await?;
                    tcp_stream.flush().await?;
                }
            }
        }

        if !buffer.trim().is_empty() {
            line_count += 1;
            let output = translator.process_line(buffer.trim());
            if !output.is_empty() {
                translated_write_count += 1;
                if should_log {
                    resp_log_buf.extend_from_slice(&output);
                }
                tcp_stream.write_all(&output).await?;
                tcp_stream.flush().await?;
            }
        }

        let translation_summary = translator.final_summary().cloned();
        let translation_summary_value = translation_summary
            .as_ref()
            .map(|summary| serde_json::to_value(summary).unwrap_or_else(|_| json!({})))
            .unwrap_or(Value::Null);

        record_backend_event(
            app,
            "DEBUG",
            "proxy",
            session_id,
            "codex.stream_summary",
            "Processed Codex streaming response",
            serde_json::json!({
                "chunkCount": chunk_count,
                "lineCount": line_count,
                "translatedWriteCount": translated_write_count,
                "completed": translator.is_done(),
                "chunkError": chunk_error,
                "summary": translation_summary_value.clone(),
            }),
        );

        if should_log {
            super::write_traffic_entry(
                proxy_state,
                &session_id_owned,
                req_ts,
                span_start,
                "POST",
                "/v1/messages",
                client_model,
                &provider.name,
                rewrite,
                &req_body_for_log,
                200,
                &resp_log_buf,
                Some(codex_traffic_meta(
                    provider,
                    session_id.is_some(),
                    client_model,
                    &routed_model,
                    rewrite,
                    &codex_model,
                    upstream_mode,
                    codex_body_for_log.as_deref().unwrap_or(&[]),
                    translated_request_len,
                    translation_summary.as_ref(),
                )),
            );
        }

        record_backend_perf_end(
            app,
            "proxy",
            session_id,
            "codex.upstream_request",
            span_start,
            5000,
            codex_span_data.clone(),
            serde_json::json!({
                "chunkCount": chunk_count,
                "lineCount": line_count,
                "translatedWriteCount": translated_write_count,
                "completed": translator.is_done(),
                "summary": translation_summary_value,
            }),
        );
    } else {
        let codex_response_body = match resp.bytes().await {
            Ok(body) => body,
            Err(e) => {
                record_backend_perf_fail(
                    app,
                    "proxy",
                    session_id,
                    "codex.upstream_request",
                    span_start,
                    codex_span_data.clone(),
                    serde_json::json!({}),
                    format!("Read error: {e}"),
                );
                send_error(tcp_stream, 502, &format!("Codex upstream read failed: {e}")).await;
                return Ok(());
            }
        };
        let translated = match translate_resp::translate_response_with_summary(
            &codex_response_body,
            original_model,
        ) {
            Ok(b) => b,
            Err(e) => {
                if should_log {
                    super::write_traffic_entry(
                        proxy_state,
                        &session_id_owned,
                        req_ts,
                        span_start,
                        "POST",
                        "/v1/messages",
                        client_model,
                        &provider.name,
                        rewrite,
                        &req_body_for_log,
                        500,
                        &codex_response_body,
                        Some(codex_traffic_meta(
                            provider,
                            session_id.is_some(),
                            client_model,
                            &routed_model,
                            rewrite,
                            &codex_model,
                            upstream_mode,
                            codex_body_for_log.as_deref().unwrap_or(&[]),
                            translated_request_len,
                            None,
                        )),
                    );
                }
                record_backend_perf_fail(
                    app,
                    "proxy",
                    session_id,
                    "codex.upstream_request",
                    span_start,
                    codex_span_data.clone(),
                    serde_json::json!({}),
                    e.clone(),
                );
                record_backend_event(
                    app,
                    "ERR",
                    "proxy",
                    session_id,
                    "codex.translate_response_failed",
                    &format!("Response translation failed: {e}"),
                    serde_json::json!({}),
                );
                send_error(
                    tcp_stream,
                    500,
                    &format!("Response translation failed: {e}"),
                )
                .await;
                return Ok(());
            }
        };
        let translated_summary_value =
            serde_json::to_value(&translated.summary).unwrap_or_else(|_| json!({}));

        record_backend_event(
            app,
            "DEBUG",
            "proxy",
            session_id,
            "codex.translation_summary",
            "Translated Codex response",
            serde_json::json!({
                "upstreamMode": upstream_mode,
                "summary": translated_summary_value.clone(),
            }),
        );

        let resp_str = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            translated.body.len(),
        );
        tcp_stream.write_all(resp_str.as_bytes()).await?;
        tcp_stream.write_all(&translated.body).await?;
        tcp_stream.flush().await?;

        if should_log {
            super::write_traffic_entry(
                proxy_state,
                &session_id_owned,
                req_ts,
                span_start,
                "POST",
                "/v1/messages",
                client_model,
                &provider.name,
                rewrite,
                &req_body_for_log,
                200,
                &translated.body,
                Some(codex_traffic_meta(
                    provider,
                    session_id.is_some(),
                    client_model,
                    &routed_model,
                    rewrite,
                    &codex_model,
                    upstream_mode,
                    codex_body_for_log.as_deref().unwrap_or(&[]),
                    translated_request_len,
                    Some(&translated.summary),
                )),
            );
        }

        record_backend_perf_end(
            app,
            "proxy",
            session_id,
            "codex.upstream_request",
            span_start,
            5000,
            codex_span_data,
            serde_json::json!({
                "responseLen": translated.body.len(),
                "summary": translated_summary_value,
            }),
        );
    }

    Ok(())
}

fn extract_model_from_body(body: &[u8]) -> Option<String> {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("model")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
        })
}

async fn send_error(stream: &mut tokio::net::TcpStream, status: u16, msg: &str) {
    let body = serde_json::json!({
        "type": "error",
        "error": { "type": "proxy_error", "message": msg }
    })
    .to_string();
    let reason = match status {
        400 => "Bad Request",
        401 => "Unauthorized",
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

// [PR-15] Codex SSE 4xx framing: deliver upstream errors as Anthropic event:error on SSE 200 when client requested streaming
// When the Anthropic client requested SSE (`stream:true`), deliver upstream
// failures as an Anthropic-shaped `event: error` frame on a 200 OK SSE stream
// instead of a plain JSON error body the client's SSE parser cannot consume.
async fn send_codex_upstream_error(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    body: &str,
    is_streaming: bool,
) {
    if !is_streaming {
        send_error(stream, status, &format!("Codex API error: {body}")).await;
        return;
    }
    let resp_headers = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n";
    let payload = serde_json::json!({
        "type": "error",
        "error": { "type": "api_error", "message": format!("Codex API error: {body}") }
    })
    .to_string();
    let frame = format!("event: error\ndata: {payload}\n\n");
    let _ = stream.write_all(resp_headers.as_bytes()).await;
    let _ = stream.write_all(frame.as_bytes()).await;
    let _ = stream.flush().await;
}

// [PR-14] is_quota_probe: short-circuits Claude Code's {max_tokens:1, messages:[{role:user, content:quota}]} auth probe
fn is_quota_probe(body: &[u8]) -> bool {
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(body) else {
        return false;
    };
    if v.get("max_tokens").and_then(|m| m.as_u64()) != Some(1) {
        return false;
    }
    let Some(messages) = v.get("messages").and_then(|m| m.as_array()) else {
        return false;
    };
    if messages.len() != 1 {
        return false;
    }
    let msg = &messages[0];
    if msg.get("role").and_then(|r| r.as_str()) != Some("user") {
        return false;
    }
    let Some(content) = msg.get("content") else {
        return false;
    };
    // Anthropic accepts both a bare string and a content-block array.
    if content.as_str() == Some("quota") {
        return true;
    }
    let Some(blocks) = content.as_array() else {
        return false;
    };
    if blocks.len() != 1 {
        return false;
    }
    let block = &blocks[0];
    block.get("type").and_then(|t| t.as_str()) == Some("text")
        && block.get("text").and_then(|t| t.as_str()) == Some("quota")
}

async fn send_quota_probe_response(
    tcp: &mut tokio::net::TcpStream,
    is_streaming: bool,
    original_model: &str,
) -> std::io::Result<()> {
    let message = serde_json::json!({
        "id": "msg_quota_probe",
        "type": "message",
        "role": "assistant",
        "model": original_model,
        "content": [],
        "stop_reason": "end_turn",
        "stop_sequence": null,
        "usage": { "input_tokens": 0, "output_tokens": 0 },
    });
    if is_streaming {
        let headers = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n";
        tcp.write_all(headers.as_bytes()).await?;
        let start = serde_json::json!({ "type": "message_start", "message": message });
        let delta = serde_json::json!({
            "type": "message_delta",
            "delta": { "stop_reason": "end_turn", "stop_sequence": null },
            "usage": { "output_tokens": 0 },
        });
        let stop = serde_json::json!({ "type": "message_stop" });
        tcp.write_all(&stream::format_sse_event("message_start", &start)).await?;
        tcp.write_all(&stream::format_sse_event("message_delta", &delta)).await?;
        tcp.write_all(&stream::format_sse_event("message_stop", &stop)).await?;
    } else {
        let body = message.to_string();
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len(),
        );
        tcp.write_all(resp.as_bytes()).await?;
    }
    tcp.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header_value<'a>(headers: &'a [(&'static str, String)], name: &str) -> Option<&'a str> {
        headers
            .iter()
            .find_map(|(header_name, value)| (*header_name == name).then_some(value.as_str()))
    }

    #[test]
    fn test_resolve_codex_model_haiku() {
        let provider = ModelProvider {
            id: "codex".into(),
            name: "Codex".into(),
            kind: "openai_codex".into(),
            predefined: true,
            model_mappings: Vec::new(),
            base_url: None,
            api_key: None,
            socks5_proxy: None,
            codex_primary_model: Some("gpt-5.5".into()),
            codex_small_model: Some("gpt-5.5-mini".into()),
            known_models: Vec::new(),
        };
        assert_eq!(
            resolve_codex_model(Some("claude-haiku-4-5"), &provider),
            "gpt-5.5-mini"
        );
        assert_eq!(
            resolve_codex_model(Some("haiku"), &provider),
            "gpt-5.5-mini"
        );
    }

    #[test]
    fn test_resolve_codex_model_opus() {
        let provider = ModelProvider {
            id: "codex".into(),
            name: "Codex".into(),
            kind: "openai_codex".into(),
            predefined: true,
            model_mappings: Vec::new(),
            base_url: None,
            api_key: None,
            socks5_proxy: None,
            codex_primary_model: Some("gpt-5.5".into()),
            codex_small_model: Some("gpt-5.5-mini".into()),
            known_models: Vec::new(),
        };
        assert_eq!(
            resolve_codex_model(Some("claude-opus-4-6"), &provider),
            "gpt-5.5"
        );
        assert_eq!(resolve_codex_model(Some("opus"), &provider), "gpt-5.5");
        assert_eq!(resolve_codex_model(Some("best"), &provider), "gpt-5.5");
        assert_eq!(resolve_codex_model(Some("opusplan"), &provider), "gpt-5.5");
        assert_eq!(resolve_codex_model(Some("sonnet"), &provider), "gpt-5.5");
    }

    #[test]
    fn test_resolve_codex_model_passthrough() {
        let provider = ModelProvider {
            id: "codex".into(),
            name: "Codex".into(),
            kind: "openai_codex".into(),
            predefined: true,
            model_mappings: Vec::new(),
            base_url: None,
            api_key: None,
            socks5_proxy: None,
            codex_primary_model: Some("gpt-5.5".into()),
            codex_small_model: Some("gpt-5.5-mini".into()),
            known_models: Vec::new(),
        };
        assert_eq!(resolve_codex_model(Some("gpt-5.5"), &provider), "gpt-5.5");
    }

    #[test]
    fn test_resolve_codex_model_1m_suffix() {
        let provider = ModelProvider {
            id: "codex".into(),
            name: "Codex".into(),
            kind: "openai_codex".into(),
            predefined: true,
            model_mappings: Vec::new(),
            base_url: None,
            api_key: None,
            socks5_proxy: None,
            codex_primary_model: Some("gpt-5.5".into()),
            codex_small_model: Some("gpt-5.5-mini".into()),
            known_models: Vec::new(),
        };
        assert_eq!(
            resolve_codex_model(Some("claude-opus-4-6[1m]"), &provider),
            "gpt-5.5"
        );
        assert_eq!(
            resolve_codex_model(Some("claude-haiku-4-5[1m]"), &provider),
            "gpt-5.5-mini"
        );
        assert_eq!(resolve_codex_model(Some("best[1m]"), &provider), "gpt-5.5");
        assert_eq!(
            resolve_codex_model(Some("opusplan[1m]"), &provider),
            "gpt-5.5"
        );
    }

    #[test]
    fn test_codex_traffic_meta_includes_translated_request_payload() {
        let provider = ModelProvider {
            id: "codex".into(),
            name: "Codex".into(),
            kind: "openai_codex".into(),
            predefined: true,
            model_mappings: Vec::new(),
            base_url: None,
            api_key: None,
            socks5_proxy: None,
            codex_primary_model: Some("gpt-5.5".into()),
            codex_small_model: Some("gpt-5.5-mini".into()),
            known_models: Vec::new(),
        };

        let translated_request = br#"{"model":"gpt-5.5","input":[{"role":"user","content":[{"type":"input_text","text":"hello"}]}]}"#;

        let meta = codex_traffic_meta(
            &provider,
            true,
            &Some("claude-opus-4-6".into()),
            &Some("gpt-5.5".into()),
            &Some("gpt-5.5".into()),
            "gpt-5.5",
            "streaming",
            translated_request,
            translated_request.len(),
            None,
        );

        assert_eq!(meta["translation"]["translatedRequest"]["model"], "gpt-5.5");
        assert_eq!(meta["route"]["clientModel"], "claude-opus-4-6");
        assert_eq!(meta["route"]["upstreamRequestModel"], "gpt-5.5");
        assert_eq!(
            meta["translation"]["translatedRequest"]["input"][0]["role"],
            "user"
        );
        assert_eq!(
            meta["translation"]["translatedRequest"]["input"][0]["content"][0]["text"],
            "hello"
        );
    }

    #[test]
    fn test_codex_identity_headers_match_cli_shape() {
        let headers = codex_identity_headers(Some("session-123"));

        assert_eq!(header_value(&headers, "originator"), Some(CODEX_CLI_ORIGINATOR));
        assert_eq!(header_value(&headers, "session_id"), Some("session-123"));
        assert_eq!(
            header_value(&headers, "x-client-request-id"),
            Some("session-123")
        );

        let user_agent = header_value(&headers, "user-agent").expect("missing user-agent");
        assert!(user_agent.starts_with("codex_cli_rs/"));
        assert!(user_agent.contains("claude-tabs/"));
    }

    #[test]
    fn test_synthetic_models_response_uses_provider_known_models() {
        let provider = ModelProvider {
            id: "codex".into(),
            name: "Codex".into(),
            kind: "openai_codex".into(),
            predefined: true,
            model_mappings: vec![],
            base_url: None,
            api_key: None,
            socks5_proxy: None,
            codex_primary_model: Some("gpt-5.5".into()),
            codex_small_model: Some("gpt-5.5-mini".into()),
            known_models: vec![
                crate::session::types::ProviderModel {
                    id: "gpt-5.5".into(),
                    label: "GPT-5.5".into(),
                    family: Some("codex-primary".into()),
                    context_window: Some(400_000),
                    color: None,
                },
                crate::session::types::ProviderModel {
                    id: "gpt-5.5-pro".into(),
                    label: "GPT-5.5 Pro".into(),
                    family: Some("codex-pro".into()),
                    context_window: Some(400_000),
                    color: None,
                },
            ],
        };

        let body = build_synthetic_models_response(&provider);
        let json: Value = serde_json::from_slice(&body).unwrap();
        let data = json["data"].as_array().unwrap();

        assert_eq!(data[0]["id"], "gpt-5.5");
        assert_eq!(data[0]["display_name"], "GPT-5.5");
        assert_eq!(data[0]["max_input_tokens"], 400_000);
        assert_eq!(data[1]["id"], "gpt-5.5-pro");
        assert_eq!(data[1]["display_name"], "GPT-5.5 Pro");
        assert!(
            data.iter().any(|entry| entry["id"] == "gpt-5.5-mini"),
            "small fallback should still be present when not in known_models"
        );
        assert_eq!(json["first_id"], "gpt-5.5");
        assert_eq!(json["last_id"], "gpt-5.5-mini");
    }

    #[test]
    fn test_is_quota_probe_matches_claude_code_shape() {
        let body = br#"{"max_tokens":1,"messages":[{"content":"quota","role":"user"}],"model":"claude-haiku-4-5-20251001"}"#;
        assert!(is_quota_probe(body));
    }

    #[test]
    fn test_is_quota_probe_rejects_real_user_message() {
        let body = br#"{"max_tokens":4096,"messages":[{"content":"quota","role":"user"}],"model":"claude-opus-4-6"}"#;
        assert!(!is_quota_probe(body));
    }

    #[test]
    fn test_is_quota_probe_rejects_different_content() {
        let body = br#"{"max_tokens":1,"messages":[{"content":"hello","role":"user"}],"model":"claude-haiku-4-5"}"#;
        assert!(!is_quota_probe(body));
    }

    #[test]
    fn test_is_quota_probe_rejects_multi_message() {
        let body = br#"{"max_tokens":1,"messages":[{"content":"quota","role":"user"},{"content":"more","role":"user"}],"model":"claude-haiku-4-5"}"#;
        assert!(!is_quota_probe(body));
    }

    #[test]
    fn test_is_quota_probe_rejects_assistant_role() {
        let body = br#"{"max_tokens":1,"messages":[{"content":"quota","role":"assistant"}],"model":"claude-haiku-4-5"}"#;
        assert!(!is_quota_probe(body));
    }

    #[test]
    fn test_is_quota_probe_rejects_malformed_json() {
        assert!(!is_quota_probe(b"not json"));
    }

    #[test]
    fn test_is_quota_probe_matches_array_content_block() {
        // Anthropic SDK also sends `content` as a content-block array.
        let body = br#"{"max_tokens":1,"messages":[{"role":"user","content":[{"type":"text","text":"quota"}]}],"model":"claude-haiku-4-5"}"#;
        assert!(is_quota_probe(body));
    }

    #[test]
    fn test_is_quota_probe_rejects_array_with_wrong_text() {
        let body = br#"{"max_tokens":1,"messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}],"model":"claude-haiku-4-5"}"#;
        assert!(!is_quota_probe(body));
    }

    #[test]
    fn test_is_quota_probe_rejects_non_text_block() {
        let body = br#"{"max_tokens":1,"messages":[{"role":"user","content":[{"type":"image","source":{}}]}],"model":"claude-haiku-4-5"}"#;
        assert!(!is_quota_probe(body));
    }

    #[test]
    fn test_is_quota_probe_rejects_multi_block_content() {
        let body = br#"{"max_tokens":1,"messages":[{"role":"user","content":[{"type":"text","text":"quota"},{"type":"text","text":"extra"}]}],"model":"claude-haiku-4-5"}"#;
        assert!(!is_quota_probe(body));
    }
}

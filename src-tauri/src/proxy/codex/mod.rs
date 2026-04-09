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
use std::sync::{Arc, Mutex};
use tokio::io::AsyncWriteExt;

const CODEX_API_URL: &str = "https://chatgpt.com/backend-api/codex/responses";

/// Resolve the Codex model name from the request model and provider config.
fn resolve_codex_model(model: Option<&str>, provider: &ModelProvider) -> String {
    let primary = provider.codex_primary_model.as_deref().unwrap_or("gpt-5.4");
    let small = provider
        .codex_small_model
        .as_deref()
        .unwrap_or("gpt-5.4-mini");

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
    if cleaned.contains("sonnet") || cleaned.contains("opus") || cleaned.starts_with("claude") {
        return primary.to_string();
    }

    // Not a Claude model — could be a Codex model name already, pass through
    model.to_string()
}

/// [PR-02] Translate Anthropic-style requests and streaming responses
/// through the OpenAI Responses API for the OpenAI Codex provider.
/// Context window sizes for OpenAI models (tokens).
/// Default is 272k; 1M is opt-in and costs 2x input.
/// We report the default window so Claude Code compacts appropriately.
const GPT_5_4_CONTEXT_WINDOW: u64 = 272_000;
const GPT_5_4_MINI_CONTEXT_WINDOW: u64 = 272_000;
const GPT_5_4_MAX_OUTPUT: u64 = 128_000;
const GPT_5_4_MINI_MAX_OUTPUT: u64 = 128_000;

/// Build a synthetic Anthropic `/v1/models` response for the Codex provider.
/// Claude Code uses this to determine context window size for compaction.
fn build_synthetic_models_response(provider: &ModelProvider) -> Vec<u8> {
    let primary = provider.codex_primary_model.as_deref().unwrap_or("gpt-5.4");
    let small = provider
        .codex_small_model
        .as_deref()
        .unwrap_or("gpt-5.4-mini");

    // Build model entries that look like Anthropic's model list response
    let models = serde_json::json!({
        "data": [
            {
                "id": primary,
                "type": "model",
                "display_name": primary,
                "created_at": "2025-01-01T00:00:00Z",
                "max_input_tokens": GPT_5_4_CONTEXT_WINDOW,
                "max_tokens": GPT_5_4_MAX_OUTPUT,
            },
            {
                "id": small,
                "type": "model",
                "display_name": small,
                "created_at": "2025-01-01T00:00:00Z",
                "max_input_tokens": GPT_5_4_MINI_CONTEXT_WINDOW,
                "max_tokens": GPT_5_4_MINI_MAX_OUTPUT,
            },
        ],
        "has_more": false,
        "first_id": primary,
        "last_id": small,
    });
    serde_json::to_vec(&models).unwrap_or_default()
}

fn codex_traffic_meta(
    provider: &ModelProvider,
    session_scoped: bool,
    request_model: &Option<String>,
    rewrite: &Option<String>,
    codex_model: &str,
    upstream_mode: &str,
    translated_request_len: usize,
    summary: Option<&response_shape::ResponseTranslationSummary>,
) -> Value {
    let mut translation = json!({
        "proxy": "codex",
        "upstreamMode": upstream_mode,
        "requestModel": request_model,
        "resolvedCodexModel": codex_model,
        "translatedRequestLen": translated_request_len,
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
            "requestModel": request_model,
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
    orig_model: &Option<String>,
    rewrite: &Option<String>,
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

    // Get access token from persistent state
    let access_token = {
        let token = {
            let s = proxy_state.lock().map_err(|e| e.to_string())?;
            s.codex_auth.get_access_token_sync()
        };
        // Lock dropped before any await
        match token {
            Some(t) => t,
            None => {
                record_backend_event(
                    app,
                    "WARN",
                    "proxy",
                    session_id,
                    "codex.auth_failed",
                    "Codex: not logged in",
                    serde_json::json!({}),
                );
                send_error(tcp_stream, 401, "Codex auth failed: not logged in").await;
                return Ok(());
            }
        }
    };

    // Extract model from request and resolve to Codex model
    let req_model = extract_model_from_body(body);
    let codex_model = resolve_codex_model(req_model.as_deref(), provider);

    record_backend_event(
        app,
        "DEBUG",
        "proxy",
        session_id,
        "codex.translate_request",
        &format!(
            "Codex: {} -> {}",
            req_model.as_deref().unwrap_or("(none)"),
            codex_model
        ),
        serde_json::json!({ "requestModel": req_model, "codexModel": codex_model }),
    );

    // Translate request
    let codex_body = match translate_req::translate_request(body, &codex_model) {
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
            "requestModel": req_model,
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
    let request = codex_client
        .post(CODEX_API_URL)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Content-Type", "application/json");
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
                    orig_model,
                    &provider.name,
                    rewrite,
                    &req_body_for_log,
                    502,
                    b"",
                    Some(codex_traffic_meta(
                        provider,
                        session_id.is_some(),
                        orig_model,
                        rewrite,
                        &codex_model,
                        upstream_mode,
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
                orig_model,
                &provider.name,
                rewrite,
                &req_body_for_log,
                status,
                body.as_bytes(),
                Some(codex_traffic_meta(
                    provider,
                    session_id.is_some(),
                    orig_model,
                    rewrite,
                    &codex_model,
                    upstream_mode,
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
        send_error(tcp_stream, status, &format!("Codex API error: {body}")).await;
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
                orig_model,
                &provider.name,
                rewrite,
                &req_body_for_log,
                200,
                &resp_log_buf,
                Some(codex_traffic_meta(
                    provider,
                    session_id.is_some(),
                    orig_model,
                    rewrite,
                    &codex_model,
                    upstream_mode,
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
                        orig_model,
                        &provider.name,
                        rewrite,
                        &req_body_for_log,
                        500,
                        &codex_response_body,
                        Some(codex_traffic_meta(
                            provider,
                            session_id.is_some(),
                            orig_model,
                            rewrite,
                            &codex_model,
                            upstream_mode,
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
                orig_model,
                &provider.name,
                rewrite,
                &req_body_for_log,
                200,
                &translated.body,
                Some(codex_traffic_meta(
                    provider,
                    session_id.is_some(),
                    orig_model,
                    rewrite,
                    &codex_model,
                    upstream_mode,
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

#[cfg(test)]
mod tests {
    use super::*;

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
            codex_primary_model: Some("gpt-5.4".into()),
            codex_small_model: Some("gpt-5.4-mini".into()),
            known_models: Vec::new(),
        };
        assert_eq!(
            resolve_codex_model(Some("claude-haiku-4-5"), &provider),
            "gpt-5.4-mini"
        );
        assert_eq!(
            resolve_codex_model(Some("haiku"), &provider),
            "gpt-5.4-mini"
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
            codex_primary_model: Some("gpt-5.4".into()),
            codex_small_model: Some("gpt-5.4-mini".into()),
            known_models: Vec::new(),
        };
        assert_eq!(
            resolve_codex_model(Some("claude-opus-4-6"), &provider),
            "gpt-5.4"
        );
        assert_eq!(resolve_codex_model(Some("opus"), &provider), "gpt-5.4");
        assert_eq!(resolve_codex_model(Some("sonnet"), &provider), "gpt-5.4");
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
            codex_primary_model: Some("gpt-5.4".into()),
            codex_small_model: Some("gpt-5.4-mini".into()),
            known_models: Vec::new(),
        };
        assert_eq!(resolve_codex_model(Some("gpt-5.4"), &provider), "gpt-5.4");
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
            codex_primary_model: Some("gpt-5.4".into()),
            codex_small_model: Some("gpt-5.4-mini".into()),
            known_models: Vec::new(),
        };
        assert_eq!(
            resolve_codex_model(Some("claude-opus-4-6[1m]"), &provider),
            "gpt-5.4"
        );
        assert_eq!(
            resolve_codex_model(Some("claude-haiku-4-5[1m]"), &provider),
            "gpt-5.4-mini"
        );
    }
}

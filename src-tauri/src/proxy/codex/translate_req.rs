use std::collections::HashMap;

use serde_json::{json, Map, Value};

use super::super::compress;

const CLAUDE_CODE_OPENAI_ADAPTER: &str = concat!(
    "You are running inside Claude Code through an OpenAI model transport. ",
    "Use the provided Claude Code tools exactly as named. ",
    "Prefer Edit or Write for file changes when appropriate. ",
    "Do not wait for a separate apply_patch tool. ",
    "Read only the minimal context needed, and avoid repeated partial reads ",
    "when one whole-file read is available."
);

fn map_reasoning_effort(value: &str) -> &'static str {
    match value.trim().to_ascii_lowercase().as_str() {
        "none" | "minimal" => "none",
        "low" => "low",
        "medium" => "medium",
        "high" => "high",
        "max" | "xhigh" => "xhigh",
        _ => "medium",
    }
}

fn translate_reasoning(req: &Value) -> Option<Value> {
    if let Some(effort) = req
        .get("output_config")
        .and_then(|v| v.get("effort"))
        .and_then(|v| v.as_str())
    {
        return Some(json!({ "effort": map_reasoning_effort(effort) }));
    }

    if req.get("thinking").is_some() {
        return Some(json!({ "effort": "medium" }));
    }

    None
}

// [PR-11] Preserve Claude fast-mode intent on the Codex transport by mapping
// Anthropic's `speed=fast` request flag onto OpenAI's priority service tier.
fn translate_service_tier(req: &Value) -> Option<&'static str> {
    match req.get("speed").and_then(|v| v.as_str()) {
        Some("fast") => Some("priority"),
        _ => None,
    }
}

/// Translate an Anthropic Messages API request body into an OpenAI Codex request body.
pub fn translate_request(
    body: &[u8],
    codex_model: &str,
    compression_enabled: bool,
) -> Result<Vec<u8>, String> {
    translate_request_with_session(body, codex_model, compression_enabled, None, None)
}

/// Translate an Anthropic Messages API request body into an OpenAI Codex request body.
pub fn translate_request_with_session(
    body: &[u8],
    codex_model: &str,
    compression_enabled: bool,
    session_id: Option<&str>,
    installation_id: Option<&str>,
) -> Result<Vec<u8>, String> {
    let req: Value =
        serde_json::from_slice(body).map_err(|e| format!("Failed to parse request: {e}"))?;

    let mut codex_req = json!({
        "model": codex_model,
        "stream": req.get("stream").and_then(|v| v.as_bool()).unwrap_or(true),
        "store": false,
        "parallel_tool_calls": true,
    });

    // system → instructions
    let system_text = req
        .get("system")
        .map(extract_system_text)
        .unwrap_or_default();
    let instructions = build_openai_instructions(&system_text);
    if !instructions.is_empty() {
        codex_req["instructions"] = json!(instructions);
    }

    if let Some(session_id) = non_empty(session_id) {
        codex_req["prompt_cache_key"] = json!(format!("claude-tabs:{session_id}"));
    }
    if let Some(metadata) = build_client_metadata(session_id, installation_id) {
        codex_req["client_metadata"] = metadata;
    }

    // Keep the request body to the minimal shape used by the known-good
    // Codex transport, but preserve core execution controls. The
    // chatgpt.com Codex backend rejects some Responses API fields (for
    // example `temperature`), so we intentionally omit Anthropic-only and
    // optional tuning parameters that are not required for parity.

    if let Some(reasoning) = translate_reasoning(&req) {
        codex_req["reasoning"] = reasoning;
    }
    if let Some(service_tier) = translate_service_tier(&req) {
        codex_req["service_tier"] = json!(service_tier);
    }

    // tools
    if let Some(tools) = req.get("tools").and_then(|v| v.as_array()) {
        let codex_tools: Vec<Value> = tools.iter().map(translate_tool).collect();
        if !codex_tools.is_empty() {
            codex_req["tools"] = json!(codex_tools);
        }
    }

    // tool_choice
    if let Some(tc) = req.get("tool_choice") {
        codex_req["tool_choice"] = translate_tool_choice(tc);
    }

    // messages → input (each message may produce multiple top-level input items)
    if let Some(messages) = req.get("messages").and_then(|v| v.as_array()) {
        let tool_map = if compression_enabled {
            compress::build_tool_id_map(messages)
        } else {
            HashMap::new()
        };
        let input: Vec<Value> = messages
            .iter()
            .flat_map(|msg| translate_message(msg, &tool_map, compression_enabled))
            .collect();
        codex_req["input"] = json!(input);
    }

    serde_json::to_vec(&codex_req).map_err(|e| format!("Failed to serialize: {e}"))
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn build_client_metadata(session_id: Option<&str>, installation_id: Option<&str>) -> Option<Value> {
    let mut metadata = Map::new();
    if let Some(installation_id) = non_empty(installation_id) {
        metadata.insert(
            "x-codex-installation-id".to_string(),
            Value::String(installation_id.to_string()),
        );
    }
    if let Some(session_id) = non_empty(session_id) {
        metadata.insert(
            "x-codex-session-id".to_string(),
            Value::String(session_id.to_string()),
        );
    }

    if metadata.is_empty() {
        None
    } else {
        metadata.insert(
            "originator".to_string(),
            Value::String("claude_tabs".to_string()),
        );
        Some(Value::Object(metadata))
    }
}

fn build_openai_instructions(system_text: &str) -> String {
    let sanitized = sanitize_system_instructions(system_text);
    if sanitized.trim().is_empty() {
        return CLAUDE_CODE_OPENAI_ADAPTER.to_string();
    }
    format!("{sanitized}\n\n{CLAUDE_CODE_OPENAI_ADAPTER}")
}

fn extract_system_text(system: &Value) -> String {
    match system {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .filter_map(|block| block.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn sanitize_system_instructions(text: &str) -> String {
    text.lines()
        .filter(|line| {
            !line
                .to_ascii_lowercase()
                .contains("anthropic-billing-header")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn message_text_type(role: &str) -> &'static str {
    if role == "assistant" {
        "output_text"
    } else {
        "input_text"
    }
}

fn translate_tool(tool: &Value) -> Value {
    json!({
        "type": "function",
        "name": tool.get("name").and_then(|v| v.as_str()).unwrap_or(""),
        "description": tool.get("description").and_then(|v| v.as_str()).unwrap_or(""),
        "parameters": tool.get("input_schema").cloned().unwrap_or(json!({})),
    })
}

fn translate_tool_choice(tc: &Value) -> Value {
    match tc.get("type").and_then(|v| v.as_str()) {
        Some("any") => json!("required"),
        Some("auto") => json!("auto"),
        Some("tool") => {
            if let Some(name) = tc.get("name").and_then(|v| v.as_str()) {
                json!({"type": "function", "name": name})
            } else {
                json!("auto")
            }
        }
        _ => json!("auto"),
    }
}

/// Translate one Anthropic message into one or more OpenAI input items.
///
/// Text blocks are grouped into a single message with input content items.
/// User/developer/system messages use `input_text`, while assistant history
/// must use `output_text`. tool_use and tool_result blocks become separate
/// top-level items (function_call / function_call_output) because the
/// Responses API does not allow them inside a message content array.
fn translate_message(
    msg: &Value,
    tool_map: &HashMap<String, String>,
    compression_enabled: bool,
) -> Vec<Value> {
    let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("user");
    let text_type = message_text_type(role);

    // Simple string content — single message item
    if let Some(text) = msg.get("content").and_then(|v| v.as_str()) {
        return vec![json!({"role": role, "content": [{"type": text_type, "text": text}]})];
    }

    let blocks = match msg.get("content").and_then(|v| v.as_array()) {
        Some(b) => b,
        None => return vec![json!({"role": role, "content": [{"type": text_type, "text": ""}]})],
    };

    let mut items: Vec<Value> = Vec::new();
    let mut text_parts: Vec<&str> = Vec::new();
    let mut inline_content: Vec<Value> = Vec::new(); // non-text content that stays in the message (images)

    for block in blocks {
        let block_type = match block.get("type").and_then(|v| v.as_str()) {
            Some(t) => t,
            None => continue,
        };
        match block_type {
            "text" => {
                text_parts.push(block.get("text").and_then(|v| v.as_str()).unwrap_or(""));
            }
            "tool_use" => {
                let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let input = block.get("input").cloned().unwrap_or(json!({}));
                let arguments = serde_json::to_string(&input).unwrap_or_default();
                // Flush any accumulated text before the function call
                if !text_parts.is_empty() || !inline_content.is_empty() {
                    let mut content = Vec::new();
                    if !text_parts.is_empty() {
                        content.push(json!({"type": text_type, "text": text_parts.join("")}));
                        text_parts.clear();
                    }
                    content.append(&mut inline_content);
                    items.push(json!({"role": role, "content": content}));
                }
                items.push(json!({
                    "type": "function_call",
                    "call_id": id,
                    "name": name,
                    "arguments": arguments,
                }));
            }
            "tool_result" => {
                let tool_use_id = block
                    .get("tool_use_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let raw_output = extract_tool_result_text(block);
                let output = if compression_enabled {
                    let tool_name = tool_map.get(tool_use_id).map(|s| s.as_str());
                    compress::compress_tool_result(&raw_output, tool_name)
                } else {
                    raw_output
                };
                let output = if block.get("is_error").and_then(|v| v.as_bool()) == Some(true) {
                    format!("[Tool error]\n{output}")
                } else {
                    output
                };
                items.push(json!({
                    "type": "function_call_output",
                    "call_id": tool_use_id,
                    "output": output,
                }));
            }
            "image" => {
                if let Some(img) = translate_image_block(block) {
                    inline_content.push(img);
                }
            }
            _ => {
                // Unknown block — include as text if possible
                if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                    text_parts.push(text);
                }
            }
        }
    }

    // Flush remaining text/inline content
    if !text_parts.is_empty() || !inline_content.is_empty() {
        let mut content = Vec::new();
        if !text_parts.is_empty() {
            content.push(json!({"type": text_type, "text": text_parts.join("")}));
        }
        content.append(&mut inline_content);
        items.push(json!({"role": role, "content": content}));
    }

    // If the message produced no items at all (e.g. empty tool_result-only user message
    // where tool_results already emitted), return as-is. Otherwise if only tool_use blocks
    // existed with no text, items already has the function_calls.
    if items.is_empty() {
        vec![json!({"role": role, "content": [{"type": text_type, "text": ""}]})]
    } else {
        items
    }
}

fn translate_image_block(block: &Value) -> Option<Value> {
    let source = block.get("source")?;
    let source_type = source.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match source_type {
        "base64" => {
            let media_type = source
                .get("media_type")
                .and_then(|v| v.as_str())
                .unwrap_or("image/png");
            let data = source.get("data").and_then(|v| v.as_str()).unwrap_or("");
            Some(json!({
                "type": "input_image",
                "image_url": format!("data:{media_type};base64,{data}"),
            }))
        }
        "url" => {
            let url = source.get("url").and_then(|v| v.as_str()).unwrap_or("");
            Some(json!({
                "type": "input_image",
                "image_url": url,
            }))
        }
        _ => None,
    }
}

fn extract_tool_result_text(block: &Value) -> String {
    if let Some(content) = block.get("content") {
        match content {
            Value::String(s) => return s.clone(),
            Value::Array(arr) => {
                return arr
                    .iter()
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n");
            }
            _ => {}
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_request_translation() {
        let body = json!({
            "model": "claude-opus-4-6",
            "max_tokens": 4096,
            "system": "You are a helpful assistant",
            "messages": [
                {"role": "user", "content": "Hello"}
            ],
            "stream": true,
        });
        let result =
            translate_request(serde_json::to_vec(&body).unwrap().as_slice(), "gpt-5.5", false).unwrap();
        let translated: Value = serde_json::from_slice(&result).unwrap();
        assert_eq!(translated["model"], "gpt-5.5");
        assert_eq!(
            translated["instructions"],
            format!("You are a helpful assistant\n\n{CLAUDE_CODE_OPENAI_ADAPTER}")
        );
        assert_eq!(translated["stream"], true);
        assert_eq!(translated["parallel_tool_calls"], true);
        assert!(translated.get("max_tokens").is_none());
        assert_eq!(translated["input"][0]["role"], "user");
        assert_eq!(translated["input"][0]["content"][0]["type"], "input_text");
        assert_eq!(translated["input"][0]["content"][0]["text"], "Hello");
    }

    #[test]
    fn test_session_context_adds_codex_cache_and_metadata_fields() {
        let body = json!({
            "model": "claude-opus-4-6",
            "messages": [
                {"role": "user", "content": "Hello"}
            ],
            "stream": true,
        });
        let result = translate_request_with_session(
            serde_json::to_vec(&body).unwrap().as_slice(),
            "gpt-5.5",
            false,
            Some("session-123"),
            Some("install-456"),
        )
        .unwrap();
        let translated: Value = serde_json::from_slice(&result).unwrap();

        assert_eq!(translated["prompt_cache_key"], "claude-tabs:session-123");
        assert_eq!(
            translated["client_metadata"]["x-codex-installation-id"],
            "install-456"
        );
        assert_eq!(
            translated["client_metadata"]["x-codex-session-id"],
            "session-123"
        );
        assert_eq!(translated["client_metadata"]["originator"], "claude_tabs");
    }

    #[test]
    fn test_billing_header_is_removed_from_string_system_prompt() {
        let body = json!({
            "model": "claude-opus-4-6",
            "system": "You are a helpful assistant\nx-anthropic-billing-header: cc_version=2.1.92.26f; cc_entrypoint=cli; cch=ce585;\nKeep answers concise.",
            "messages": [
                {"role": "user", "content": "Hello"}
            ],
            "stream": true,
        });
        let result =
            translate_request(serde_json::to_vec(&body).unwrap().as_slice(), "gpt-5.5", false).unwrap();
        let translated: Value = serde_json::from_slice(&result).unwrap();

        assert_eq!(
            translated["instructions"],
            format!(
                "You are a helpful assistant\nKeep answers concise.\n\n{}",
                CLAUDE_CODE_OPENAI_ADAPTER
            )
        );
    }

    #[test]
    fn test_billing_header_is_removed_from_system_array_prompt() {
        let body = json!({
            "model": "claude-opus-4-6",
            "system": [
                { "type": "text", "text": "You are a helpful assistant" },
                { "type": "text", "text": "x-anthropic-billing-header: cc_version=2.1.92.26f; cc_entrypoint=cli; cch=ce585;" },
                { "type": "text", "text": "Keep answers concise." }
            ],
            "messages": [
                {"role": "user", "content": "Hello"}
            ],
            "stream": true,
        });
        let result =
            translate_request(serde_json::to_vec(&body).unwrap().as_slice(), "gpt-5.5", false).unwrap();
        let translated: Value = serde_json::from_slice(&result).unwrap();

        assert_eq!(
            translated["instructions"],
            format!(
                "You are a helpful assistant\nKeep answers concise.\n\n{}",
                CLAUDE_CODE_OPENAI_ADAPTER
            )
        );
    }

    #[test]
    fn test_billing_header_only_prompt_uses_adapter_instruction() {
        let body = json!({
            "model": "claude-opus-4-6",
            "system": "x-anthropic-billing-header: cc_version=2.1.92.26f; cc_entrypoint=cli; cch=ce585;",
            "messages": [
                {"role": "user", "content": "Hello"}
            ],
            "stream": true,
        });
        let result =
            translate_request(serde_json::to_vec(&body).unwrap().as_slice(), "gpt-5.5", false).unwrap();
        let translated: Value = serde_json::from_slice(&result).unwrap();

        assert_eq!(translated["instructions"], CLAUDE_CODE_OPENAI_ADAPTER);
    }

    #[test]
    fn test_embedded_billing_header_line_is_removed() {
        let body = json!({
            "model": "claude-opus-4-6",
            "system": "You are a helpful assistant\nmetadata: x-anthropic-billing-header: cc_version=2.1.92.26f; cc_entrypoint=cli; cch=ce585;\nKeep answers concise.",
            "messages": [
                {"role": "user", "content": "Hello"}
            ],
            "stream": true,
        });
        let result =
            translate_request(serde_json::to_vec(&body).unwrap().as_slice(), "gpt-5.5", false).unwrap();
        let translated: Value = serde_json::from_slice(&result).unwrap();

        assert_eq!(
            translated["instructions"],
            format!(
                "You are a helpful assistant\nKeep answers concise.\n\n{}",
                CLAUDE_CODE_OPENAI_ADAPTER
            )
        );
    }

    #[test]
    fn test_tool_use_translation() {
        let body = json!({
            "model": "claude-opus-4-6",
            "max_tokens": 1024,
            "messages": [
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "t1", "name": "read_file", "input": {"path": "foo.txt"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "content": "file contents"}
                ]}
            ],
            "stream": true,
        });
        let result =
            translate_request(serde_json::to_vec(&body).unwrap().as_slice(), "gpt-5.5", false).unwrap();
        let translated: Value = serde_json::from_slice(&result).unwrap();
        // Assistant tool_use → top-level function_call
        assert_eq!(translated["input"][0]["type"], "function_call");
        assert_eq!(translated["input"][0]["call_id"], "t1");
        assert_eq!(translated["input"][0]["name"], "read_file");
        // User tool_result → top-level function_call_output
        assert_eq!(translated["input"][1]["type"], "function_call_output");
        assert_eq!(translated["input"][1]["call_id"], "t1");
        assert_eq!(translated["input"][1]["output"], "file contents");
    }

    #[test]
    fn test_tool_result_error_marker_is_preserved() {
        let body = json!({
            "model": "claude-opus-4-6",
            "messages": [
                {"role": "user", "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "t1",
                        "content": "Permission denied",
                        "is_error": true
                    }
                ]}
            ],
            "stream": true,
        });
        let result =
            translate_request(serde_json::to_vec(&body).unwrap().as_slice(), "gpt-5.5", false).unwrap();
        let translated: Value = serde_json::from_slice(&result).unwrap();

        assert_eq!(
            translated["input"][0]["output"],
            "[Tool error]\nPermission denied"
        );
    }

    #[test]
    fn test_fast_mode_maps_to_priority_service_tier() {
        let body = json!({
            "model": "claude-opus-4-6",
            "messages": [
                {"role": "user", "content": "Hello"}
            ],
            "speed": "fast",
            "stream": true,
        });
        let result =
            translate_request(serde_json::to_vec(&body).unwrap().as_slice(), "gpt-5.5", false).unwrap();
        let translated: Value = serde_json::from_slice(&result).unwrap();

        assert_eq!(translated["service_tier"], "priority");
    }

    #[test]
    fn test_assistant_messages_use_output_text_items() {
        let body = json!({
            "model": "claude-opus-4-6",
            "messages": [
                {"role": "assistant", "content": "Previous assistant reply"}
            ],
            "stream": true,
        });
        let result =
            translate_request(serde_json::to_vec(&body).unwrap().as_slice(), "gpt-5.5", false).unwrap();
        let translated: Value = serde_json::from_slice(&result).unwrap();

        assert_eq!(translated["input"][0]["role"], "assistant");
        assert_eq!(translated["input"][0]["content"][0]["type"], "output_text");
        assert_eq!(
            translated["input"][0]["content"][0]["text"],
            "Previous assistant reply"
        );
    }

    #[test]
    fn test_assistant_text_blocks_use_output_text_items() {
        let body = json!({
            "model": "claude-opus-4-6",
            "messages": [
                {"role": "assistant", "content": [
                    {"type": "text", "text": "First part. "},
                    {"type": "text", "text": "Second part."}
                ]}
            ],
            "stream": true,
        });
        let result =
            translate_request(serde_json::to_vec(&body).unwrap().as_slice(), "gpt-5.5", false).unwrap();
        let translated: Value = serde_json::from_slice(&result).unwrap();

        assert_eq!(translated["input"][0]["role"], "assistant");
        assert_eq!(translated["input"][0]["content"][0]["type"], "output_text");
        assert_eq!(
            translated["input"][0]["content"][0]["text"],
            "First part. Second part."
        );
    }

    #[test]
    fn test_image_translation() {
        let body = json!({
            "model": "claude-opus-4-6",
            "max_tokens": 1024,
            "messages": [
                {"role": "user", "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "abc123"}}
                ]}
            ],
            "stream": true,
        });
        let result =
            translate_request(serde_json::to_vec(&body).unwrap().as_slice(), "gpt-5.5", false).unwrap();
        let translated: Value = serde_json::from_slice(&result).unwrap();
        assert_eq!(translated["input"][0]["content"][0]["type"], "input_image");
        assert_eq!(
            translated["input"][0]["content"][0]["image_url"],
            "data:image/png;base64,abc123"
        );
    }

    #[test]
    fn test_reasoning_fields_are_mapped_when_supported() {
        let body = json!({
            "model": "claude-opus-4-6",
            "temperature": 0.2,
            "top_p": 0.9,
            "stop_sequences": ["STOP"],
            "output_config": { "effort": "max" },
            "thinking": { "budget_tokens": 32000 },
            "messages": [{"role": "user", "content": "test"}],
            "stream": true,
        });
        let result =
            translate_request(serde_json::to_vec(&body).unwrap().as_slice(), "gpt-5.5", false).unwrap();
        let translated: Value = serde_json::from_slice(&result).unwrap();

        assert!(translated.get("temperature").is_none());
        assert!(translated.get("top_p").is_none());
        assert!(translated.get("stop").is_none());
        assert_eq!(translated["reasoning"]["effort"], "xhigh");
    }

    #[test]
    fn test_thinking_defaults_to_medium_reasoning() {
        let body = json!({
            "model": "claude-opus-4-6",
            "thinking": { "budget_tokens": 32000 },
            "messages": [{"role": "user", "content": "test"}],
            "stream": true,
        });
        let result =
            translate_request(serde_json::to_vec(&body).unwrap().as_slice(), "gpt-5.5", false).unwrap();
        let translated: Value = serde_json::from_slice(&result).unwrap();

        assert_eq!(translated["reasoning"]["effort"], "medium");
    }

    #[test]
    fn test_tool_choice_uses_codex_field_name() {
        let body = json!({
            "model": "claude-opus-4-6",
            "tool_choice": { "type": "tool", "name": "write_file" },
            "messages": [{"role": "user", "content": "test"}],
            "stream": true,
        });
        let result =
            translate_request(serde_json::to_vec(&body).unwrap().as_slice(), "gpt-5.5", false).unwrap();
        let translated: Value = serde_json::from_slice(&result).unwrap();

        assert!(translated.get("toolChoice").is_none());
        assert_eq!(translated["tool_choice"]["type"], "function");
        assert_eq!(translated["tool_choice"]["name"], "write_file");
    }

    #[test]
    fn test_max_tokens_is_omitted_for_codex_backend() {
        let body = json!({
            "model": "claude-opus-4-6",
            "max_tokens": 1024,
            "messages": [{"role": "user", "content": "test"}],
            "stream": true,
        });
        let result =
            translate_request(serde_json::to_vec(&body).unwrap().as_slice(), "gpt-5.5", false).unwrap();
        let translated: Value = serde_json::from_slice(&result).unwrap();

        assert!(translated.get("max_tokens").is_none());
        assert!(translated.get("max_output_tokens").is_none());
    }
}

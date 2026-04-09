use super::types::anthropic_usage_json;
use serde_json::{json, Value};

/// Translate an OpenAI Codex response body into Anthropic Messages API format.
pub fn translate_response(body: &[u8], original_model: &str) -> Result<Vec<u8>, String> {
    let resp: Value = serde_json::from_slice(body)
        .map_err(|e| format!("Failed to parse Codex response: {e}"))?;

    let mut content: Vec<Value> = Vec::new();
    let mut stop_reason = "end_turn".to_string();

    // Process output items
    if let Some(output) = resp.get("output").and_then(|v| v.as_array()) {
        for item in output {
            match item.get("type").and_then(|v| v.as_str()) {
                Some("message") => {
                    if let Some(blocks) = item.get("content").and_then(|v| v.as_array()) {
                        for block in blocks {
                            if let Some("output_text") = block.get("type").and_then(|v| v.as_str()) {
                                if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                                    content.push(json!({"type": "text", "text": text}));
                                }
                            }
                        }
                    }
                }
                Some("function_call") => {
                    let call_id = item.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
                    let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let arguments = item.get("arguments").and_then(|v| v.as_str()).unwrap_or("{}");
                    let input: Value = serde_json::from_str(arguments).unwrap_or(json!({}));
                    content.push(json!({
                        "type": "tool_use",
                        "id": call_id,
                        "name": name,
                        "input": input,
                    }));
                    stop_reason = "tool_use".to_string();
                }
                _ => {}
            }
        }
    }

    // Map stop reason from status
    if let Some(status) = resp.get("status").and_then(|v| v.as_str()) {
        match status {
            "incomplete" => {
                if let Some(reason) = resp.get("incomplete_details")
                    .and_then(|v| v.get("reason"))
                    .and_then(|v| v.as_str())
                {
                    if reason == "max_output_tokens" {
                        stop_reason = "max_tokens".to_string();
                    }
                }
            }
            _ => {} // "completed" → keep existing stop_reason
        }
    }

    // Ensure content is non-empty
    if content.is_empty() {
        content.push(json!({"type": "text", "text": ""}));
    }

    // Build usage
    let usage = resp.get("usage").cloned().unwrap_or(json!({}));
    let input_tokens = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
    let output_tokens = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
    let service_tier = resp.get("service_tier").and_then(|v| v.as_str());

    let anthropic_resp = json!({
        "id": resp.get("id").and_then(|v| v.as_str()).unwrap_or("msg_codex"),
        "type": "message",
        "role": "assistant",
        "model": original_model,
        "content": content,
        "stop_reason": stop_reason,
        "stop_sequence": null,
        "usage": anthropic_usage_json(input_tokens, output_tokens, service_tier),
    });

    serde_json::to_vec(&anthropic_resp).map_err(|e| format!("Failed to serialize: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_text_response_translation() {
        let codex_resp = json!({
            "id": "resp_123",
            "output": [
                {"type": "message", "content": [
                    {"type": "output_text", "text": "Hello world"}
                ]}
            ],
            "usage": {"input_tokens": 10, "output_tokens": 5},
            "status": "completed",
        });
        let result = translate_response(
            serde_json::to_vec(&codex_resp).unwrap().as_slice(),
            "claude-opus-4-6",
        ).unwrap();
        let resp: Value = serde_json::from_slice(&result).unwrap();
        assert_eq!(resp["type"], "message");
        assert_eq!(resp["role"], "assistant");
        assert_eq!(resp["model"], "claude-opus-4-6");
        assert_eq!(resp["content"][0]["type"], "text");
        assert_eq!(resp["content"][0]["text"], "Hello world");
        assert_eq!(resp["stop_reason"], "end_turn");
        assert_eq!(resp["usage"]["input_tokens"], 10);
        assert_eq!(resp["usage"]["speed"], "standard");
    }

    #[test]
    fn test_tool_use_response_translation() {
        let codex_resp = json!({
            "id": "resp_456",
            "output": [
                {"type": "function_call", "call_id": "t1", "name": "read_file", "arguments": "{\"path\":\"test.txt\"}"}
            ],
            "usage": {"input_tokens": 20, "output_tokens": 10},
            "status": "completed",
        });
        let result = translate_response(
            serde_json::to_vec(&codex_resp).unwrap().as_slice(),
            "claude-opus-4-6",
        ).unwrap();
        let resp: Value = serde_json::from_slice(&result).unwrap();
        assert_eq!(resp["content"][0]["type"], "tool_use");
        assert_eq!(resp["content"][0]["name"], "read_file");
        assert_eq!(resp["content"][0]["input"]["path"], "test.txt");
        assert_eq!(resp["stop_reason"], "tool_use");
    }
}

use super::response_shape::{
    build_translation_summary, shape_function_calls, ResponseTranslationSummary,
};
use super::types::anthropic_usage_json;
use serde_json::{json, Value};

pub struct TranslatedResponse {
    pub body: Vec<u8>,
    pub summary: ResponseTranslationSummary,
}

pub fn translate_response_with_summary(
    body: &[u8],
    original_model: &str,
) -> Result<TranslatedResponse, String> {
    let resp: Value =
        serde_json::from_slice(body).map_err(|e| format!("Failed to parse Codex response: {e}"))?;

    let mut content: Vec<Value> = Vec::new();
    let mut stop_reason = "end_turn".to_string();
    let mut text_block_count = 0usize;
    let mut output_count = resp
        .get("output")
        .and_then(|v| v.as_array())
        .map(|output| output.len())
        .unwrap_or(0);
    let raw_function_calls = resp
        .get("output")
        .and_then(|v| v.as_array())
        .map(|output| {
            output
                .iter()
                .filter(|item| item.get("type").and_then(|v| v.as_str()) == Some("function_call"))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let shaped_tool_calls = shape_function_calls(&raw_function_calls);

    // Process output items
    if let Some(output) = resp.get("output").and_then(|v| v.as_array()) {
        let mut function_call_index = 0usize;

        for item in output {
            match item.get("type").and_then(|v| v.as_str()) {
                Some("message") => {
                    if let Some(blocks) = item.get("content").and_then(|v| v.as_array()) {
                        for block in blocks {
                            if let Some("output_text") = block.get("type").and_then(|v| v.as_str())
                            {
                                if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                                    content.push(json!({"type": "text", "text": text}));
                                    text_block_count += 1;
                                }
                            }
                        }
                    }
                }
                Some("function_call") => {
                    let decision = &shaped_tool_calls.decisions[function_call_index];
                    function_call_index += 1;
                    if decision.emit {
                        content.push(json!({
                            "type": "tool_use",
                            "id": decision.call.id,
                            "name": decision.call.name,
                            "input": decision.call.input,
                        }));
                    }
                }
                _ => {}
            }
        }
    }

    if text_block_count == 0 {
        if let Some(text) = extract_response_output_text(&resp) {
            content.push(json!({"type": "text", "text": text}));
            text_block_count += 1;
        }
    }

    if output_count == 0 && response_has_output_text(&resp) {
        output_count = 1;
    }

    if shaped_tool_calls.summary.emitted_tool_call_count > 0 {
        stop_reason = "tool_use".to_string();
    }

    // Map stop reason from status
    if let Some(status) = resp.get("status").and_then(|v| v.as_str()) {
        if status == "incomplete" {
            if let Some(reason) = resp
                .get("incomplete_details")
                .and_then(|v| v.get("reason"))
                .and_then(|v| v.as_str())
            {
                if reason == "max_output_tokens" || reason == "max_tokens" {
                    stop_reason = "max_tokens".to_string();
                }
            }
        }
    }

    // Ensure content is non-empty
    if content.is_empty() {
        content.push(json!({"type": "text", "text": ""}));
    }

    // Build usage
    let usage = resp.get("usage").cloned().unwrap_or(json!({}));
    let input_tokens = usage
        .get("input_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let output_tokens = usage
        .get("output_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
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

    let body =
        serde_json::to_vec(&anthropic_resp).map_err(|e| format!("Failed to serialize: {e}"))?;
    Ok(TranslatedResponse {
        body,
        summary: build_translation_summary(
            output_count,
            text_block_count,
            &shaped_tool_calls.summary,
            &stop_reason,
        ),
    })
}

fn extract_response_output_text(response: &Value) -> Option<String> {
    response
        .get("output_text")
        .and_then(|v| v.as_str())
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn response_has_output_text(response: &Value) -> bool {
    extract_response_output_text(response).is_some()
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
        let result = translate_response_with_summary(
            serde_json::to_vec(&codex_resp).unwrap().as_slice(),
            "claude-opus-4-6",
        )
        .unwrap();
        let resp: Value = serde_json::from_slice(&result.body).unwrap();
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
    fn test_top_level_output_text_response_translation() {
        let codex_resp = json!({
            "id": "resp_top_level_text",
            "output_text": "Hello from top-level output_text",
            "usage": {"input_tokens": 10, "output_tokens": 5},
            "status": "completed",
        });
        let result = translate_response_with_summary(
            serde_json::to_vec(&codex_resp).unwrap().as_slice(),
            "claude-opus-4-6",
        )
        .unwrap();
        let resp: Value = serde_json::from_slice(&result.body).unwrap();

        assert_eq!(resp["content"][0]["type"], "text");
        assert_eq!(
            resp["content"][0]["text"],
            "Hello from top-level output_text"
        );
        assert_eq!(result.summary.upstream_output_count, 1);
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
        let result = translate_response_with_summary(
            serde_json::to_vec(&codex_resp).unwrap().as_slice(),
            "claude-opus-4-6",
        )
        .unwrap();
        let resp: Value = serde_json::from_slice(&result.body).unwrap();
        assert_eq!(resp["content"][0]["type"], "tool_use");
        assert_eq!(resp["content"][0]["name"], "read_file");
        assert_eq!(resp["content"][0]["input"]["path"], "test.txt");
        assert_eq!(resp["stop_reason"], "tool_use");
    }

    #[test]
    fn test_incomplete_max_tokens_maps_to_anthropic_stop_reason() {
        let codex_resp = json!({
            "id": "resp_max_tokens",
            "output": [],
            "usage": {"input_tokens": 20, "output_tokens": 10},
            "status": "incomplete",
            "incomplete_details": {"reason": "max_tokens"},
        });
        let result = translate_response_with_summary(
            serde_json::to_vec(&codex_resp).unwrap().as_slice(),
            "claude-opus-4-6",
        )
        .unwrap();
        let resp: Value = serde_json::from_slice(&result.body).unwrap();

        assert_eq!(resp["stop_reason"], "max_tokens");
    }

    #[test]
    fn test_multi_function_call_worktree_agents_are_shaped() {
        let codex_resp = json!({
            "id": "resp_789",
            "output": [
                {"type": "function_call", "call_id": "agent-1", "name": "Agent", "arguments": "{\"task\":\"first\",\"isolation\":\"worktree\"}"},
                {"type": "function_call", "call_id": "agent-2", "name": "Agent", "arguments": "{\"task\":\"second\",\"isolation\":\"worktree\"}"},
                {"type": "function_call", "call_id": "read-1", "name": "read_file", "arguments": "{\"path\":\"README.md\"}"}
            ],
            "usage": {"input_tokens": 20, "output_tokens": 10},
            "status": "completed",
        });
        let translated = translate_response_with_summary(
            serde_json::to_vec(&codex_resp).unwrap().as_slice(),
            "claude-opus-4-6",
        )
        .unwrap();
        let resp: Value = serde_json::from_slice(&translated.body).unwrap();

        assert_eq!(resp["content"].as_array().unwrap().len(), 2);
        assert_eq!(resp["content"][0]["id"], "agent-1");
        assert_eq!(resp["content"][1]["id"], "read-1");
        assert_eq!(translated.summary.upstream_tool_call_count, 3);
        assert_eq!(translated.summary.emitted_tool_call_count, 2);
        assert_eq!(translated.summary.suppressed_tool_call_count, 1);
        assert_eq!(translated.summary.suppressed_tool_call_ids, vec!["agent-2"]);
        assert!(translated.summary.shaping_applied);
    }
}

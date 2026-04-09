use super::types::anthropic_usage_json;
use serde_json::{json, Value};

/// Format a single SSE event in Anthropic's streaming format.
pub fn format_sse_event(event_type: &str, data: &Value) -> Vec<u8> {
    format!("event: {event_type}\ndata: {data}\n\n").into_bytes()
}

/// State tracker for converting OpenAI Codex stream events to Anthropic SSE.
pub struct StreamTranslator {
    original_model: String,
    content_index: usize,
    text_started: bool,
    accumulated_text: String,
    function_calls: Vec<Value>,
    done: bool,
}

impl StreamTranslator {
    pub fn new(original_model: &str) -> Self {
        Self {
            original_model: original_model.to_string(),
            content_index: 0,
            text_started: false,
            accumulated_text: String::new(),
            function_calls: Vec::new(),
            done: false,
        }
    }

    /// Emit the initial message_start event.
    pub fn message_start(&self) -> Vec<u8> {
        format_sse_event("message_start", &json!({
            "type": "message_start",
            "message": {
                "id": "msg_codex",
                "type": "message",
                "role": "assistant",
                "model": self.original_model,
                "content": [],
                "stop_reason": null,
                "stop_sequence": null,
                "usage": anthropic_usage_json(0, 0, None),
            }
        }))
    }

    /// Process a single line from the OpenAI stream. Returns SSE bytes to emit (may be empty).
    pub fn process_line(&mut self, line: &str) -> Vec<u8> {
        if self.done { return Vec::new(); }

        let data = if let Some(stripped) = line.strip_prefix("data: ") {
            stripped.trim()
        } else {
            return Vec::new();
        };

        if data == "[DONE]" {
            self.done = true;
            return self.finalize();
        }

        let event: Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };

        let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match event_type {
            "response.output_text.delta" => {
                let delta = event.get("delta").and_then(|v| v.as_str()).unwrap_or("");
                if delta.is_empty() { return Vec::new(); }
                self.accumulated_text.push_str(delta);

                let mut output = Vec::new();

                if !self.text_started {
                    self.text_started = true;
                    output.extend_from_slice(&format_sse_event("content_block_start", &json!({
                        "type": "content_block_start",
                        "index": self.content_index,
                        "content_block": {"type": "text", "text": ""},
                    })));
                }

                output.extend_from_slice(&format_sse_event("content_block_delta", &json!({
                    "type": "content_block_delta",
                    "index": self.content_index,
                    "delta": {"type": "text_delta", "text": delta},
                })));

                output
            }
            "response.function_call_arguments.done" | "response.output_item.done" => {
                // Collect function calls for emission at finalize
                if let Some(item) = event.get("item") {
                    if item.get("type").and_then(|v| v.as_str()) == Some("function_call") {
                        self.function_calls.push(item.clone());
                    }
                }
                Vec::new()
            }
            "response.completed" => {
                // Extract function calls from the completed response
                if let Some(output) = event.get("response").and_then(|v| v.get("output")).and_then(|v| v.as_array()) {
                    for item in output {
                        if item.get("type").and_then(|v| v.as_str()) == Some("function_call") {
                            if !self.function_calls.iter().any(|fc|
                                fc.get("call_id") == item.get("call_id")
                            ) {
                                self.function_calls.push(item.clone());
                            }
                        }
                    }
                }
                self.done = true;

                // Extract usage from completed response
                let usage = event.get("response")
                    .and_then(|v| v.get("usage"))
                    .cloned()
                    .unwrap_or(json!({}));

                let service_tier = event.get("response")
                    .and_then(|v| v.get("service_tier"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string);

                self.finalize_with_usage(&usage, service_tier.as_deref())
            }
            _ => Vec::new(),
        }
    }

    fn finalize(&mut self) -> Vec<u8> {
        self.finalize_with_usage(&json!({}), None)
    }

    fn finalize_with_usage(&mut self, usage: &Value, service_tier: Option<&str>) -> Vec<u8> {
        let mut output = Vec::new();

        // Close text block if started
        if self.text_started {
            output.extend_from_slice(&format_sse_event("content_block_stop", &json!({
                "type": "content_block_stop",
                "index": self.content_index,
            })));
            self.content_index += 1;
        }

        // Emit tool use blocks
        let stop_reason = if self.function_calls.is_empty() { "end_turn" } else { "tool_use" };
        for fc in &self.function_calls {
            let call_id = fc.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
            let name = fc.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let arguments = fc.get("arguments").and_then(|v| v.as_str()).unwrap_or("{}");
            let input: Value = serde_json::from_str(arguments).unwrap_or(json!({}));

            output.extend_from_slice(&format_sse_event("content_block_start", &json!({
                "type": "content_block_start",
                "index": self.content_index,
                "content_block": {"type": "tool_use", "id": call_id, "name": name, "input": {}},
            })));
            output.extend_from_slice(&format_sse_event("content_block_delta", &json!({
                "type": "content_block_delta",
                "index": self.content_index,
                "delta": {"type": "input_json_delta", "partial_json": serde_json::to_string(&input).unwrap_or_default()},
            })));
            output.extend_from_slice(&format_sse_event("content_block_stop", &json!({
                "type": "content_block_stop",
                "index": self.content_index,
            })));
            self.content_index += 1;
        }

        let input_tokens = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let output_tokens = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);

        // message_delta with stop reason and final usage
        output.extend_from_slice(&format_sse_event("message_delta", &json!({
            "type": "message_delta",
            "delta": {"stop_reason": stop_reason, "stop_sequence": null},
            "usage": anthropic_usage_json(input_tokens, output_tokens, service_tier),
        })));

        // message_stop
        output.extend_from_slice(&format_sse_event("message_stop", &json!({
            "type": "message_stop",
        })));

        // If we want to include input token count, we'd need to emit it in message_start
        let _ = input_tokens; // acknowledged, included in message_start if re-emitted

        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stream_text_delta() {
        let mut t = StreamTranslator::new("claude-opus-4-6");
        let start = t.message_start();
        assert!(!start.is_empty());

        let output = t.process_line("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello\"}");
        let text = String::from_utf8_lossy(&output);
        assert!(text.contains("content_block_start"));
        assert!(text.contains("content_block_delta"));
        assert!(text.contains("Hello"));
    }

    #[test]
    fn test_stream_finalize() {
        let mut t = StreamTranslator::new("claude-opus-4-6");
        t.process_line("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}");
        let output = t.process_line("data: [DONE]");
        let text = String::from_utf8_lossy(&output);
        assert!(text.contains("content_block_stop"));
        assert!(text.contains("message_delta"));
        assert!(text.contains("end_turn"));
        assert!(text.contains("\"speed\":\"standard\""));
        assert!(text.contains("message_stop"));
    }
}

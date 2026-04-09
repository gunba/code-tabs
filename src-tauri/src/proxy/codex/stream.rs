use super::response_shape::{
    build_translation_summary, collect_function_calls, shape_function_calls,
    ResponseTranslationSummary,
};
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
    function_calls: Vec<Value>,
    upstream_output_count: usize,
    stop_reason_override: Option<String>,
    final_summary: Option<ResponseTranslationSummary>,
    done: bool,
}

impl StreamTranslator {
    pub fn new(original_model: &str) -> Self {
        Self {
            original_model: original_model.to_string(),
            content_index: 0,
            text_started: false,
            function_calls: Vec::new(),
            upstream_output_count: 0,
            stop_reason_override: None,
            final_summary: None,
            done: false,
        }
    }

    /// Emit the initial message_start event.
    pub fn message_start(&self) -> Vec<u8> {
        format_sse_event(
            "message_start",
            &json!({
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
            }),
        )
    }

    /// Process a single line from the OpenAI stream. Returns SSE bytes to emit (may be empty).
    pub fn process_line(&mut self, line: &str) -> Vec<u8> {
        if self.done {
            return Vec::new();
        }

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
                if delta.is_empty() {
                    return Vec::new();
                }

                let mut output = Vec::new();

                if !self.text_started {
                    self.text_started = true;
                    output.extend_from_slice(&format_sse_event(
                        "content_block_start",
                        &json!({
                            "type": "content_block_start",
                            "index": self.content_index,
                            "content_block": {"type": "text", "text": ""},
                        }),
                    ));
                }

                output.extend_from_slice(&format_sse_event(
                    "content_block_delta",
                    &json!({
                        "type": "content_block_delta",
                        "index": self.content_index,
                        "delta": {"type": "text_delta", "text": delta},
                    }),
                ));

                output
            }
            "response.function_call_arguments.done" | "response.output_item.done" => {
                // Collect function calls for emission at finalize
                if let Some(item) = event.get("item") {
                    if item.get("type").and_then(|v| v.as_str()) == Some("function_call") {
                        self.push_function_call(item.clone());
                    }
                }
                Vec::new()
            }
            "response.completed" => {
                let empty_response = json!({});
                let response = event.get("response").unwrap_or(&empty_response);

                if let Some(output) = event
                    .get("response")
                    .and_then(|v| v.get("output"))
                    .and_then(|v| v.as_array())
                {
                    self.upstream_output_count = output.len();
                    self.function_calls = collect_function_calls(output);
                }
                self.stop_reason_override = stop_reason_override(response);
                self.done = true;

                // Extract usage from completed response
                let usage = response.get("usage").cloned().unwrap_or(json!({}));

                let service_tier = response
                    .get("service_tier")
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
            output.extend_from_slice(&format_sse_event(
                "content_block_stop",
                &json!({
                    "type": "content_block_stop",
                    "index": self.content_index,
                }),
            ));
            self.content_index += 1;
        }

        let shaped_tool_calls = shape_function_calls(&self.function_calls);
        let stop_reason = self.stop_reason_override.clone().unwrap_or_else(|| {
            if shaped_tool_calls.summary.emitted_tool_call_count > 0 {
                "tool_use".to_string()
            } else {
                "end_turn".to_string()
            }
        });

        // Emit tool use blocks
        for call in shaped_tool_calls.emitted_calls() {
            output.extend_from_slice(&format_sse_event("content_block_start", &json!({
                "type": "content_block_start",
                "index": self.content_index,
                "content_block": {"type": "tool_use", "id": call.id, "name": call.name, "input": {}},
            })));
            output.extend_from_slice(&format_sse_event("content_block_delta", &json!({
                "type": "content_block_delta",
                "index": self.content_index,
                "delta": {"type": "input_json_delta", "partial_json": serde_json::to_string(&call.input).unwrap_or_default()},
            })));
            output.extend_from_slice(&format_sse_event(
                "content_block_stop",
                &json!({
                    "type": "content_block_stop",
                    "index": self.content_index,
                }),
            ));
            self.content_index += 1;
        }

        let input_tokens = usage
            .get("input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let output_tokens = usage
            .get("output_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        // message_delta with stop reason and final usage
        output.extend_from_slice(&format_sse_event(
            "message_delta",
            &json!({
                "type": "message_delta",
                "delta": {"stop_reason": stop_reason, "stop_sequence": null},
                "usage": anthropic_usage_json(input_tokens, output_tokens, service_tier),
            }),
        ));

        // message_stop
        output.extend_from_slice(&format_sse_event(
            "message_stop",
            &json!({
                "type": "message_stop",
            }),
        ));

        // If we want to include input token count, we'd need to emit it in message_start
        let _ = input_tokens; // acknowledged, included in message_start if re-emitted

        self.final_summary = Some(build_translation_summary(
            if self.upstream_output_count > 0 {
                self.upstream_output_count
            } else {
                self.function_calls.len() + usize::from(self.text_started)
            },
            usize::from(self.text_started),
            &shaped_tool_calls.summary,
            &stop_reason,
        ));

        output
    }

    pub fn final_summary(&self) -> Option<&ResponseTranslationSummary> {
        self.final_summary.as_ref()
    }

    pub fn is_done(&self) -> bool {
        self.done
    }

    fn push_function_call(&mut self, item: Value) {
        let call_id = item.get("call_id");
        if !self
            .function_calls
            .iter()
            .any(|existing| existing.get("call_id") == call_id)
        {
            self.function_calls.push(item);
        }
    }
}

fn stop_reason_override(response: &Value) -> Option<String> {
    if response.get("status").and_then(|v| v.as_str()) == Some("incomplete") {
        if response
            .get("incomplete_details")
            .and_then(|v| v.get("reason"))
            .and_then(|v| v.as_str())
            == Some("max_output_tokens")
        {
            return Some("max_tokens".to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stream_text_delta() {
        let mut t = StreamTranslator::new("claude-opus-4-6");
        let start = t.message_start();
        assert!(!start.is_empty());

        let output =
            t.process_line("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello\"}");
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

    #[test]
    fn test_stream_finalize_shapes_extra_worktree_agents() {
        let mut t = StreamTranslator::new("claude-opus-4-6");
        let output = t.process_line(
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5},\"output\":[{\"type\":\"function_call\",\"call_id\":\"agent-1\",\"name\":\"Agent\",\"arguments\":\"{\\\"task\\\":\\\"first\\\",\\\"isolation\\\":\\\"worktree\\\"}\"},{\"type\":\"function_call\",\"call_id\":\"agent-2\",\"name\":\"Agent\",\"arguments\":\"{\\\"task\\\":\\\"second\\\",\\\"isolation\\\":\\\"worktree\\\"}\"},{\"type\":\"function_call\",\"call_id\":\"read-1\",\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"README.md\\\"}\"}]}}"
        );
        let text = String::from_utf8_lossy(&output);

        assert!(text.contains("agent-1"));
        assert!(text.contains("read-1"));
        assert!(!text.contains("agent-2"));

        let summary = t.final_summary().unwrap();
        assert_eq!(summary.upstream_tool_call_count, 3);
        assert_eq!(summary.emitted_tool_call_count, 2);
        assert_eq!(summary.suppressed_tool_call_ids, vec!["agent-2"]);
        assert!(summary.shaping_applied);
    }

    #[test]
    fn test_stream_and_non_stream_summaries_match_for_shaped_calls() {
        let codex_resp = json!({
            "id": "resp_stream_parity",
            "output": [
                {"type": "function_call", "call_id": "agent-1", "name": "Agent", "arguments": "{\"task\":\"first\",\"isolation\":\"worktree\"}"},
                {"type": "function_call", "call_id": "agent-2", "name": "Agent", "arguments": "{\"task\":\"second\",\"isolation\":\"worktree\"}"},
                {"type": "function_call", "call_id": "read-1", "name": "read_file", "arguments": "{\"path\":\"README.md\"}"}
            ],
            "usage": {"input_tokens": 10, "output_tokens": 5},
            "status": "completed",
        });
        let mut t = StreamTranslator::new("claude-opus-4-6");
        let stream_event = format!(
            "data: {}",
            json!({
                "type": "response.completed",
                "response": codex_resp.clone(),
            })
        );
        t.process_line(&stream_event);

        let non_stream_summary =
            crate::proxy::codex::translate_resp::translate_response_with_summary(
                serde_json::to_vec(&codex_resp).unwrap().as_slice(),
                "claude-opus-4-6",
            )
            .unwrap()
            .summary;
        let stream_summary = t.final_summary().unwrap();

        assert_eq!(
            stream_summary.upstream_tool_call_count,
            non_stream_summary.upstream_tool_call_count
        );
        assert_eq!(
            stream_summary.emitted_tool_call_count,
            non_stream_summary.emitted_tool_call_count
        );
        assert_eq!(
            stream_summary.suppressed_tool_call_ids,
            non_stream_summary.suppressed_tool_call_ids
        );
        assert_eq!(stream_summary.stop_reason, non_stream_summary.stop_reason);
        assert_eq!(
            stream_summary.shaping_applied,
            non_stream_summary.shaping_applied
        );
    }
}

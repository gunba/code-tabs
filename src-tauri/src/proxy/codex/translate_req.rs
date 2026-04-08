use serde_json::{json, Value};

/// Translate an Anthropic Messages API request body into an OpenAI Codex request body.
pub fn translate_request(body: &[u8], codex_model: &str) -> Result<Vec<u8>, String> {
    let req: Value = serde_json::from_slice(body)
        .map_err(|e| format!("Failed to parse request: {e}"))?;

    let mut codex_req = json!({
        "model": codex_model,
        "stream": req.get("stream").and_then(|v| v.as_bool()).unwrap_or(true),
        "store": false,
    });

    // system → instructions
    if let Some(system) = req.get("system") {
        let instructions = extract_system_text(system);
        if !instructions.is_empty() {
            codex_req["instructions"] = json!(instructions);
        }
    }

    // max_tokens → maxOutputTokens
    if let Some(mt) = req.get("max_tokens").and_then(|v| v.as_u64()) {
        codex_req["maxOutputTokens"] = json!(mt);
    }

    // Passthrough fields
    if let Some(t) = req.get("temperature") { codex_req["temperature"] = t.clone(); }
    if let Some(t) = req.get("top_p") { codex_req["top_p"] = t.clone(); }
    if let Some(ss) = req.get("stop_sequences") { codex_req["stop"] = ss.clone(); }

    // output_config.effort → reasoning.effort
    // Claude: low/medium/high/max → OpenAI: low/medium/high/xhigh
    if let Some(oc) = req.get("output_config") {
        if let Some(effort) = oc.get("effort").and_then(|v| v.as_str()) {
            let oai_effort = match effort {
                "low" => "low",
                "medium" => "medium",
                "high" => "high",
                "max" => "xhigh",
                _ => "high",
            };
            codex_req["reasoning"] = json!({ "effort": oai_effort });
        }
    }
    // Fallback: thinking.budget_tokens → reasoning.effort (older models)
    if codex_req.get("reasoning").is_none() {
        if let Some(thinking) = req.get("thinking") {
            if let Some(budget) = thinking.get("budget_tokens").and_then(|v| v.as_u64()) {
                let effort = match budget {
                    0..=2048 => "low",
                    2049..=8192 => "medium",
                    2049..=32768 => "high",
                    _ => "xhigh",
                };
                codex_req["reasoning"] = json!({ "effort": effort });
            }
        }
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
        codex_req["toolChoice"] = translate_tool_choice(tc);
    }

    // messages → input
    if let Some(messages) = req.get("messages").and_then(|v| v.as_array()) {
        let input: Vec<Value> = messages.iter().map(translate_message).collect();
        codex_req["input"] = json!(input);
    }

    serde_json::to_vec(&codex_req).map_err(|e| format!("Failed to serialize: {e}"))
}

fn extract_system_text(system: &Value) -> String {
    match system {
        Value::String(s) => s.clone(),
        Value::Array(arr) => {
            arr.iter()
                .filter_map(|block| block.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        }
        _ => String::new(),
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

fn translate_message(msg: &Value) -> Value {
    let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("user");

    // If content is a simple string, pass through
    if let Some(text) = msg.get("content").and_then(|v| v.as_str()) {
        return json!({"role": role, "content": text});
    }

    // Content is an array of blocks
    if let Some(blocks) = msg.get("content").and_then(|v| v.as_array()) {
        let translated: Vec<Value> = blocks.iter().filter_map(translate_content_block).collect();
        return json!({"role": role, "content": translated});
    }

    json!({"role": role, "content": ""})
}

fn translate_content_block(block: &Value) -> Option<Value> {
    let block_type = block.get("type").and_then(|v| v.as_str())?;
    match block_type {
        "text" => {
            Some(json!({"type": "text", "text": block.get("text").and_then(|v| v.as_str()).unwrap_or("")}))
        }
        "tool_use" => {
            let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let input = block.get("input").cloned().unwrap_or(json!({}));
            let arguments = serde_json::to_string(&input).unwrap_or_default();
            Some(json!({
                "type": "function_call",
                "call_id": id,
                "name": name,
                "arguments": arguments,
            }))
        }
        "tool_result" => {
            let tool_use_id = block.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("");
            let output = extract_tool_result_text(block);
            Some(json!({
                "type": "function_call_output",
                "call_id": tool_use_id,
                "output": output,
            }))
        }
        "image" => {
            // Anthropic image → OpenAI input_image
            if let Some(source) = block.get("source") {
                let source_type = source.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match source_type {
                    "base64" => {
                        let media_type = source.get("media_type").and_then(|v| v.as_str()).unwrap_or("image/png");
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
            } else {
                None
            }
        }
        _ => {
            // Unknown block type — pass through as text if it has text content
            block.get("text").and_then(|v| v.as_str()).map(|text| {
                json!({"type": "text", "text": text})
            })
        }
    }
}

fn extract_tool_result_text(block: &Value) -> String {
    if let Some(content) = block.get("content") {
        match content {
            Value::String(s) => return s.clone(),
            Value::Array(arr) => {
                return arr.iter()
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
        let result = translate_request(
            serde_json::to_vec(&body).unwrap().as_slice(),
            "gpt-5.4",
        ).unwrap();
        let translated: Value = serde_json::from_slice(&result).unwrap();
        assert_eq!(translated["model"], "gpt-5.4");
        assert_eq!(translated["instructions"], "You are a helpful assistant");
        assert_eq!(translated["maxOutputTokens"], 4096);
        assert_eq!(translated["stream"], true);
        assert_eq!(translated["input"][0]["role"], "user");
        assert_eq!(translated["input"][0]["content"], "Hello");
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
        let result = translate_request(
            serde_json::to_vec(&body).unwrap().as_slice(),
            "gpt-5.4",
        ).unwrap();
        let translated: Value = serde_json::from_slice(&result).unwrap();
        assert_eq!(translated["input"][0]["content"][0]["type"], "function_call");
        assert_eq!(translated["input"][0]["content"][0]["call_id"], "t1");
        assert_eq!(translated["input"][1]["content"][0]["type"], "function_call_output");
        assert_eq!(translated["input"][1]["content"][0]["call_id"], "t1");
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
        let result = translate_request(
            serde_json::to_vec(&body).unwrap().as_slice(),
            "gpt-5.4",
        ).unwrap();
        let translated: Value = serde_json::from_slice(&result).unwrap();
        assert_eq!(translated["input"][0]["content"][0]["type"], "input_image");
        assert_eq!(translated["input"][0]["content"][0]["image_url"], "data:image/png;base64,abc123");
    }

    #[test]
    fn test_effort_mapping() {
        for (claude_effort, oai_effort) in [("low", "low"), ("medium", "medium"), ("high", "high"), ("max", "xhigh")] {
            let body = json!({
                "model": "claude-opus-4-6",
                "max_tokens": 1024,
                "output_config": { "effort": claude_effort },
                "messages": [{"role": "user", "content": "test"}],
                "stream": true,
            });
            let result = translate_request(serde_json::to_vec(&body).unwrap().as_slice(), "gpt-5.4").unwrap();
            let translated: Value = serde_json::from_slice(&result).unwrap();
            assert_eq!(translated["reasoning"]["effort"], oai_effort, "effort {claude_effort} should map to {oai_effort}");
        }
    }
}

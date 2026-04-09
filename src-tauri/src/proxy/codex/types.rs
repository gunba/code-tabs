use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// ── OpenAI Codex request types ──────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRequest {
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    pub input: Vec<CodexMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<CodexTool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop: Option<Vec<String>>,
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<CodexReasoning>,
}

#[derive(Debug, Serialize)]
pub struct CodexMessage {
    pub role: String,
    pub content: Value,
}

#[derive(Debug, Serialize)]
pub struct CodexTool {
    #[serde(rename = "type")]
    pub tool_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<Value>,
}

#[derive(Debug, Serialize)]
pub struct CodexReasoning {
    pub effort: String,
}

// ── OpenAI Codex response types ─────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CodexResponse {
    pub id: Option<String>,
    pub model: Option<String>,
    pub output: Option<Vec<CodexOutputItem>>,
    pub usage: Option<CodexUsage>,
    pub status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum CodexOutputItem {
    #[serde(rename = "message")]
    Message {
        role: Option<String>,
        content: Option<Vec<CodexContentBlock>>,
    },
    #[serde(rename = "function_call")]
    FunctionCall {
        call_id: Option<String>,
        name: Option<String>,
        arguments: Option<String>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum CodexContentBlock {
    #[serde(rename = "output_text")]
    OutputText { text: Option<String> },
}

#[derive(Debug, Deserialize)]
pub struct CodexUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

// ── Streaming event types ───────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CodexStreamEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(flatten)]
    pub data: Value,
}

pub fn anthropic_usage_json(input_tokens: u64, output_tokens: u64, service_tier: Option<&str>) -> Value {
    json!({
        "input_tokens": input_tokens,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
        "output_tokens": output_tokens,
        "server_tool_use": {
            "web_search_requests": 0,
            "web_fetch_requests": 0,
        },
        "service_tier": service_tier.unwrap_or("standard"),
        "cache_creation": {
            "ephemeral_1h_input_tokens": 0,
            "ephemeral_5m_input_tokens": 0,
        },
        "inference_geo": "",
        "iterations": [],
        "speed": "standard",
    })
}

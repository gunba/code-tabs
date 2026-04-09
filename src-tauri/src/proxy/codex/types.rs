use serde_json::{json, Value};

pub fn anthropic_usage_json(
    input_tokens: u64,
    output_tokens: u64,
    service_tier: Option<&str>,
) -> Value {
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

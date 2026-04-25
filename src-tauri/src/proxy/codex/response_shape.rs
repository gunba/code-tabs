use serde::Serialize;
use serde_json::{json, Value};

const WORKTREE_AGENT_SHAPING_POLICY: &str = "suppress_additional_worktree_agent_calls";
// [PR-04] Codex Read tool calls with explicitly excessive limits are clamped
// before they are emitted back to Claude Code as tool_use blocks.
const READ_LIMIT_SHAPING_POLICY: &str = "clamp_read_limits";
const MAX_EXPLICIT_READ_LIMIT: u64 = 2_000;

#[derive(Debug, Clone)]
pub struct ToolCallEmission {
    pub id: String,
    pub name: String,
    pub input: Value,
    is_worktree_agent: bool,
    is_adjusted: bool,
}

impl ToolCallEmission {
    fn from_output_item(item: &Value, _original_model: &str) -> Self {
        let call_id = item
            .get("call_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let arguments = item
            .get("arguments")
            .and_then(|v| v.as_str())
            .unwrap_or("{}");
        let mut input: Value = serde_json::from_str(arguments).unwrap_or_else(|_| json!({}));
        let is_worktree_agent = name.eq_ignore_ascii_case("agent")
            && input.get("isolation").and_then(|v| v.as_str()) == Some("worktree");
        let is_adjusted = normalize_read_limit(&name, &mut input);

        Self {
            id: call_id,
            name,
            input,
            is_worktree_agent,
            is_adjusted,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ToolCallDecision {
    pub emit: bool,
    pub call: ToolCallEmission,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallShapeSummary {
    pub upstream_tool_call_count: usize,
    pub emitted_tool_call_count: usize,
    pub suppressed_tool_call_count: usize,
    pub adjusted_tool_call_count: usize,
    pub emitted_tool_call_ids: Vec<String>,
    pub suppressed_tool_call_ids: Vec<String>,
    pub adjusted_tool_call_ids: Vec<String>,
    pub shaping_applied: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shaping_policy: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ShapedToolCalls {
    pub decisions: Vec<ToolCallDecision>,
    pub summary: ToolCallShapeSummary,
}

impl ShapedToolCalls {
    pub fn emitted_calls(&self) -> impl Iterator<Item = &ToolCallEmission> {
        self.decisions
            .iter()
            .filter(|decision| decision.emit)
            .map(|decision| &decision.call)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResponseTranslationSummary {
    pub upstream_output_count: usize,
    pub text_block_count: usize,
    pub upstream_tool_call_count: usize,
    pub emitted_tool_call_count: usize,
    pub suppressed_tool_call_count: usize,
    pub adjusted_tool_call_count: usize,
    pub emitted_tool_call_ids: Vec<String>,
    pub suppressed_tool_call_ids: Vec<String>,
    pub adjusted_tool_call_ids: Vec<String>,
    pub stop_reason: String,
    pub shaping_applied: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shaping_policy: Option<String>,
}

fn should_normalize_read_limit(input: &Value) -> bool {
    !input
        .get("pages")
        .and_then(|v| v.as_str())
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn normalize_read_limit(name: &str, input: &mut Value) -> bool {
    if !name.eq_ignore_ascii_case("Read") || !should_normalize_read_limit(input) {
        return false;
    }

    let current_limit = input.get("limit").and_then(|v| v.as_u64());
    let Some(current_limit) = current_limit else {
        return false;
    };
    if current_limit <= MAX_EXPLICIT_READ_LIMIT {
        return false;
    }

    let Some(obj) = input.as_object_mut() else {
        return false;
    };
    obj.insert("limit".to_string(), json!(MAX_EXPLICIT_READ_LIMIT));
    true
}

pub fn collect_function_calls(output: &[Value]) -> Vec<Value> {
    output
        .iter()
        .filter(|item| item.get("type").and_then(|v| v.as_str()) == Some("function_call"))
        .cloned()
        .collect()
}

pub fn shape_function_calls(function_calls: &[Value], original_model: &str) -> ShapedToolCalls {
    let calls: Vec<ToolCallEmission> = function_calls
        .iter()
        .map(|item| ToolCallEmission::from_output_item(item, original_model))
        .collect();
    let worktree_agent_count = calls.iter().filter(|call| call.is_worktree_agent).count();
    let suppress_extra_worktree_agents = worktree_agent_count > 1;

    let mut decisions = Vec::with_capacity(calls.len());
    let mut emitted_tool_call_ids = Vec::new();
    let mut suppressed_tool_call_ids = Vec::new();
    let mut adjusted_tool_call_ids = Vec::new();
    let mut seen_worktree_agent = false;

    for call in calls {
        if call.is_adjusted {
            adjusted_tool_call_ids.push(call.id.clone());
        }
        let emit = if suppress_extra_worktree_agents && call.is_worktree_agent {
            if seen_worktree_agent {
                false
            } else {
                seen_worktree_agent = true;
                true
            }
        } else {
            true
        };

        if emit {
            emitted_tool_call_ids.push(call.id.clone());
        } else {
            suppressed_tool_call_ids.push(call.id.clone());
        }

        decisions.push(ToolCallDecision { emit, call });
    }

    let suppressed_tool_call_count = suppressed_tool_call_ids.len();
    let adjusted_tool_call_count = adjusted_tool_call_ids.len();
    let mut shaping_policies = Vec::new();
    if suppressed_tool_call_count > 0 {
        shaping_policies.push(WORKTREE_AGENT_SHAPING_POLICY);
    }
    if adjusted_tool_call_count > 0 {
        shaping_policies.push(READ_LIMIT_SHAPING_POLICY);
    }
    let summary = ToolCallShapeSummary {
        upstream_tool_call_count: decisions.len(),
        emitted_tool_call_count: decisions.iter().filter(|decision| decision.emit).count(),
        suppressed_tool_call_count,
        adjusted_tool_call_count,
        emitted_tool_call_ids,
        suppressed_tool_call_ids,
        adjusted_tool_call_ids,
        shaping_applied: suppressed_tool_call_count > 0 || adjusted_tool_call_count > 0,
        shaping_policy: if shaping_policies.is_empty() {
            None
        } else {
            Some(shaping_policies.join("+"))
        },
    };

    ShapedToolCalls { decisions, summary }
}

pub fn build_translation_summary(
    upstream_output_count: usize,
    text_block_count: usize,
    tool_summary: &ToolCallShapeSummary,
    stop_reason: &str,
) -> ResponseTranslationSummary {
    ResponseTranslationSummary {
        upstream_output_count,
        text_block_count,
        upstream_tool_call_count: tool_summary.upstream_tool_call_count,
        emitted_tool_call_count: tool_summary.emitted_tool_call_count,
        suppressed_tool_call_count: tool_summary.suppressed_tool_call_count,
        adjusted_tool_call_count: tool_summary.adjusted_tool_call_count,
        emitted_tool_call_ids: tool_summary.emitted_tool_call_ids.clone(),
        suppressed_tool_call_ids: tool_summary.suppressed_tool_call_ids.clone(),
        adjusted_tool_call_ids: tool_summary.adjusted_tool_call_ids.clone(),
        stop_reason: stop_reason.to_string(),
        shaping_applied: tool_summary.shaping_applied,
        shaping_policy: tool_summary.shaping_policy.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shape_function_calls_suppresses_only_extra_worktree_agents() {
        let calls = vec![
            json!({
                "type": "function_call",
                "call_id": "agent-1",
                "name": "Agent",
                "arguments": "{\"task\":\"first\",\"isolation\":\"worktree\"}",
            }),
            json!({
                "type": "function_call",
                "call_id": "read-1",
                "name": "read_file",
                "arguments": "{\"path\":\"README.md\"}",
            }),
            json!({
                "type": "function_call",
                "call_id": "agent-2",
                "name": "Agent",
                "arguments": "{\"task\":\"second\",\"isolation\":\"worktree\"}",
            }),
        ];

        let shaped = shape_function_calls(&calls, "claude-opus-4-6");

        assert_eq!(
            shaped
                .emitted_calls()
                .map(|call| call.id.as_str())
                .collect::<Vec<_>>(),
            vec!["agent-1", "read-1"]
        );
        assert_eq!(shaped.summary.upstream_tool_call_count, 3);
        assert_eq!(shaped.summary.emitted_tool_call_count, 2);
        assert_eq!(shaped.summary.suppressed_tool_call_count, 1);
        assert_eq!(shaped.summary.adjusted_tool_call_count, 0);
        assert_eq!(shaped.summary.suppressed_tool_call_ids, vec!["agent-2"]);
        assert!(shaped.summary.shaping_applied);
    }

    #[test]
    fn test_shape_function_calls_preserves_reasonable_explicit_read_limits() {
        let calls = vec![json!({
            "type": "function_call",
            "call_id": "read-1",
            "name": "Read",
            "arguments": "{\"file_path\":\"README.md\",\"limit\":900,\"offset\":1,\"pages\":\"\"}",
        })];

        let shaped = shape_function_calls(&calls, "sonnet");

        assert_eq!(shaped.decisions[0].call.input["limit"], 900);
        assert_eq!(shaped.summary.adjusted_tool_call_count, 0);
    }

    #[test]
    fn test_shape_function_calls_clamps_excessive_explicit_read_limits() {
        let calls = vec![json!({
            "type": "function_call",
            "call_id": "read-1",
            "name": "Read",
            "arguments": "{\"file_path\":\"README.md\",\"limit\":5000,\"offset\":1,\"pages\":\"\"}",
        })];

        let shaped = shape_function_calls(&calls, "sonnet");

        assert_eq!(shaped.decisions[0].call.input["limit"], 2_000);
        assert_eq!(shaped.summary.adjusted_tool_call_ids, vec!["read-1"]);
        assert_eq!(
            shaped.summary.shaping_policy.as_deref(),
            Some(READ_LIMIT_SHAPING_POLICY)
        );
    }

    #[test]
    fn test_shape_function_calls_preserves_missing_read_limit() {
        let calls = vec![json!({
            "type": "function_call",
            "call_id": "read-1",
            "name": "Read",
            "arguments": "{\"file_path\":\"README.md\",\"offset\":1,\"pages\":\"\"}",
        })];

        let shaped = shape_function_calls(&calls, "haiku");

        assert!(shaped.decisions[0].call.input.get("limit").is_none());
        assert_eq!(shaped.summary.adjusted_tool_call_count, 0);
    }
}

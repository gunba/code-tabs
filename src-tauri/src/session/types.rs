use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CliKind {
    Claude,
    Codex,
}

impl Default for CliKind {
    fn default() -> Self {
        CliKind::Claude
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    Starting,
    Idle,
    Thinking,
    ToolUse,
    WaitingPermission,
    Error,
    Dead,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    Default,
    AcceptEdits,
    BypassPermissions,
    DontAsk,
    PlanMode,
    Auto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfig {
    pub working_dir: String,
    // [ST-01] launch_working_dir: directory at session launch; working_dir may change via worktree events
    #[serde(default)]
    pub launch_working_dir: Option<String>,
    /// Which CLI this session runs. Defaults to Claude for migrated sessions.
    // [CC-04] cli: CliKind field on SessionConfig; serde(default) -> Claude; replaces providerId
    #[serde(default)]
    pub cli: CliKind,
    pub model: Option<String>,
    pub permission_mode: PermissionMode,
    /// Codex `--sandbox` selection (`read-only` | `workspace-write` | `danger-full-access`).
    /// None = leave Codex default. Claude sessions ignore this field.
    #[serde(default)]
    pub codex_sandbox_mode: Option<String>,
    /// Codex `--ask-for-approval` selection (`untrusted` | `on-request` | `never`).
    /// None = leave Codex default. Claude sessions ignore this field.
    #[serde(default)]
    pub codex_approval_policy: Option<String>,
    pub dangerously_skip_permissions: bool,
    pub system_prompt: Option<String>,
    pub append_system_prompt: Option<String>,
    pub allowed_tools: Vec<String>,
    pub disallowed_tools: Vec<String>,
    pub additional_dirs: Vec<String>,
    pub mcp_config: Option<String>,
    pub agent: Option<String>,
    pub effort: Option<String>,
    pub verbose: bool,
    pub debug: bool,
    pub max_budget: Option<f64>,
    pub resume_session: Option<String>,
    pub fork_session: bool,
    pub continue_session: bool,
    #[serde(default)]
    pub project_dir: bool,
    pub extra_flags: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub run_mode: bool,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            working_dir: String::new(),
            launch_working_dir: None,
            cli: CliKind::Claude,
            model: None,
            permission_mode: PermissionMode::Default,
            codex_sandbox_mode: None,
            codex_approval_policy: None,
            dangerously_skip_permissions: false,
            system_prompt: None,
            append_system_prompt: None,
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            additional_dirs: Vec::new(),
            mcp_config: None,
            agent: None,
            effort: None,
            verbose: false,
            debug: false,
            max_budget: None,
            resume_session: None,
            fork_session: false,
            continue_session: false,
            project_dir: false,
            extra_flags: None,
            session_id: None,
            run_mode: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    pub cost_usd: f64,
    pub context_percent: f64,
    pub duration_secs: u64,
    pub current_action: Option<String>,
    pub subagent_count: u32,
    pub task_progress: Option<String>,
    pub node_summary: Option<String>,
    pub context_warning: Option<String>,
    #[serde(default)]
    pub recent_output: String,
    #[serde(default)]
    pub subagent_activity: Vec<String>,
    #[serde(default)]
    pub current_tool_name: Option<String>,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub assistant_message_count: u64,
    #[serde(default)]
    pub choice_hint: bool,
    #[serde(default)]
    pub runtime_model: Option<String>,
}

impl Default for SessionMetadata {
    fn default() -> Self {
        Self {
            cost_usd: 0.0,
            context_percent: 0.0,
            duration_secs: 0,
            current_action: None,
            subagent_count: 0,
            task_progress: None,
            node_summary: None,
            context_warning: None,
            recent_output: String::new(),
            subagent_activity: Vec::new(),
            current_tool_name: None,
            input_tokens: 0,
            output_tokens: 0,
            assistant_message_count: 0,
            choice_hint: false,
            runtime_model: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub name: String,
    pub config: SessionConfig,
    pub state: SessionState,
    pub metadata: SessionMetadata,
    pub created_at: DateTime<Utc>,
    pub last_active: DateTime<Utc>,
}

impl Session {
    pub fn new(id: String, name: String, config: SessionConfig) -> Self {
        let now = Utc::now();
        Self {
            id,
            name,
            config,
            state: SessionState::Starting,
            metadata: SessionMetadata::default(),
            created_at: now,
            last_active: now,
        }
    }
}

/// Serializable snapshot for persistence (no runtime handles)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub id: String,
    pub name: String,
    pub config: SessionConfig,
    pub state: SessionState,
    pub metadata: SessionMetadata,
    pub created_at: DateTime<Utc>,
    pub last_active: DateTime<Utc>,
}

impl From<&Session> for SessionSnapshot {
    fn from(s: &Session) -> Self {
        Self {
            id: s.id.clone(),
            name: s.name.clone(),
            config: s.config.clone(),
            state: s.state.clone(),
            metadata: s.metadata.clone(),
            created_at: s.created_at,
            last_active: s.last_active,
        }
    }
}

// ── System-prompt rule (used by the slimmed proxy + PromptsTab) ────

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPromptRule {
    pub id: String,
    pub name: String,
    pub pattern: String,
    pub replacement: String,
    pub flags: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

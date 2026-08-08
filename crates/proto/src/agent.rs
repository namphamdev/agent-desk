//! Agent-side wire types: harness identity, run requests, streaming events, tool calls.

use serde::{Deserialize, Serialize};
use crate::providers::CustomProviderFormat;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HarnessId {
    ClaudeCode,
    Codex,
    /// Any Agent Client Protocol compatible CLI configured on this device.
    Acp,
    Cursor,
    /// Test harness; never shown in production pickers.
    Mock,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningLevel {
    Minimal,
    Low,
    Medium,
    High,
    XHigh,
    Max,
    Ultra,
    /// xhigh + harness-specific setting.
    Ultracode,
    /// Prompt-prefix driven (Claude).
    Ultrathink,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxLevel {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

/// User-facing permission policy shared by every harness.
///
/// Harness adapters translate these portable intents into their native
/// permission and sandbox settings.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    #[default]
    Default,
    Plan,
    AcceptEdits,
    FullAccess,
}

impl PermissionMode {
    pub fn sandbox(self) -> SandboxLevel {
        match self {
            Self::Plan => SandboxLevel::ReadOnly,
            Self::Default | Self::AcceptEdits => SandboxLevel::WorkspaceWrite,
            Self::FullAccess => SandboxLevel::DangerFullAccess,
        }
    }

    pub fn auto_approve(self) -> bool {
        matches!(self, Self::AcceptEdits | Self::FullAccess)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SteeringMode {
    /// Steer delivered at the next step boundary within the live turn.
    StepBoundary,
    /// Steer delivered only between turns.
    TurnBoundary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub label: String,
    /// Short tagline rendered under the name in the model picker (11px muted),
    /// mirroring the Electron app's `ModelInfo.description`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub reasoning_levels: Vec<ReasoningLevel>,
    #[serde(default)]
    pub options: Vec<ModelOption>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub label: String,
    pub choices: Vec<ModelOptionChoice>,
    pub default_choice: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOptionChoice {
    pub id: String,
    pub label: String,
}

/// Connection details for a custom provider, carried in a `RunRequest` so the
/// harness can inject provider-specific env vars into the spawned agent
/// subprocess. The API key is filled at run time from device-local encrypted
/// storage and never persists in session state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderEnv {
    /// Provider id (e.g. `"np"`). Used as the model_providers key in codex
    /// config and the model_provider value (always `"custom"` for codex).
    pub provider_id: String,
    /// Display name shown by the agent.
    pub name: String,
    /// Base URL of the provider's API endpoint.
    pub base_url: String,
    /// API key for authentication.
    pub api_key: String,
    /// Wire formats the provider supports (determines `wire_api` in codex config).
    pub formats: Vec<CustomProviderFormat>,
    /// Optional subagent model id (codex only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_subagent_model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub prompt: String,
    /// Harness to use for this run. Older peers may omit this; callers fall
    /// back to the chat's workspace-row config or the engine default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<HarnessId>,
    pub model: Option<String>,
    pub reasoning: Option<ReasoningLevel>,
    /// Harness-specific option selections (option id -> choice id), JSON round-tripped.
    #[serde(default)]
    pub model_options: serde_json::Map<String, serde_json::Value>,
    pub cwd: String,
    pub sandbox: SandboxLevel,
    #[serde(default)]
    pub auto_approve: bool,
    /// Harness-native session id to resume, if any.
    pub resume: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed_purpose: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed_role: Option<String>,
    /// Selected ACP agent id when the harness is `Acp`. When `None`, the
    /// device's active ACP agent is used. Ignored by non-ACP harnesses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_agent_id: Option<String>,
    /// Absolute paths of image attachments already staged on the run device
    /// (composer uploads: UploadChunk/UploadCommit → durable path). The same
    /// paths also ride the prompt text as `Attached images (local files …)`
    /// refs (comet's `withAttachments` transport — that's what persists in the
    /// doc); this field additionally lets a harness inline the bytes as image
    /// content blocks. Additive + serde-defaulted for wire compat.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<String>,
    /// When the selected model belongs to a custom provider, the engine fills
    /// this with the provider's connection details + API key. The harness
    /// builds provider-specific env vars (e.g. `MODEL_PROVIDER`,
    /// `CODEX_CONFIG`, `CODEX_API_KEY` for codex-acp) and injects them into
    /// the spawned agent subprocess at session start. Credentials live only
    /// in-memory for the run — never persisted in session state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_provider: Option<CustomProviderEnv>,
}

impl RunRequest {
    /// Preserve behavior for requests created by older peers which only knew
    /// `sandbox` and `autoApprove`.
    pub fn effective_permission_mode(&self) -> PermissionMode {
        match (self.sandbox, self.auto_approve) {
            (SandboxLevel::ReadOnly, _) => PermissionMode::Plan,
            (SandboxLevel::DangerFullAccess, true) => PermissionMode::FullAccess,
            (SandboxLevel::WorkspaceWrite, true) => PermissionMode::AcceptEdits,
            _ => PermissionMode::Default,
        }
    }
}

/// A decoded tool invocation, reduced to the fields each kind renders.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ToolCall {
    Exec {
        command: String,
    },
    ReadFile {
        path: String,
    },
    WriteFile {
        path: String,
        /// Full content; STRIPPED by the render-parts policy before entering the doc.
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<String>,
    },
    EditFile {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        old_string: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        new_string: Option<String>,
    },
    ApplyPatch {
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    Search {
        pattern: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    Glob {
        pattern: String,
    },
    WebFetch {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
    },
    WebSearch {
        query: String,
    },
    Todo {
        #[serde(default)]
        items: Vec<TodoItem>,
    },
    Mcp {
        server: String,
        tool: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        input: Option<serde_json::Value>,
    },
    Unknown {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        input: Option<serde_json::Value>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub text: String,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputQuestion {
    pub id: String,
    pub header: String,
    pub question: String,
    pub options: Vec<String>,
    #[serde(default)]
    pub multi_select: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputAnswer {
    pub question_id: String,
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DoneStatus {
    Completed,
    Interrupted,
    Errored,
}

/// The normalized streaming event every harness emits.
///
/// Mirrors comet's `AgentEvent` tagged enum.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentEvent {
    #[serde(rename_all = "camelCase")]
    SessionStarted {
        harness: HarnessId,
        model: String,
        #[serde(default)]
        tools: Vec<String>,
        cwd: String,
        /// Harness-native session id (used for resume).
        session_id: String,
        assistant_message_id: String,
    },
    TextDelta {
        text: String,
    },
    ReasoningDelta {
        text: String,
    },
    /// Backend-internal steering boundary marker.
    #[serde(rename_all = "camelCase")]
    AssistantMessageCompleted {
        assistant_message_id: String,
    },
    ToolCall {
        id: String,
        call: ToolCall,
    },
    #[serde(rename_all = "camelCase")]
    ToolResult {
        id: String,
        is_error: bool,
    },
    /// Kept as a harness passthrough (rate-limit probes); never persisted to docs.
    #[serde(rename_all = "camelCase")]
    Usage {
        input_tokens: u64,
        output_tokens: u64,
    },
    Error {
        message: String,
    },
    #[serde(rename_all = "camelCase")]
    InputRequested {
        request_id: String,
        questions: Vec<UserInputQuestion>,
    },
    #[serde(rename_all = "camelCase")]
    InputResolved {
        request_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Steered {
        assistant_message_id: Option<String>,
        next_assistant_message_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Done {
        status: DoneStatus,
        result: Option<String>,
        error: Option<String>,
        session_id: Option<String>,
    },
    /// The agent published a human-readable title for the session (ACP
    /// `SessionInfoUpdate`). The engine applies it directly and skips
    /// auto-titling when present.
    #[serde(rename_all = "camelCase")]
    SessionTitle {
        title: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_event_round_trips() {
        let ev = AgentEvent::ToolCall {
            id: "t1".into(),
            call: ToolCall::Exec {
                command: "cargo test".into(),
            },
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert_eq!(serde_json::from_str::<AgentEvent>(&json).unwrap(), ev);
    }

    #[test]
    fn session_title_event_round_trips() {
        let ev = AgentEvent::SessionTitle {
            title: "Fix Login".into(),
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert_eq!(serde_json::from_str::<AgentEvent>(&json).unwrap(), ev);
    }

    #[test]
    fn run_request_attachments_default_and_round_trip() {
        // Old-wire JSON without the field parses (additive compat)…
        let old = r#"{"prompt":"p","model":null,"reasoning":null,"cwd":".","sandbox":"workspace-write","resume":null}"#;
        let req: RunRequest = serde_json::from_str(old).unwrap();
        assert!(req.attachments.is_empty());
        // …and an empty list serializes away (old readers never see it).
        let json = serde_json::to_value(&req).unwrap();
        assert!(json.get("attachments").is_none());
        // Populated lists round-trip.
        let req = RunRequest {
            attachments: vec!["/tmp/a.png".into()],
            ..req
        };
        let round: RunRequest =
            serde_json::from_value(serde_json::to_value(&req).unwrap()).unwrap();
        assert_eq!(round.attachments, vec!["/tmp/a.png".to_string()]);
    }

    #[test]
    fn run_request_harness_default_and_round_trip() {
        // Old-wire JSON without harness parses (additive compat)…
        let old = r#"{"prompt":"p","model":null,"reasoning":null,"cwd":".","sandbox":"workspace-write","resume":null}"#;
        let req: RunRequest = serde_json::from_str(old).unwrap();
        assert!(req.harness.is_none());
        // …and None serializes away (old readers never see it).
        let json = serde_json::to_value(&req).unwrap();
        assert!(json.get("harness").is_none());
        // Populated harness round-trips.
        let req = RunRequest {
            harness: Some(HarnessId::Codex),
            ..req
        };
        let round: RunRequest =
            serde_json::from_value(serde_json::to_value(&req).unwrap()).unwrap();
        assert_eq!(round.harness, Some(HarnessId::Codex));
    }

    #[test]
    fn permission_modes_map_to_legacy_run_fields() {
        assert_eq!(
            PermissionMode::Default.sandbox(),
            SandboxLevel::WorkspaceWrite
        );
        assert!(!PermissionMode::Default.auto_approve());
        assert_eq!(PermissionMode::Plan.sandbox(), SandboxLevel::ReadOnly);
        assert!(!PermissionMode::Plan.auto_approve());
        assert_eq!(
            PermissionMode::AcceptEdits.sandbox(),
            SandboxLevel::WorkspaceWrite
        );
        assert!(PermissionMode::AcceptEdits.auto_approve());
        assert_eq!(
            PermissionMode::FullAccess.sandbox(),
            SandboxLevel::DangerFullAccess
        );
        assert!(PermissionMode::FullAccess.auto_approve());
    }

    #[test]
    fn harness_id_uses_kebab_case() {
        assert_eq!(
            serde_json::to_string(&HarnessId::ClaudeCode).unwrap(),
            "\"claude-code\""
        );
        assert_eq!(serde_json::to_string(&HarnessId::Acp).unwrap(), "\"acp\"");
    }
}

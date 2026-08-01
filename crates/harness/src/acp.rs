//! Generic Agent Client Protocol harness.
//!
//! `COMET_ACP_AGENT` accepts the command string or JSON configuration understood
//! by the official `agent-client-protocol` Rust SDK's [`AcpAgent`]. The adapter
//! normalizes ACP session updates into Comet events and keeps the ACP session
//! alive across turns.

use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, Implementation, InitializeRequest, LoadSessionRequest,
    NewSessionRequest, PermissionOption, PermissionOptionKind, PromptRequest,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionNotification, SessionUpdate, StopReason, TextContent,
    ToolCall, ToolCallStatus, ToolKind,
};
use agent_client_protocol::{AcpAgent, Agent, ConnectionTo};
use async_trait::async_trait;
use base64::Engine;
use futures::StreamExt;
use futures::stream::BoxStream;
use serde::Deserialize;
use tokio::sync::mpsc;

use comet_proto::{
    AgentEvent, DoneStatus, HarnessId, Model, ReasoningLevel, RunRequest, SteeringMode,
    ToolCall as CometToolCall, UserInputQuestion,
};

use crate::{Harness, HarnessError, RunControls};

const ENV_AGENT: &str = "COMET_ACP_AGENT";
const REASONING_LEVELS: &[ReasoningLevel] = &[ReasoningLevel::Medium];

type InputRequester = dyn Fn(
        Vec<comet_proto::UserInputQuestion>,
    ) -> tokio::sync::oneshot::Receiver<Vec<comet_proto::UserInputAnswer>>
    + Send
    + Sync;

/// An ACP-compatible CLI configured through `COMET_ACP_AGENT`.
#[derive(Default)]
pub struct AcpHarness {
    command: Option<String>,
    config_file: Option<PathBuf>,
}

impl AcpHarness {
    pub fn new() -> Self {
        Self::default()
    }

    /// Use a fixed SDK command/config instead of `COMET_ACP_AGENT`.
    pub fn with_command(command: impl Into<String>) -> Self {
        Self {
            command: Some(command.into()),
            config_file: None,
        }
    }

    /// Read the active agent command from Comet's device-local ACP settings.
    pub fn with_config_file(mut self, path: impl Into<PathBuf>) -> Self {
        self.config_file = Some(path.into());
        self
    }

    fn command(&self) -> Result<String, HarnessError> {
        self.command
            .clone()
            .or_else(|| std::env::var(ENV_AGENT).ok())
            .or_else(|| {
                let file = self.config_file.as_ref()?;
                let json = std::fs::read_to_string(file).ok()?;
                let config: AcpHarnessConfig = serde_json::from_str(&json).ok()?;
                let active = config.active_agent_id?;
                config
                    .agents
                    .into_iter()
                    .find(|agent| agent.id == active)
                    .map(|agent| agent.command)
            })
            .filter(|command| !command.trim().is_empty())
            .ok_or_else(|| {
                HarnessError::NotInstalled(format!(
                    "ACP agent is not configured; add one in Settings > ACP agents or set \
                     {ENV_AGENT}"
                ))
            })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcpHarnessConfig {
    active_agent_id: Option<String>,
    #[serde(default)]
    agents: Vec<AcpHarnessAgent>,
}

#[derive(Deserialize)]
struct AcpHarnessAgent {
    id: String,
    command: String,
}

#[async_trait]
impl Harness for AcpHarness {
    fn id(&self) -> HarnessId {
        HarnessId::Acp
    }

    fn display_name(&self) -> &str {
        "ACP Agent"
    }

    fn supports_steering(&self) -> bool {
        true
    }

    fn steering_mode(&self) -> SteeringMode {
        // ACP has multi-turn sessions but no mid-turn steering method.
        SteeringMode::TurnBoundary
    }

    fn reasoning_levels(&self) -> &[ReasoningLevel] {
        REASONING_LEVELS
    }

    async fn models(&self) -> Result<Vec<Model>, HarnessError> {
        self.command()?;
        // ACP model options are session-scoped and arrive after session/new.
        // "default" deliberately leaves model selection to the agent.
        Ok(vec![Model {
            id: "default".into(),
            label: "Agent default".into(),
            description: Some("Model selected by the ACP agent".into()),
            reasoning_levels: REASONING_LEVELS.to_vec(),
            options: vec![],
        }])
    }

    async fn run(
        &self,
        request: RunRequest,
        controls: RunControls,
    ) -> Result<BoxStream<'static, Result<AgentEvent, HarnessError>>, HarnessError> {
        let command = self.command()?;
        let agent = AcpAgent::from_str(&command).map_err(|error| {
            HarnessError::Protocol(format!("invalid ACP agent config: {error}"))
        })?;
        let (event_tx, event_rx) = mpsc::channel(256);
        let notification_tx = event_tx.clone();
        let completed_tools = Arc::new(Mutex::new(HashSet::new()));
        let notification_tools = completed_tools.clone();
        let RunControls {
            request_input,
            steering,
            interrupt,
        } = controls;
        let request_input = Arc::new(request_input);
        let permission_input = request_input.clone();
        let auto_approve = request.auto_approve;

        tokio::spawn(async move {
            let connection_tx = event_tx.clone();
            let result = agent_client_protocol::Client
                .builder()
                .on_receive_notification(
                    async move |notification: SessionNotification, _cx| {
                        for event in normalize_update(notification.update, &notification_tools) {
                            if notification_tx.send(Ok(event)).await.is_err() {
                                break;
                            }
                        }
                        Ok(())
                    },
                    agent_client_protocol::on_receive_notification!(),
                )
                .on_receive_request(
                    async move |permission: RequestPermissionRequest, responder, _cx| {
                        let outcome = permission_outcome(
                            &permission,
                            auto_approve,
                            permission_input.as_ref().as_ref(),
                        )
                        .await;
                        responder.respond(RequestPermissionResponse::new(outcome))
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .connect_with(agent, |connection: ConnectionTo<Agent>| async move {
                    run_connection(connection, request, steering, interrupt, connection_tx).await
                })
                .await;

            if let Err(error) = result {
                let _ = event_tx
                    .send(Ok(AgentEvent::Done {
                        status: DoneStatus::Errored,
                        result: None,
                        error: Some(format!("ACP connection failed: {error}")),
                        session_id: None,
                    }))
                    .await;
            }
        });

        Ok(futures::stream::unfold(event_rx, |mut rx| async move {
            rx.recv().await.map(|event| (event, rx))
        })
        .boxed())
    }
}

async fn run_connection(
    connection: ConnectionTo<Agent>,
    request: RunRequest,
    mut steering: mpsc::Receiver<crate::SteerMessage>,
    interrupt: crate::CancellationToken,
    event_tx: mpsc::Sender<Result<AgentEvent, HarnessError>>,
) -> agent_client_protocol::Result<()> {
    connection
        .send_request(InitializeRequest::new(ProtocolVersion::V1).client_info(
            Implementation::new("comet-native", env!("CARGO_PKG_VERSION")).title("Comet"),
        ))
        .block_task()
        .await?;

    let cwd = absolute_cwd(&request.cwd);
    let session_id = if let Some(resume) = &request.resume {
        match connection
            .send_request(LoadSessionRequest::new(resume.clone(), cwd.clone()))
            .block_task()
            .await
        {
            Ok(_) => resume.clone().into(),
            Err(error) => {
                tracing::debug!(target: "comet_harness::acp", %error, "session/load failed; starting a new ACP session");
                connection
                    .send_request(NewSessionRequest::new(cwd.clone()))
                    .block_task()
                    .await?
                    .session_id
            }
        }
    } else {
        connection
            .send_request(NewSessionRequest::new(cwd.clone()))
            .block_task()
            .await?
            .session_id
    };

    let session_id_string = session_id.to_string();
    if event_tx
        .send(Ok(AgentEvent::SessionStarted {
            harness: HarnessId::Acp,
            model: request.model.clone().unwrap_or_else(|| "default".into()),
            tools: vec![],
            cwd: cwd.display().to_string(),
            session_id: session_id_string.clone(),
            assistant_message_id: uuid::Uuid::new_v4().to_string(),
        }))
        .await
        .is_err()
    {
        return Ok(());
    }

    let mut prompts = VecDeque::from([prompt_content(&request)]);

    loop {
        let Some(content) = prompts.pop_front() else {
            tokio::select! {
                steer = steering.recv() => match steer {
                    Some(steer) => prompts.push_back(vec![ContentBlock::Text(TextContent::new(steer.prompt))]),
                    None => return Ok(()),
                },
                _ = interrupt.cancelled() => return Ok(()),
            }
            continue;
        };

        let prompt = connection
            .send_request(PromptRequest::new(session_id.clone(), content))
            .block_task();
        tokio::pin!(prompt);
        let response = loop {
            tokio::select! {
                response = &mut prompt => break response,
                steer = steering.recv() => {
                    if let Some(steer) = steer {
                        prompts.push_back(vec![ContentBlock::Text(TextContent::new(steer.prompt))]);
                    }
                }
                _ = interrupt.cancelled() => {
                    connection.send_notification(CancelNotification::new(session_id.clone()))?;
                    break prompt.await;
                }
            }
        }?;

        let (status, error) = done_from_stop_reason(response.stop_reason);
        if event_tx
            .send(Ok(AgentEvent::Done {
                status,
                result: None,
                error,
                session_id: Some(session_id_string.clone()),
            }))
            .await
            .is_err()
        {
            return Ok(());
        }
        if status == DoneStatus::Interrupted {
            return Ok(());
        }
        if !prompts.is_empty()
            && event_tx
                .send(Ok(AgentEvent::Steered {
                    assistant_message_id: None,
                    next_assistant_message_id: Some(uuid::Uuid::new_v4().to_string()),
                }))
                .await
                .is_err()
        {
            return Ok(());
        }
    }
}

fn absolute_cwd(cwd: &str) -> PathBuf {
    let path = PathBuf::from(cwd);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(path)
    }
}

fn prompt_content(request: &RunRequest) -> Vec<ContentBlock> {
    let mut content = vec![ContentBlock::Text(TextContent::new(request.prompt.clone()))];
    for attachment in &request.attachments {
        if let Some(image) = image_content(Path::new(attachment)) {
            content.push(image);
        }
    }
    content
}

fn image_content(path: &Path) -> Option<ContentBlock> {
    let mime_type = match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    };
    let data = std::fs::read(path).ok()?;
    Some(ContentBlock::Image(
        agent_client_protocol::schema::v1::ImageContent::new(
            base64::engine::general_purpose::STANDARD.encode(data),
            mime_type,
        )
        .uri(format!("file://{}", path.display())),
    ))
}

fn normalize_update(
    update: SessionUpdate,
    completed_tools: &Mutex<HashSet<String>>,
) -> Vec<AgentEvent> {
    match update {
        SessionUpdate::AgentMessageChunk(chunk) => match chunk.content {
            ContentBlock::Text(text) => vec![AgentEvent::TextDelta { text: text.text }],
            _ => vec![],
        },
        SessionUpdate::AgentThoughtChunk(chunk) => match chunk.content {
            ContentBlock::Text(text) => vec![AgentEvent::ReasoningDelta { text: text.text }],
            _ => vec![],
        },
        SessionUpdate::ToolCall(tool) => {
            let id = tool.tool_call_id.to_string();
            let mut events = vec![AgentEvent::ToolCall {
                id: id.clone(),
                call: normalize_tool_call(&tool),
            }];
            if matches!(
                tool.status,
                ToolCallStatus::Completed | ToolCallStatus::Failed
            ) {
                completed_tools.lock().unwrap().insert(id.clone());
                events.push(AgentEvent::ToolResult {
                    id,
                    is_error: tool.status == ToolCallStatus::Failed,
                });
            }
            events
        }
        SessionUpdate::ToolCallUpdate(update) => {
            let id = update.tool_call_id.to_string();
            let Some(status) = update.fields.status else {
                return vec![];
            };
            if !matches!(status, ToolCallStatus::Completed | ToolCallStatus::Failed)
                || !completed_tools.lock().unwrap().insert(id.clone())
            {
                return vec![];
            }
            vec![AgentEvent::ToolResult {
                id,
                is_error: status == ToolCallStatus::Failed,
            }]
        }
        _ => vec![],
    }
}

fn normalize_tool_call(tool: &ToolCall) -> CometToolCall {
    let input = tool.raw_input.clone();
    let field = |name: &str| {
        input
            .as_ref()
            .and_then(|value| value.get(name))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    let path = tool
        .locations
        .first()
        .map(|location| location.path.display().to_string())
        .or_else(|| field("path"))
        .unwrap_or_default();
    match tool.kind {
        ToolKind::Execute => CometToolCall::Exec {
            command: field("command").unwrap_or_else(|| tool.title.clone()),
        },
        ToolKind::Read => CometToolCall::ReadFile { path },
        ToolKind::Edit | ToolKind::Delete | ToolKind::Move => CometToolCall::EditFile {
            path,
            old_string: None,
            new_string: None,
        },
        ToolKind::Search => CometToolCall::Search {
            pattern: field("query")
                .or_else(|| field("pattern"))
                .unwrap_or_else(|| tool.title.clone()),
            path: (!path.is_empty()).then_some(path),
        },
        ToolKind::Fetch => field("url").map_or_else(
            || CometToolCall::Unknown {
                name: tool.title.clone(),
                input,
            },
            |url| CometToolCall::WebFetch { url, prompt: None },
        ),
        _ => CometToolCall::Unknown {
            name: tool.title.clone(),
            input,
        },
    }
}

async fn permission_outcome(
    request: &RequestPermissionRequest,
    auto_approve: bool,
    request_input: &InputRequester,
) -> RequestPermissionOutcome {
    if auto_approve && let Some(option) = preferred_allow_option(&request.options) {
        return RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
            option.option_id.clone(),
        ));
    }
    let labels: Vec<String> = request
        .options
        .iter()
        .map(|option| option.name.clone())
        .collect();
    let question_id = request.tool_call.tool_call_id.to_string();
    let answers = request_input(vec![UserInputQuestion {
        id: question_id.clone(),
        header: "Permission".into(),
        question: request
            .tool_call
            .fields
            .title
            .clone()
            .unwrap_or_else(|| "Allow this ACP tool call?".into()),
        options: labels,
        multi_select: false,
    }])
    .await
    .unwrap_or_default();
    let selected = answers
        .iter()
        .find(|answer| answer.question_id == question_id)
        .and_then(|answer| answer.labels.first());
    request
        .options
        .iter()
        .find(|option| selected == Some(&option.name))
        .map(|option| {
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                option.option_id.clone(),
            ))
        })
        .unwrap_or(RequestPermissionOutcome::Cancelled)
}

fn preferred_allow_option(options: &[PermissionOption]) -> Option<&PermissionOption> {
    options
        .iter()
        .find(|option| option.kind == PermissionOptionKind::AllowAlways)
        .or_else(|| {
            options
                .iter()
                .find(|option| option.kind == PermissionOptionKind::AllowOnce)
        })
}

fn done_from_stop_reason(reason: StopReason) -> (DoneStatus, Option<String>) {
    match reason {
        StopReason::EndTurn => (DoneStatus::Completed, None),
        StopReason::Cancelled => (DoneStatus::Interrupted, None),
        StopReason::MaxTokens => (
            DoneStatus::Errored,
            Some("ACP agent reached its maximum token limit".into()),
        ),
        StopReason::MaxTurnRequests => (
            DoneStatus::Errored,
            Some("ACP agent reached its maximum turn-request limit".into()),
        ),
        StopReason::Refusal => (
            DoneStatus::Errored,
            Some("ACP agent refused the request".into()),
        ),
        _ => (
            DoneStatus::Errored,
            Some("ACP agent stopped unexpectedly".into()),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{ToolCallLocation, ToolCallUpdateFields};

    #[test]
    fn execute_tool_call_is_normalized() {
        let tool = ToolCall::new("call-1", "Run tests")
            .kind(ToolKind::Execute)
            .raw_input(serde_json::json!({"command": "cargo test"}));
        assert_eq!(
            normalize_tool_call(&tool),
            CometToolCall::Exec {
                command: "cargo test".into()
            }
        );
    }

    #[test]
    fn completed_tool_update_is_emitted_once() {
        let completed = Mutex::new(HashSet::new());
        let update =
            SessionUpdate::ToolCallUpdate(agent_client_protocol::schema::v1::ToolCallUpdate::new(
                "call-1",
                ToolCallUpdateFields::new().status(ToolCallStatus::Completed),
            ));
        assert_eq!(normalize_update(update.clone(), &completed).len(), 1);
        assert!(normalize_update(update, &completed).is_empty());
    }

    #[test]
    fn read_tool_prefers_acp_location() {
        let tool = ToolCall::new("call-1", "Read")
            .kind(ToolKind::Read)
            .locations(vec![ToolCallLocation::new("/tmp/file.rs")]);
        assert_eq!(
            normalize_tool_call(&tool),
            CometToolCall::ReadFile {
                path: "/tmp/file.rs".into()
            }
        );
    }

    #[test]
    fn configured_active_agent_is_loaded_from_disk() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("acp-agents.json");
        std::fs::write(
            &config,
            r#"{
                "activeAgentId": "second",
                "agents": [
                    {"id": "first", "command": "first-agent"},
                    {"id": "second", "command": "second-agent --acp"}
                ]
            }"#,
        )
        .unwrap();
        let harness = AcpHarness::new().with_config_file(config);
        assert_eq!(harness.command().unwrap(), "second-agent --acp");
    }
}

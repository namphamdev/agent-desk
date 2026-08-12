//! The live ACP session loop: the initialize/authenticate handshake, session
//! setup (model, permission mode, reasoning), the prompt/steer loop, prompt
//! assembly, and MCP server wiring.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use agent_client_protocol::schema::v1::{
    AuthenticateRequest, AuthMethod, CancelNotification, ClientCapabilities,
    ClientSessionCapabilities, ContentBlock, Implementation, InitializeRequest, InitializeResponse,
    LoadSessionRequest, McpServer, McpServerHttp, NewSessionRequest, PromptRequest,
    SessionConfigOption, SessionConfigOptionsCapabilities, SessionId,
    SetSessionConfigOptionRequest, StopReason, TextContent,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{Agent, ConnectionTo};
use base64::Engine;
use tokio::sync::mpsc;

use comet_proto::{AgentEvent, DoneStatus, HarnessId, PermissionMode, ReasoningLevel, RunRequest};

use crate::HarnessError;

use super::models::{
    model_config_option, mode_config_option, normalize_config_name, reasoning_level_acp_value,
    select_choices, thought_level_config_option,
};
use super::CODE_CONTEXT_MCP_NAME;

pub(super) fn mcp_servers(url: Option<&str>) -> Vec<McpServer> {
    url.filter(|url| !url.trim().is_empty())
        .map(|url| McpServer::Http(McpServerHttp::new(CODE_CONTEXT_MCP_NAME, url)))
        .into_iter()
        .collect()
}

pub(super) async fn run_connection(
    connection: ConnectionTo<Agent>,
    request: RunRequest,
    mut steering: mpsc::Receiver<crate::SteerMessage>,
    interrupt: crate::CancellationToken,
    event_tx: mpsc::Sender<Result<AgentEvent, HarnessError>>,
    mcp_server_url: Option<String>,
    prompt_transform: fn(Option<ReasoningLevel>, &str) -> String,
    harness_id: HarnessId,
    live_updates: Arc<AtomicBool>,
) -> agent_client_protocol::Result<()> {
    initialize_and_authenticate(&connection).await?;

    let cwd = absolute_cwd(&request.cwd);
    let mcp_servers = mcp_servers(mcp_server_url.as_deref());
    let with_mcp = |request: NewSessionRequest| {
        if mcp_servers.is_empty() {
            request
        } else {
            request.mcp_servers(mcp_servers.clone())
        }
    };
    let with_mcp_load = |request: LoadSessionRequest| {
        if mcp_servers.is_empty() {
            request
        } else {
            request.mcp_servers(mcp_servers.clone())
        }
    };
    let (session_id, config_options) = if let Some(resume) = &request.resume {
        match connection
            .send_request(with_mcp_load(LoadSessionRequest::new(resume.clone(), cwd.clone())))
            .block_task()
            .await
        {
            Ok(response) => (resume.clone().into(), response.config_options),
            Err(error) => {
                tracing::debug!(target: "comet_harness::acp", %error, "session/load failed; starting a new ACP session");
                let response = connection
                    .send_request(with_mcp(NewSessionRequest::new(cwd.clone())))
                    .block_task()
                    .await?;
                (response.session_id, response.config_options)
            }
        }
    } else {
        let response = connection
            .send_request(NewSessionRequest::new(cwd.clone()))
            .block_task()
            .await?;
        (response.session_id, response.config_options)
    };
    let updated_config_options = set_session_model(
        &connection,
        &session_id,
        request.model.as_deref(),
        config_options.as_deref(),
    )
    .await?;
    let effective_config_options = updated_config_options
        .as_deref()
        .filter(|options| !options.is_empty())
        .or(config_options.as_deref());
    let mode_config_options = set_session_permission_mode(
        &connection,
        &session_id,
        request.effective_permission_mode(),
        effective_config_options,
    )
    .await?;
    let effective_config_options = mode_config_options
        .as_deref()
        .filter(|options| !options.is_empty())
        .or(effective_config_options);
    set_session_reasoning(
        &connection,
        &session_id,
        request.reasoning,
        effective_config_options,
    )
    .await?;

    let session_id_string = session_id.to_string();
    let mut assistant_message_id = uuid::Uuid::new_v4().to_string();
    if event_tx
        .send(Ok(AgentEvent::SessionStarted {
            harness: harness_id,
            model: request.model.clone().unwrap_or_else(|| "default".into()),
            tools: vec![],
            cwd: cwd.display().to_string(),
            session_id: session_id_string.clone(),
            assistant_message_id: assistant_message_id.clone(),
        }))
        .await
        .is_err()
    {
        return Ok(());
    }
    // Session setup (including any session/load replay) is complete. Open the
    // gate so only prompt-flow updates reach the transcript from here on.
    live_updates.store(true, Ordering::Relaxed);
    let mut prompts = VecDeque::from([prompt_content(&request, prompt_transform)]);

    loop {
        let Some(content) = prompts.pop_front() else {
            tokio::select! {
                steer = steering.recv() => match steer {
                    Some(steer) => {
                        let previous = std::mem::replace(
                            &mut assistant_message_id,
                            uuid::Uuid::new_v4().to_string(),
                        );
                        if event_tx
                            .send(Ok(AgentEvent::Steered {
                                assistant_message_id: Some(previous),
                                next_assistant_message_id: Some(assistant_message_id.clone()),
                            }))
                            .await
                            .is_err()
                        {
                            return Ok(());
                        }
                        prompts.push_back(vec![ContentBlock::Text(TextContent::new(
                            prompt_transform(request.reasoning, &steer.prompt),
                        ))]);
                    }
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
                        prompts.push_back(vec![ContentBlock::Text(TextContent::new(
                            prompt_transform(request.reasoning, &steer.prompt),
                        ))]);
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
        if !prompts.is_empty() {
            let previous =
                std::mem::replace(&mut assistant_message_id, uuid::Uuid::new_v4().to_string());
            if event_tx
                .send(Ok(AgentEvent::Steered {
                    assistant_message_id: Some(previous),
                    next_assistant_message_id: Some(assistant_message_id.clone()),
                }))
                .await
                .is_err()
            {
                return Ok(());
            }
        }
    }
}

/// Complete the ACP `initialize` handshake and, when the agent advertises
/// authentication methods, the `authenticate` round-trip that follows it.
///
/// Agents that handle auth internally (claude-agent-acp, codex-acp, the test
/// fixture) advertise `authMethods: []`, so this is a no-op for them. Agents
/// like Grok (`grok agent stdio`) require an explicit `authenticate` request
/// before `session/new`; without it, `session/new` fails or returns no
/// `configOptions`. This function is used by the live `run` path. Model
/// discovery calls `authenticate_if_needed` non-fatally (catching auth
/// failures) so the model list is available even when the user hasn't logged
/// in yet.
async fn initialize_and_authenticate(
    connection: &ConnectionTo<Agent>,
) -> agent_client_protocol::Result<()> {
    let response = initialize(connection).await?;
    authenticate_if_needed(connection, &response).await
}

pub(super) async fn initialize(
    connection: &ConnectionTo<Agent>,
) -> agent_client_protocol::Result<InitializeResponse> {
    let capabilities = ClientCapabilities::new().session(
        ClientSessionCapabilities::new().config_options(SessionConfigOptionsCapabilities::new()),
    );
    connection
        .send_request(
            InitializeRequest::new(ProtocolVersion::V1)
                .client_capabilities(capabilities)
                .client_info(
                    Implementation::new("comet-native", env!("CARGO_PKG_VERSION")).title("Comet"),
                ),
        )
        .block_task()
        .await
}

pub(super) async fn authenticate_if_needed(
    connection: &ConnectionTo<Agent>,
    response: &InitializeResponse,
) -> agent_client_protocol::Result<()> {
    if response.auth_methods.is_empty() {
        return Ok(());
    }
    let Some(method_id) = pick_auth_method(response) else {
        let methods = response
            .auth_methods
            .iter()
            .map(|method| method.id().to_string())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(agent_client_protocol::Error::internal_error().data(format!(
            "ACP agent requires authentication but none of its advertised methods \
             ({methods}) are supported"
        )));
    };
    // `headless: true` mirrors the official Grok client flow: authenticate with
    // the agent's cached credentials or API key instead of opening an
    // interactive flow. Unknown `_meta` keys are ignored by other agents.
    let mut meta = agent_client_protocol::schema::v1::Meta::new();
    meta.insert("headless".into(), serde_json::Value::Bool(true));
    connection
        .send_request(AuthenticateRequest::new(method_id.clone()).meta(meta))
        .block_task()
        .await?;
    tracing::debug!(method = %method_id, "ACP agent authenticated");
    Ok(())
}

/// Choose which advertised authentication method to use. Prefer the
/// locally-authenticated flow (the agent's cached CLI credentials), fall back
/// to the API-key flow (the agent reads `XAI_API_KEY` from its own env), then
/// any agent-handled method as a last resort.
fn pick_auth_method(response: &InitializeResponse) -> Option<String> {
    for preferred in ["cached_token", "xai.api_key"] {
        if let Some(id) = response
            .auth_methods
            .iter()
            .find(|method| method.id().to_string() == preferred)
        {
            return Some(id.id().to_string());
        }
    }
    response
        .auth_methods
        .iter()
        .find(|method| matches!(method, AuthMethod::Agent(_)))
        .map(|method| method.id().to_string())
}
async fn set_session_model(
    connection: &ConnectionTo<Agent>,
    session_id: &SessionId,
    model: Option<&str>,
    config_options: Option<&[SessionConfigOption]>,
) -> agent_client_protocol::Result<Option<Vec<SessionConfigOption>>> {
    let Some(model) = model.filter(|model| *model != "default") else {
        return Ok(None);
    };
    let config_id = config_options
        .and_then(model_config_option)
        .map(|option| option.id.clone())
        .unwrap_or_else(|| "model".into());
    let response = connection
        .send_request(SetSessionConfigOptionRequest::new(
            session_id.clone(),
            config_id,
            model,
        ))
        .block_task()
        .await;
    match response {
        Ok(response) => Ok(Some(response.config_options)),
        Err(error) if is_legacy_config_option_response(&error) => {
            tracing::debug!(
                target: "comet_harness::acp",
                %error,
                "ACP agent omitted configOptions after setting the model"
            );
            Ok(None)
        }
        // codex-acp rejects unknown model ids (custom-provider models not in
        // its own catalog) with "Invalid params". The model is already
        // configured via CODEX_CONFIG env, so this is non-fatal.
        Err(error) if is_invalid_params_response(&error) => {
            tracing::debug!(
                target: "comet_harness::acp",
                %error,
                model,
                "ACP agent rejected model config option; relying on env-configured model"
            );
            Ok(None)
        }
        // The agent does not implement session/setConfigOption (e.g. Grok).
        // Skip the call and let the agent use its own default model.
        Err(error) if is_method_not_found_response(&error) => {
            tracing::debug!(
                target: "comet_harness::acp",
                %error,
                "ACP agent does not support setConfigOption; skipping model"
            );
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

async fn set_session_reasoning(
    connection: &ConnectionTo<Agent>,
    session_id: &SessionId,
    reasoning: Option<ReasoningLevel>,
    config_options: Option<&[SessionConfigOption]>,
) -> agent_client_protocol::Result<()> {
    let Some(reasoning) = reasoning else {
        return Ok(());
    };
    let Some(option) = config_options.and_then(thought_level_config_option) else {
        return Ok(());
    };
    let value = reasoning_level_acp_value(reasoning, Some(option));
    let response = connection
        .send_request(SetSessionConfigOptionRequest::new(
            session_id.clone(),
            option.id.clone(),
            value.as_str(),
        ))
        .block_task()
        .await;
    match response {
        Ok(_) => Ok(()),
        Err(error) if is_legacy_config_option_response(&error) => {
            tracing::debug!(
                target: "comet_harness::acp",
                %error,
                "ACP agent omitted configOptions after setting reasoning"
            );
            Ok(())
        }
        Err(error) if is_method_not_found_response(&error) => {
            tracing::debug!(
                target: "comet_harness::acp",
                %error,
                "ACP agent does not support setConfigOption; skipping reasoning"
            );
            Ok(())
        }
        Err(error) => Err(error),
    }
}

async fn set_session_permission_mode(
    connection: &ConnectionTo<Agent>,
    session_id: &SessionId,
    mode: PermissionMode,
    config_options: Option<&[SessionConfigOption]>,
) -> agent_client_protocol::Result<Option<Vec<SessionConfigOption>>> {
    let Some(option) = config_options.and_then(mode_config_option) else {
        return Ok(None);
    };
    let aliases: &[&str] = match mode {
        PermissionMode::Default => &["default", "ask", "askbeforeedits"],
        PermissionMode::Plan => &["plan", "planning", "readonly"],
        PermissionMode::AcceptEdits => &["acceptedits", "autoedit", "edit"],
        PermissionMode::FullAccess => &["fullaccess", "bypasspermissions", "yolo"],
    };
    let Some(value) = select_choices(option).into_iter().find_map(|choice| {
        let value = normalize_config_name(&choice.value.to_string());
        let name = normalize_config_name(&choice.name);
        aliases
            .iter()
            .any(|alias| value == *alias || name == *alias)
            .then(|| choice.value.to_string())
    }) else {
        return Ok(None);
    };
    let response = connection
        .send_request(SetSessionConfigOptionRequest::new(
            session_id.clone(),
            option.id.clone(),
            value.as_str(),
        ))
        .block_task()
        .await;
    match response {
        Ok(response) => Ok(Some(response.config_options)),
        Err(error) if is_legacy_config_option_response(&error) => {
            tracing::debug!(
                target: "comet_harness::acp",
                %error,
                "ACP agent omitted configOptions after setting permission mode"
            );
            Ok(None)
        }
        Err(error) if is_method_not_found_response(&error) => {
            tracing::debug!(
                target: "comet_harness::acp",
                %error,
                "ACP agent does not support setConfigOption; skipping permission mode"
            );
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn is_legacy_config_option_response(error: &agent_client_protocol::Error) -> bool {
    let error = error.to_string();
    error.contains("missing field 'configOptions'")
        || error.contains("missing field `configOptions`")
}

/// JSON-RPC -32602 "Invalid params": codex-acp rejects `setConfigOption` calls
/// for model ids it doesn't know about (custom-provider models).
fn is_invalid_params_response(error: &agent_client_protocol::Error) -> bool {
    use agent_client_protocol::schema::v1::ErrorCode;
    error.code == ErrorCode::InvalidParams
}

/// JSON-RPC -32601 "Method not found": the agent does not implement
/// `session/setConfigOption` at all (e.g. Grok). The config option is
/// non-fatal, so the caller should skip it and let the agent use its own
/// defaults rather than aborting the session.
fn is_method_not_found_response(error: &agent_client_protocol::Error) -> bool {
    use agent_client_protocol::schema::v1::ErrorCode;
    error.code == ErrorCode::MethodNotFound
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

fn prompt_content(
    request: &RunRequest,
    prompt_transform: fn(Option<ReasoningLevel>, &str) -> String,
) -> Vec<ContentBlock> {
    let transformed = prompt_transform(request.reasoning, &request.prompt);
    let mut content = vec![ContentBlock::Text(TextContent::new(transformed))];
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

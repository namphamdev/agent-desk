//! Normalize ACP session updates into Comet events and resolve permission
//! requests against the harness's permission mode.

use std::collections::HashSet;
use std::sync::Mutex;

use agent_client_protocol::schema::v1::{
    ContentBlock, PermissionOption, PermissionOptionKind, Plan, PlanEntryStatus,
    RequestPermissionOutcome, RequestPermissionRequest, SelectedPermissionOutcome,
    SessionInfoUpdate, SessionUpdate, ToolCall, ToolCallStatus, ToolKind, UsageUpdate,
};
use agent_client_protocol::schema::MaybeUndefined;

use comet_proto::{AgentEvent, PermissionMode, ToolCall as CometToolCall, UserInputQuestion};

use super::InputRequester;

pub(super) fn normalize_update(
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
        SessionUpdate::UsageUpdate(usage) => vec![normalize_usage(&usage)],
        SessionUpdate::SessionInfoUpdate(info) => normalize_session_info(&info),
        SessionUpdate::Plan(plan) => normalize_plan(&plan),
        // Echo of the user's own message â€” the engine already persists the
        // prompt; re-streaming it would duplicate the user turn.
        SessionUpdate::UserMessageChunk(_) => vec![],
        // Config/mode/command updates are session-internal metadata with no
        // corresponding transcript rendering.
        SessionUpdate::ConfigOptionUpdate(_)
        | SessionUpdate::CurrentModeUpdate(_)
        | SessionUpdate::AvailableCommandsUpdate(_) => vec![],
        _ => vec![],
    }
}

fn normalize_usage(usage: &UsageUpdate) -> AgentEvent {
    // ACP reports cumulative context tokens (`used`) and the total window
    // size (`size`), not an input/output split. Map `used` to input_tokens
    // (the dominant component) and leave output_tokens at zero since the
    // protocol does not break it out.
    AgentEvent::Usage {
        input_tokens: usage.used,
        output_tokens: 0,
    }
}

fn normalize_session_info(info: &SessionInfoUpdate) -> Vec<AgentEvent> {
    match &info.title {
        MaybeUndefined::Value(title) if !title.trim().is_empty() => {
            vec![AgentEvent::SessionTitle {
                title: title.clone(),
            }]
        }
        _ => vec![],
    }
}

fn normalize_plan(plan: &Plan) -> Vec<AgentEvent> {
    let items: Vec<comet_proto::TodoItem> = plan
        .entries
        .iter()
        .map(|entry| comet_proto::TodoItem {
            text: entry.content.clone(),
            done: entry.status == PlanEntryStatus::Completed,
        })
        .collect();
    if items.is_empty() {
        return vec![];
    }
    vec![AgentEvent::ToolCall {
        id: "acp-plan".to_string(),
        call: CometToolCall::Todo { items },
    }]
}

pub(super) fn normalize_tool_call(tool: &ToolCall) -> CometToolCall {
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
pub(super) async fn permission_outcome(
    request: &RequestPermissionRequest,
    permission_mode: PermissionMode,
    request_input: &InputRequester,
) -> RequestPermissionOutcome {
    let edit = matches!(
        request.tool_call.fields.kind,
        Some(ToolKind::Edit | ToolKind::Delete | ToolKind::Move)
    );
    if permission_mode == PermissionMode::Plan
        && edit
        && let Some(option) = preferred_reject_option(&request.options)
    {
        return RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
            option.option_id.clone(),
        ));
    }
    if (permission_mode == PermissionMode::FullAccess
        || (permission_mode == PermissionMode::AcceptEdits && edit))
        && let Some(option) = preferred_allow_option(&request.options)
    {
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

fn preferred_reject_option(options: &[PermissionOption]) -> Option<&PermissionOption> {
    options
        .iter()
        .find(|option| option.kind == PermissionOptionKind::RejectAlways)
        .or_else(|| {
            options
                .iter()
                .find(|option| option.kind == PermissionOptionKind::RejectOnce)
        })
}

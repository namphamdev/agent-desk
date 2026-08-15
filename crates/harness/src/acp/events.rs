//! Normalize ACP session updates into Comet events and resolve permission
//! requests against the harness's permission mode.

use std::collections::{BTreeMap, HashSet};
use std::sync::Mutex;

use agent_client_protocol::schema::v1::{
    ContentBlock, CreateElicitationRequest, CreateElicitationResponse, ElicitationAcceptAction,
    ElicitationAction, ElicitationContentValue, ElicitationMode, ElicitationPropertySchema,
    MultiSelectItems, PermissionOption, PermissionOptionKind, Plan, PlanEntryStatus,
    RequestPermissionOutcome, RequestPermissionRequest, SelectedPermissionOutcome,
    SessionInfoUpdate, SessionUpdate, ToolCall, ToolCallStatus, ToolKind, UsageUpdate,
};
use agent_client_protocol::schema::MaybeUndefined;

use comet_proto::{AgentEvent, PermissionMode, ToolCall as CometToolCall, UserInputAnswer,
    UserInputQuestion};

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
        _ => {
            tracing::warn!(
                target: "comet_harness::acp",
                update = ?update,
                "Unrecognized SessionUpdate variant from agent — dropped"
            );
            vec![]
        }
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

// ---------------------------------------------------------------------------
// Elicitation (ask_user_question) bridge
// ---------------------------------------------------------------------------

/// Resolve an elicitation/create request by routing it through the engine's
/// `request_input` callback.
///
/// The agent sends `elicitation/create` when its internal `ask_user_question`
/// tool (or equivalent) needs structured user input. We translate the form
/// schema into `UserInputQuestion` objects, get answers from the UI layer,
/// and pack them back into a `CreateElicitationResponse`.
pub(super) async fn elicitation_response(
    request: &CreateElicitationRequest,
    request_input: &InputRequester,
) -> CreateElicitationResponse {
    let questions = elicitation_questions(request);
    if questions.is_empty() {
        // URL-mode elicitation or an empty form: we can't present it through
        // the `request_input` channel, so tell the agent the user declined.
        return CreateElicitationResponse::new(ElicitationAction::Decline);
    }
    let answers = request_input(questions).await.unwrap_or_default();
    let content = elicitation_content(&request.mode, &answers);
    if content.is_empty() {
        CreateElicitationResponse::new(ElicitationAction::Cancel)
    } else {
        CreateElicitationResponse::new(ElicitationAction::Accept(
            ElicitationAcceptAction::new().content(content),
        ))
    }
}

/// Convert the elicitation form schema into `UserInputQuestion` objects.
fn elicitation_questions(request: &CreateElicitationRequest) -> Vec<UserInputQuestion> {
    let ElicitationMode::Form(form) = &request.mode else {
        return Vec::new();
    };
    let schema = &form.requested_schema;
    let header = schema
        .title
        .as_deref()
        .unwrap_or("Input requested");
    form.requested_schema
        .properties
        .iter()
        .map(|(name, prop)| {
            let (options, multi_select) = property_choices(prop);
            let question_label = prop_label(prop).unwrap_or_else(|| name.clone());
            UserInputQuestion {
                id: name.clone(),
                header: header.to_string(),
                question: format!("{}: {question_label}", request.message),
                options,
                multi_select,
            }
        })
        .collect()
}

/// Extract (options, multi_select) from a property schema.
fn property_choices(
    schema: &ElicitationPropertySchema,
) -> (Vec<String>, bool) {
    match schema {
        ElicitationPropertySchema::String(s) => {
            if let Some(one_of) = &s.one_of {
                let options = one_of
                    .iter()
                    .map(|opt| opt.title.clone())
                    .collect();
                (options, false)
            } else if let Some(enum_values) = &s.enum_values {
                (enum_values.clone(), false)
            } else {
                // Free-text field: no options.
                (Vec::new(), false)
            }
        }
        ElicitationPropertySchema::Array(a) => {
            let options = match &a.items {
                MultiSelectItems::String(items) => items.values.clone(),
                MultiSelectItems::Titled(items) => items
                    .options
                    .iter()
                    .map(|opt| opt.title.clone())
                    .collect(),
                _ => Vec::new(),
            };
            (options, true)
        }
        ElicitationPropertySchema::Boolean(_) => {
            (vec!["Yes".into(), "No".into()], false)
        }
        // Number, integer, custom: free-text.
        _ => (Vec::new(), false),
    }
}

/// Get a human-readable label for a property (its title or description).
fn prop_label(schema: &ElicitationPropertySchema) -> Option<String> {
    match schema {
        ElicitationPropertySchema::String(s) => s.title.clone().or_else(|| s.description.clone()),
        ElicitationPropertySchema::Number(n) => n.title.clone().or_else(|| n.description.clone()),
        ElicitationPropertySchema::Integer(i) => i.title.clone().or_else(|| i.description.clone()),
        ElicitationPropertySchema::Boolean(b) => b.title.clone().or_else(|| b.description.clone()),
        ElicitationPropertySchema::Array(a) => a.title.clone().or_else(|| a.description.clone()),
        _ => None,
    }
}

/// Pack user answers into elicitation content keyed by property name.
fn elicitation_content(
    mode: &ElicitationMode,
    answers: &[UserInputAnswer],
) -> BTreeMap<String, ElicitationContentValue> {
    let ElicitationMode::Form(form) = mode else {
        return BTreeMap::new();
    };
    let mut content = BTreeMap::new();
    for (name, prop) in &form.requested_schema.properties {
        let Some(answer) = answers.iter().find(|a| a.question_id == *name) else {
            continue;
        };
        if answer.labels.is_empty() {
            continue;
        }
        let value = match prop {
            ElicitationPropertySchema::Array(_) => {
                ElicitationContentValue::StringArray(answer.labels.clone())
            }
            // For single-select, the label IS the enum value. But if the
            // property used `oneOf` (titled options), we need to map the
            // title back to the const value.
            ElicitationPropertySchema::String(s) => {
                if let Some(one_of) = &s.one_of {
                    let resolved = answer
                        .labels
                        .iter()
                        .find_map(|label| {
                            one_of.iter().find(|opt| &opt.title == label).map(|opt| opt.value.clone())
                        })
                        .or_else(|| answer.labels.first().cloned())
                        .unwrap_or_default();
                    ElicitationContentValue::String(resolved)
                } else {
                    ElicitationContentValue::String(
                        answer.labels.first().cloned().unwrap_or_default(),
                    )
                }
            }
            _ => ElicitationContentValue::String(
                answer.labels.first().cloned().unwrap_or_default(),
            ),
        };
        content.insert(name.clone(), value);
    }
    content
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{
        CreateElicitationRequest, ElicitationAcceptAction, ElicitationAction,
        ElicitationContentValue, ElicitationFormMode, ElicitationPropertySchema,
        ElicitationSchema, ElicitationSessionScope, EnumOption, MultiSelectPropertySchema,
        StringMultiSelectItems, StringPropertySchema,
    };

    #[test]
    fn form_with_single_select_enum_produces_question() {
        let schema = ElicitationSchema::new().property(
            "choice",
            StringPropertySchema::new().one_of(vec![
                EnumOption::new("a", "Option A"),
                EnumOption::new("b", "Option B"),
            ]),
            true,
        );
        let request = CreateElicitationRequest::new(
            ElicitationFormMode::new(ElicitationSessionScope::new("sess"), schema),
            "Pick one",
        );
        let questions = elicitation_questions(&request);
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].id, "choice");
        assert_eq!(questions[0].options, vec!["Option A", "Option B"]);
        assert!(!questions[0].multi_select);
    }

    #[test]
    fn form_with_multi_select_array_produces_multi_question() {
        let schema = ElicitationSchema::new().property(
            "tags",
            MultiSelectPropertySchema::new(vec!["rust".into(), "acp".into()]),
            true,
        );
        let request = CreateElicitationRequest::new(
            ElicitationFormMode::new(ElicitationSessionScope::new("sess"), schema),
            "Select tags",
        );
        let questions = elicitation_questions(&request);
        assert_eq!(questions.len(), 1);
        assert!(questions[0].multi_select);
        assert_eq!(questions[0].options, vec!["rust", "acp"]);
    }

    #[test]
    fn form_with_free_text_string_has_no_options() {
        let schema =
            ElicitationSchema::new().property("name", StringPropertySchema::new(), true);
        let request = CreateElicitationRequest::new(
            ElicitationFormMode::new(ElicitationSessionScope::new("sess"), schema),
            "Enter name",
        );
        let questions = elicitation_questions(&request);
        assert_eq!(questions.len(), 1);
        assert!(questions[0].options.is_empty());
    }

    #[test]
    fn one_of_title_maps_back_to_const_value() {
        let schema = ElicitationSchema::new().property(
            "choice",
            StringPropertySchema::new().one_of(vec![
                EnumOption::new("a", "Option A"),
                EnumOption::new("b", "Option B"),
            ]),
            true,
        );
        let request = CreateElicitationRequest::new(
            ElicitationFormMode::new(ElicitationSessionScope::new("sess"), schema),
            "Pick one",
        );
        let answers = vec![UserInputAnswer {
            question_id: "choice".into(),
            labels: vec!["Option B".into()],
        }];
        let content = elicitation_content(&request.mode, &answers);
        assert_eq!(
            content.get("choice"),
            Some(&ElicitationContentValue::String("b".into()))
        );
    }

    #[test]
    fn multi_select_content_packs_as_string_array() {
        let schema = ElicitationSchema::new().property(
            "tags",
            MultiSelectPropertySchema::new(vec!["rust".into(), "acp".into()]),
            true,
        );
        let request = CreateElicitationRequest::new(
            ElicitationFormMode::new(ElicitationSessionScope::new("sess"), schema),
            "Select tags",
        );
        let answers = vec![UserInputAnswer {
            question_id: "tags".into(),
            labels: vec!["rust".into(), "acp".into()],
        }];
        let content = elicitation_content(&request.mode, &answers);
        assert_eq!(
            content.get("tags"),
            Some(&ElicitationContentValue::StringArray(vec![
                "rust".into(),
                "acp".into()
            ]))
        );
    }

    #[test]
    fn empty_answers_produce_cancel_response() {
        let schema =
            ElicitationSchema::new().property("name", StringPropertySchema::new(), true);
        let request = CreateElicitationRequest::new(
            ElicitationFormMode::new(ElicitationSessionScope::new("sess"), schema),
            "Enter name",
        );
        // No answers at all.
        let content = elicitation_content(&request.mode, &[]);
        assert!(content.is_empty());
    }
}

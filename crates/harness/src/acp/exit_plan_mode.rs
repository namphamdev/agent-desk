//! Bridge for Grok's private `_x.ai/exit_plan_mode` ACP extension method.
//!
//! Grok Build's internal `exit_plan_mode` tool is the counterpart to plan
//! mode. When the agent has finished read-only exploration and wants to
//! present its plan for approval before implementing, it calls
//! `exit_plan_mode`. Like [`ask_user_question`], Grok does not route this
//! through the standard `session/request_permission` or `elicitation/create`
//! methods; it sends an agent-initiated extension request over the wire as
//! `_x.ai/exit_plan_mode`, whose params are the raw [`ExitPlanModeRequest`]
//! payload:
//!
//! ```json
//! {
//!   "sessionId": "...",
//!   "toolCallId": "...",
//!   "plan": "## Plan\n1. ...",
//!   "planPath": "plan.md"
//! }
//! ```
//!
//! The ACP SDK parses any `_*` method into an [`UntypedMessage`] fallback but
//! has no typed handler for it, so it would otherwise fall through and be
//! rejected with `method_not_found`. [`ExitPlanModeHandler`] claims that
//! method and routes it through the same engine `request_input` channel used
//! by permission, elicitation, and `ask_user_question` — surfacing the plan
//! as a single "Approve this plan?" question — then answers with the Grok
//! wire response shape (`{"outcome":"approved"}` or `{"outcome":"rejected"}`).
//!
//! [`ask_user_question`]: super::ask_user_question

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use agent_client_protocol::{
    Agent, ConnectionTo, Dispatch, Error, HandleDispatchFrom, Handled, Responder, UntypedMessage,
};
use comet_proto::{UserInputAnswer, UserInputQuestion};
use serde::Deserialize;

use super::InputRequester;

const EXIT_PLAN_MODE_METHOD: &str = "_x.ai/exit_plan_mode";

/// The id used for the synthesized approval question. Stable so the engine
/// round-trip is lossless and tests can assert on it.
const APPROVAL_QUESTION_ID: &str = "exit_plan_mode";

/// Raw ACP extension request payload, mirroring Grok's
/// `ExitPlanModeExtRequest`. Unknown fields (including future additions to
/// the Grok payload) are ignored so an older Comet stays forward-compatible.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExitPlanModeRequest {
    session_id: String,
    tool_call_id: String,
    /// The plan text the agent wants approved, as markdown. May be empty if
    /// the agent wrote the plan to `plan_path` instead.
    #[serde(default)]
    plan: Option<String>,
    /// Path to a plan file the agent wrote. Comet does not read it — it is
    /// kept only as a string so an unrecognized field never fails the whole
    /// request.
    #[serde(default)]
    plan_path: Option<String>,
}

/// Handler registered on the ACP client builder. It is chained after the
/// typed permission/elicitation handlers, so it only ever sees dispatches
/// those handlers declined.
pub(super) struct ExitPlanModeHandler {
    input: Arc<Box<InputRequester>>,
    pending: Arc<AtomicBool>,
}

impl ExitPlanModeHandler {
    pub(super) fn new(input: Arc<Box<InputRequester>>, pending: Arc<AtomicBool>) -> Self {
        Self { input, pending }
    }
}

impl HandleDispatchFrom<Agent> for ExitPlanModeHandler {
    async fn handle_dispatch_from(
        &mut self,
        message: Dispatch,
        _connection: ConnectionTo<Agent>,
    ) -> Result<Handled<Dispatch>, Error> {
        let Dispatch::Request(request, responder) = message else {
            return Ok(Handled::No {
                message,
                retry: false,
            });
        };
        if request.method() != EXIT_PLAN_MODE_METHOD {
            return Ok(Handled::No {
                message: Dispatch::Request(request, responder),
                retry: false,
            });
        }
        self.respond_to_exit_plan_mode(request, responder)
            .await?;
        Ok(Handled::Yes)
    }

    fn describe_chain(&self) -> impl std::fmt::Debug {
        "ExitPlanModeHandler"
    }
}

impl ExitPlanModeHandler {
    async fn respond_to_exit_plan_mode(
        &mut self,
        request: UntypedMessage,
        responder: Responder<serde_json::Value>,
    ) -> Result<(), Error> {
        let request: ExitPlanModeRequest = match serde_json::from_value(request.params().clone()) {
            Ok(request) => request,
            Err(error) => {
                return responder
                    .respond_with_error(Error::invalid_params().data(error.to_string()));
            }
        };

        tracing::info!(
            target: "comet_harness::acp",
            session_id = %request.session_id,
            tool_call_id = %request.tool_call_id,
            plan_len = request.plan.as_deref().map(str::len).unwrap_or(0),
            plan_path = ?request.plan_path,
            "Received _x.ai/exit_plan_mode from agent"
        );

        self.pending.store(true, Ordering::Relaxed);
        let answers = (self.input.as_ref().as_ref())(approval_question(&request))
            .await
            .unwrap_or_default();
        self.pending.store(false, Ordering::Relaxed);

        let _ = responder.respond(grok_response(answers));
        Ok(())
    }
}

/// Build the single approval question shown to the user. The plan text (or
/// the plan-file path when the agent wrote one instead of passing inline
/// text) is embedded in the question body so the UI surfaces what is being
/// approved.
fn approval_question(request: &ExitPlanModeRequest) -> Vec<UserInputQuestion> {
    let body = request
        .plan
        .as_deref()
        .filter(|plan| !plan.trim().is_empty())
        .map(|plan| plan.to_string())
        .or_else(|| {
            request
                .plan_path
                .as_deref()
                .filter(|path| !path.trim().is_empty())
                .map(|path| format!("Plan written to `{path}`."))
        })
        .unwrap_or_else(|| "The agent wants to start implementing.".into());

    vec![UserInputQuestion {
        id: APPROVAL_QUESTION_ID.into(),
        header: "Approve plan".into(),
        question: format!("Approve this plan and start implementing?\n\n{body}"),
        options: vec!["Approve".into(), "Reject".into()],
        multi_select: false,
    }]
}

/// Translate the user's approval into the Grok wire response. "Approve" →
/// `{"outcome":"approved"}` (the agent proceeds to implement); anything else
/// — a "Reject" pick, a dismiss, or a dropped receiver — is
/// `{"outcome":"rejected"}` so the agent stays in plan mode instead of
/// silently proceeding.
fn grok_response(answers: Vec<UserInputAnswer>) -> serde_json::Value {
    let approved = answers
        .into_iter()
        .find(|answer| answer.question_id == APPROVAL_QUESTION_ID)
        .and_then(|answer| answer.labels.into_iter().next())
        .is_some_and(|label| label == "Approve");

    if approved {
        serde_json::json!({ "outcome": "approved" })
    } else {
        serde_json::json!({ "outcome": "rejected" })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request_json(plan: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "sessionId": "sess-1",
            "toolCallId": "tc-1",
            "plan": plan,
            "planPath": "plan.md",
        })
    }

    #[test]
    fn parses_grok_request_with_inline_plan() {
        let request: ExitPlanModeRequest =
            serde_json::from_value(request_json("## Plan\n1. Do thing".into())).unwrap();
        assert_eq!(request.plan.as_deref(), Some("## Plan\n1. Do thing"));
        assert_eq!(request.plan_path.as_deref(), Some("plan.md"));

        let question = &approval_question(&request)[0];
        assert_eq!(question.id, APPROVAL_QUESTION_ID);
        assert_eq!(question.options, vec!["Approve", "Reject"]);
        assert!(!question.multi_select);
        assert!(question.question.contains("## Plan\n1. Do thing"));
    }

    #[test]
    fn falls_back_to_plan_path_when_plan_text_is_empty() {
        let request: ExitPlanModeRequest =
            serde_json::from_value(request_json("".into())).unwrap();

        let question = &approval_question(&request)[0];
        assert!(question.question.contains("`plan.md`"));
    }

    #[test]
    fn falls_back_to_generic_body_when_neither_plan_nor_path() {
        let mut json = request_json("".into());
        json["planPath"] = serde_json::Value::Null;
        let request: ExitPlanModeRequest = serde_json::from_value(json).unwrap();

        let question = &approval_question(&request)[0];
        assert!(question.question.contains("start implementing"));
    }

    #[test]
    fn approve_label_produces_approved_response() {
        let response = grok_response(vec![UserInputAnswer {
            question_id: APPROVAL_QUESTION_ID.into(),
            labels: vec!["Approve".into()],
        }]);
        assert_eq!(response, serde_json::json!({ "outcome": "approved" }));
    }

    #[test]
    fn reject_label_produces_rejected_response() {
        let response = grok_response(vec![UserInputAnswer {
            question_id: APPROVAL_QUESTION_ID.into(),
            labels: vec!["Reject".into()],
        }]);
        assert_eq!(response, serde_json::json!({ "outcome": "rejected" }));
    }

    #[test]
    fn empty_answers_produce_rejected_response() {
        assert_eq!(
            grok_response(vec![]),
            serde_json::json!({ "outcome": "rejected" })
        );
        assert_eq!(
            grok_response(vec![UserInputAnswer {
                question_id: APPROVAL_QUESTION_ID.into(),
                labels: vec![],
            }]),
            serde_json::json!({ "outcome": "rejected" })
        );
    }
}

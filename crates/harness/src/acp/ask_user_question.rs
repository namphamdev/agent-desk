//! Bridge for Grok's private `_x.ai/ask_user_question` ACP extension method.
//!
//! Grok Build's internal `ask_user_question` tool does not use the standard
//! `session/request_permission` or `elicitation/create` methods. Instead it
//! sends an agent-initiated extension request over the wire as
//! `_x.ai/ask_user_question`, whose params are the raw
//! [`AskUserQuestionExtRequest`] payload:
//!
//! ```json
//! {
//!   "sessionId": "...",
//!   "toolCallId": "...",
//!   "questions": [
//!     {
//!       "question": "...",
//!       "options": [ { "label": "..." } ],
//!       "multiSelect": false
//!     }
//!   ],
//!   "mode": "default"
//! }
//! ```
//!
//! The SDK parses any `_*` method into an [`UntypedMessage`] fallback but
//! has no typed handler for it, so it would otherwise fall through and be
//! rejected with `method_not_found`. [`AskUserQuestionHandler`] claims that
//! method and routes it through the same engine `request_input` channel used
//! by permission and elicitation requests, then answers with the Grok wire
//! response shape (`{"outcome":"accepted","answers":{...}}` or
//! `{"outcome":"cancelled"}`).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use agent_client_protocol::{
    Agent, ConnectionTo, Dispatch, Error, HandleDispatchFrom, Handled, Responder, UntypedMessage,
};
use comet_proto::{UserInputAnswer, UserInputQuestion};
use serde::Deserialize;

use super::InputRequester;

const ASK_USER_QUESTION_METHOD: &str = "_x.ai/ask_user_question";

/// Raw ACP extension request payload, mirroring Grok's
/// `AskUserQuestionExtRequest`. Unknown fields (including future additions to
/// the Grok payload) are ignored so an older Comet stays forward-compatible.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AskUserQuestionRequest {
    session_id: String,
    tool_call_id: String,
    questions: Vec<GrokQuestion>,
    /// `default` or `plan`. Not used by Comet (the wizard has no plan-mode
    /// actions), kept only as a string so an unrecognized mode never fails
    /// the whole request.
    #[serde(default)]
    mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrokQuestion {
    question: String,
    options: Vec<GrokOption>,
    #[serde(default, alias = "multi_select")]
    multi_select: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct GrokOption {
    label: String,
}

/// Handler registered on the ACP client builder. It is chained after the
/// typed permission/elicitation handlers, so it only ever sees dispatches
/// those handlers declined.
pub(super) struct AskUserQuestionHandler {
    input: Arc<Box<InputRequester>>,
    pending: Arc<AtomicBool>,
}

impl AskUserQuestionHandler {
    pub(super) fn new(input: Arc<Box<InputRequester>>, pending: Arc<AtomicBool>) -> Self {
        Self { input, pending }
    }
}

impl HandleDispatchFrom<Agent> for AskUserQuestionHandler {
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
        if request.method() != ASK_USER_QUESTION_METHOD {
            return Ok(Handled::No {
                message: Dispatch::Request(request, responder),
                retry: false,
            });
        }
        self.respond_to_ask_user_question(request, responder)
            .await?;
        Ok(Handled::Yes)
    }

    fn describe_chain(&self) -> impl std::fmt::Debug {
        "AskUserQuestionHandler"
    }
}

impl AskUserQuestionHandler {
    async fn respond_to_ask_user_question(
        &mut self,
        request: UntypedMessage,
        responder: Responder<serde_json::Value>,
    ) -> Result<(), Error> {
        let request: AskUserQuestionRequest = match serde_json::from_value(request.params().clone())
        {
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
            question_count = request.questions.len(),
            mode = ?request.mode,
            "Received _x.ai/ask_user_question from agent"
        );

        let questions = grok_questions(&request);
        if questions.is_empty() {
            return responder.respond(serde_json::json!({ "outcome": "cancelled" }));
        }

        self.pending.store(true, Ordering::Relaxed);
        let answers = (self.input.as_ref().as_ref())(questions)
            .await
            .unwrap_or_default();
        self.pending.store(false, Ordering::Relaxed);

        responder.respond(grok_response(answers))
    }
}

/// Translate Grok questions into Comet's engine input questions.
///
/// The question text is used as the stable id because Grok keys accepted
/// answers by question text (not by an id). The wizard returns
/// [`UserInputAnswer`] with `question_id` set to the question id, so this
/// keeps the round trip lossless.
fn grok_questions(request: &AskUserQuestionRequest) -> Vec<UserInputQuestion> {
    request
        .questions
        .iter()
        .map(|question| UserInputQuestion {
            id: question.question.clone(),
            header: "Question".into(),
            question: question.question.clone(),
            options: question
                .options
                .iter()
                .map(|option| option.label.clone())
                .collect(),
            multi_select: question.multi_select.unwrap_or(false),
        })
        .collect()
}

/// Pack engine answers into the Grok accepted/cancelled wire response.
///
/// Unanswered questions (empty `labels`) are omitted, matching Grok's
/// "only answered questions appear" contract. If nothing was answered — a
/// dismiss, an interrupt, or a dropped receiver — the response is
/// `{"outcome":"cancelled"}` so the agent can continue instead of waiting on
/// its own timeout.
fn grok_response(answers: Vec<UserInputAnswer>) -> serde_json::Value {
    let answered: serde_json::Map<String, serde_json::Value> = answers
        .into_iter()
        .filter(|answer| !answer.labels.is_empty())
        .map(|answer| {
            (
                answer.question_id,
                serde_json::Value::Array(
                    answer
                        .labels
                        .into_iter()
                        .map(serde_json::Value::String)
                        .collect(),
                ),
            )
        })
        .collect();

    if answered.is_empty() {
        serde_json::json!({ "outcome": "cancelled" })
    } else {
        serde_json::json!({ "outcome": "accepted", "answers": answered })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request_json(questions: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "sessionId": "sess-1",
            "toolCallId": "tc-1",
            "questions": questions,
            "mode": "default",
        })
    }

    #[test]
    fn parses_grok_request_and_converts_questions() {
        let request: AskUserQuestionRequest =
            serde_json::from_value(request_json(serde_json::json!([
                {
                    "question": "Which database?",
                    "options": [
                        { "label": "Redis", "description": "In-memory", "id": "redis" },
                        { "label": "Postgres" }
                    ],
                    "multiSelect": false,
                    "id": "db"
                },
                {
                    "question": "Which features?",
                    "options": [
                        { "label": "Auth" },
                        { "label": "Logging" }
                    ],
                    "multiSelect": true
                },
                {
                    "question": "Any notes?",
                    "options": []
                }
            ])))
            .unwrap();

        let questions = grok_questions(&request);
        assert_eq!(questions.len(), 3);
        assert_eq!(questions[0].id, "Which database?");
        assert_eq!(questions[0].options, vec!["Redis", "Postgres"]);
        assert!(!questions[0].multi_select);
        assert_eq!(questions[1].options, vec!["Auth", "Logging"]);
        assert!(questions[1].multi_select);
        assert!(questions[2].options.is_empty());
        assert!(!questions[2].multi_select);
    }

    #[test]
    fn accepts_snake_case_multi_select_for_forward_compatibility() {
        let request: AskUserQuestionRequest =
            serde_json::from_value(request_json(serde_json::json!([{
                "question": "Pick any",
                "options": [{ "label": "A" }],
                "multi_select": true
            }])))
            .unwrap();
        assert!(grok_questions(&request)[0].multi_select);
    }

    #[test]
    fn accepted_response_keys_answers_by_question_text() {
        let response = grok_response(vec![
            UserInputAnswer {
                question_id: "Which database?".into(),
                labels: vec!["Redis".into()],
            },
            UserInputAnswer {
                question_id: "Which features?".into(),
                labels: vec!["Auth".into(), "Logging".into()],
            },
            UserInputAnswer {
                question_id: "Any notes?".into(),
                labels: vec![],
            },
        ]);

        assert_eq!(response["outcome"], "accepted");
        assert_eq!(
            response["answers"]["Which database?"],
            serde_json::json!(["Redis"])
        );
        assert_eq!(
            response["answers"]["Which features?"],
            serde_json::json!(["Auth", "Logging"])
        );
        assert!(response["answers"].get("Any notes?").is_none());
    }

    #[test]
    fn empty_answers_produce_cancelled_response() {
        assert_eq!(
            grok_response(vec![]),
            serde_json::json!({ "outcome": "cancelled" })
        );
        assert_eq!(
            grok_response(vec![UserInputAnswer {
                question_id: "Which database?".into(),
                labels: vec![],
            }]),
            serde_json::json!({ "outcome": "cancelled" })
        );
    }
}

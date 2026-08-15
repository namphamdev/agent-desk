//! The mini agent run loop — a direct, async, event-emitting port of
//! `src/minisweagent/agents/default.py` (`run` / `step` / `query` /
//! `execute_actions`).
//!
//! Linear message history lives in a `Vec<ChatMessage>` owned by the task.
//! The loop emits the full `AgentEvent` sequence (`SessionStarted`,
//! `TextDelta`/`ReasoningDelta`, `ToolCall(Exec)`, `ToolResult`, `Done`),
//! drains steers at turn boundaries, honors the interrupt token, and enforces
//! step/cost/wall-time/consecutive-format-error limits.

use std::time::Instant;

use comet_proto::{AgentEvent, DoneStatus, HarnessId, ToolCall as ProtoToolCall};
use tokio::sync::mpsc;

use comet_harness::{RunControls, SteerMessage};

use crate::config::MinsweConfig;
use crate::environment::{FinishCheck, LocalEnvironment};
use crate::messages::{ChatMessage, ToolCall as WireToolCall};
use crate::model::{Delta, ModelClient, ModelError};
use crate::prompts;

/// Drives one run to completion, emitting `AgentEvent`s on `event_tx`.
///
/// `model` and `env` are passed in so tests can inject a `MockModelClient`
/// and a real `LocalEnvironment` pointed at a tempdir.
pub async fn run_session(
    request: comet_proto::RunRequest,
    controls: RunControls,
    config: MinsweConfig,
    model: std::sync::Arc<dyn ModelClient>,
    env: LocalEnvironment,
    event_tx: mpsc::Sender<Result<AgentEvent, comet_harness::HarnessError>>,
    harness_id: HarnessId,
) {
    let RunControls {
        request_input: _,
        mut steering,
        interrupt,
        report_memory,
    } = controls;
    // `request_input` is unused — the mini agent never elicits; kept for API
    // symmetry with the other harnesses.

    let session_id = uuid::Uuid::new_v4().to_string();
    let assistant_message_id = uuid::Uuid::new_v4().to_string();
    let model_name = config
        .model
        .clone()
        .or_else(|| request.model.clone())
        .unwrap_or_else(|| "default".into());

    // Build the initial history: system message + rendered instance message.
    let info = prompts::SystemInfo::detect();
    let mut messages: Vec<ChatMessage> = Vec::new();
    messages.push(ChatMessage::system(prompts::render_system()));
    messages.push(ChatMessage::user(prompts::render_instance(
        &request.prompt,
        &info,
    )));
    // Inline staged image attachments as OpenAI image content (attachments are
    // absolute paths already staged by the composer). The mini agent speaks
    // OpenAI content blocks; we add them as a follow-on user message so the
    // system/instance templates stay verbatim.
    if !request.attachments.is_empty() {
        let content = attachments_user_text(&request.attachments);
        messages.push(ChatMessage::user(content));
    }

    // Announce the session. `cwd` is the env root.
    let _ = emit(
        &event_tx,
        AgentEvent::SessionStarted {
            harness: harness_id,
            model: model_name.clone(),
            tools: vec!["bash".into()],
            cwd: request.cwd.clone(),
            session_id: session_id.clone(),
            assistant_message_id: assistant_message_id.clone(),
        },
    )
    .await;

    let mut n_calls = 0u32;
    let mut n_consecutive_format_errors = 0u32;
    let mut cost = 0.0f64;
    let start = Instant::now();
    let mut final_status = DoneStatus::Completed;
    let mut final_result: Option<String> = None;
    let mut final_error: Option<String> = None;
    let mut interrupted = false;

    loop {
        // Limits (step / cost / wall-time) — checked at the top of each turn.
        if config.agent.step_limit > 0 && config.agent.step_limit <= n_calls {
            tracing::debug!(n_calls, "mini agent hit step limit");
            break;
        }
        if config.agent.cost_limit > 0.0 && config.agent.cost_limit <= cost {
            tracing::debug!(cost, "mini agent hit cost limit");
            break;
        }
        if config.agent.wall_time_limit_secs > 0
            && config.agent.wall_time_limit_secs as u64 <= start.elapsed().as_secs()
        {
            tracing::debug!("mini agent hit wall-time limit");
            break;
        }

        // Drain any steers queued since the last turn boundary into new user
        // messages (turn-boundary steering — delivered between turns).
        while let Ok(steer) = steering.try_recv() {
            let SteerMessage { prompt, .. } = steer;
            messages.push(ChatMessage::user(prompt));
        }

        // Query the model, streaming deltas live. Cancellation aborts the run.
        let event_tx_delta = event_tx.clone();
        let mut on_delta = |delta: Delta| {
            let event = match delta {
                Delta::Text(t) => AgentEvent::TextDelta { text: t },
                Delta::Reasoning(t) => AgentEvent::ReasoningDelta { text: t },
            };
            // best-effort non-blocking forward; the channel has capacity 256
            // and the consumer drains promptly. A dropped/closed channel just
            // means the caller stopped listening.
            let _ = event_tx_delta.try_send(Ok(event));
        };
        let query_result = tokio::select! {
            biased;
            _ = interrupt.cancelled() => {
                interrupted = true;
                break;
            }
            r = model.query(&messages, &mut on_delta) => r,
        };

        match query_result {
            Ok(assistant) => {
                n_calls += 1;
                // No USD price table in v1: accumulate cumulative output tokens
                // as the cost-limit proxy (a monotonic spend signal). USD
                // tracking is reserved behind `MinsweConfig::track_cost`.
                cost += assistant.usage.output_tokens as f64;
                n_consecutive_format_errors = 0;

                // Emit a token-usage meter event (always available; no USD).
                let _ = emit(
                    &event_tx,
                    AgentEvent::Usage {
                        input_tokens: assistant.usage.input_tokens,
                        output_tokens: assistant.usage.output_tokens,
                    },
                )
                .await;

                // Append the assistant turn to the history.
                let wire_calls: Vec<WireToolCall> = assistant
                    .actions
                    .iter()
                    .map(|a| WireToolCall {
                        id: a.tool_call_id.clone(),
                        name: "bash".into(),
                        arguments: serde_json::json!({ "command": a.command }).to_string(),
                    })
                    .collect();
                messages.push(ChatMessage::assistant(assistant.content.clone(), wire_calls));

                // Execute each action, emit ToolCall/ToolResult, append observations.
                let mut submitted: Option<String> = None;
                for action in &assistant.actions {
                    if interrupt.is_cancelled() {
                        interrupted = true;
                        break;
                    }
                    let _ = emit(
                        &event_tx,
                        AgentEvent::ToolCall {
                            id: action.tool_call_id.clone(),
                            call: ProtoToolCall::Exec {
                                command: action.command.clone(),
                            },
                        },
                    )
                    .await;
                    let (output, finish) = env
                        .execute(&action.command, config.command_timeout_secs, &interrupt)
                        .await;
                    let is_error = output.returncode != 0;
                    let _ = emit(
                        &event_tx,
                        AgentEvent::ToolResult {
                            id: action.tool_call_id.clone(),
                            is_error,
                        },
                    )
                    .await;
                    let observation = prompts::render_observation(&output);
                    messages.push(ChatMessage::tool(&action.tool_call_id, observation));

                    if let FinishCheck::Submitted(s) = finish {
                        submitted = Some(s);
                        break;
                    }
                }
                if let Some(submission) = submitted {
                    final_result = Some(submission);
                    break;
                }
            }
            Err(ModelError::Format(fe)) => {
                // Append the rendered format-error feedback and retry, unless
                // we've hit the consecutive-error ceiling (then Errored).
                n_consecutive_format_errors += 1;
                messages.push(ChatMessage::user(fe.feedback));
                let _ = emit(
                    &event_tx,
                    AgentEvent::Error {
                        message: "model response was not in the expected format".into(),
                    },
                )
                .await;
                if config.agent.max_consecutive_format_errors > 0
                    && config.agent.max_consecutive_format_errors <= n_consecutive_format_errors
                {
                    final_status = DoneStatus::Errored;
                    final_error = Some("RepeatedFormatError".into());
                    break;
                }
            }
            Err(ModelError::Http(e)) => {
                final_status = DoneStatus::Errored;
                final_error = Some(format!("model request failed: {e}"));
                break;
            }
        }
    }

    if interrupted {
        final_status = DoneStatus::Interrupted;
    }

    // report_memory is a no-op (no child process tree; the agent runs
    // in-process) — call once with None to honor the harness contract.
    (report_memory)(None);

    let _ = emit(
        &event_tx,
        AgentEvent::Done {
            status: final_status,
            result: final_result,
            error: final_error,
            session_id: Some(session_id),
        },
    )
    .await;
}

async fn emit(
    tx: &mpsc::Sender<Result<AgentEvent, comet_harness::HarnessError>>,
    event: AgentEvent,
) {
    // Best-effort: a send error means the caller dropped the stream.
    let _ = tx.send(Ok(event)).await;
}

/// Build the human-readable "attached images" user message. (We don't inline
/// raw bytes here — the prompt text already carries the staged-path refs the
/// doc persists; this is the additive content-block path.)
fn attachments_user_text(paths: &[String]) -> String {
    let mut s = String::from("Attached images (local files):\n");
    for p in paths {
        s.push_str("- ");
        s.push_str(p);
        s.push('\n');
    }
    s
}

use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{
    AnyTooltip, App, BorderStyle, Bounds, ClipboardEntry, ClipboardItem, Context, CursorStyle,
    DispatchPhase, ElementInputHandler, Entity, EntityInputHandler, EventEmitter, FocusHandle,
    Focusable, GlobalElementId, KeyBinding, KeyDownEvent, LayoutId, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, ObjectFit, PaintQuad, PathPromptOptions, Pixels, Point,
    ScrollWheelEvent, SharedString, Style, StyledImage as _, Subscription, Task, TextRun,
    TextStyle, UTF16Selection, UnderlineStyle, Window, WrappedLine, actions, div, fill, img, point,
    prelude::*, px, quad, relative, size,
};
use unicode_segmentation::UnicodeSegmentation;

use comet_doc::{MessagePart, MessageRole, SessionCommandPayload, SessionMessageEntry};
use comet_proto::{FileSearchMatch, RunRequest, SteeringMode, UserInputAnswer, UserInputQuestion};
use comet_rpc::{RpcError, methods};

use crate::attachments::{self, StagedAttachment};
use crate::motion;
use crate::pickers::Pickers;
use crate::state::{AppState, Indicator};
use crate::theme::Theme;

use super::*;

impl Composer {
    pub fn start_thread(
        &mut self,
        source: comet_proto::Chat,
        seed_text: String,
        seed_role: MessageRole,
        purpose: &'static str,
        title: String,
        initial_prompt: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if self.sending {
            return;
        }
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            self.failure = Some("Engine not connected".into());
            cx.notify();
            return;
        };
        let Some(space_id) = source.space_id.clone() else {
            self.failure = Some("This session is not attached to a space".into());
            cx.notify();
            return;
        };
        let chat_id = uuid::Uuid::new_v4().to_string();
        let created_at = chrono::Utc::now();
        let mut chat = source.clone();
        chat.id = chat_id.clone();
        chat.title = Some(title.clone());
        chat.archived = false;
        chat.last_message_preview = None;
        chat.last_message_at = None;
        chat.created_at = created_at;
        chat.harness_session_id = None;
        chat.harness_session_cwd = None;
        chat.last_seen_at = Some(created_at);

        self.state.update(cx, |state, cx| {
            state.chats.push(chat);
            state.set_thread_seed(
                chat_id.clone(),
                crate::state::ThreadSeed {
                    text: seed_text.clone(),
                    role: seed_role,
                    purpose,
                    created_at: created_at.timestamp_millis(),
                },
            );
            state.select_chat(Some(chat_id.clone()), cx);
            cx.notify();
        });
        self.failure = None;
        self.sending = true;
        cx.notify();

        let source_id = source.id;
        let cwd = source.cwd;
        let branch = source.branch;
        let config = source.config;
        self.send_task = Some(cx.spawn(async move |this, cx| {
            let mut create = serde_json::json!({
                "op": "createChat",
                "chatId": chat_id,
                "spaceId": space_id,
                "seedContext": {
                    "text": seed_text,
                    "role": if seed_role == MessageRole::User { "user" } else { "assistant" },
                    "purpose": purpose,
                    "createdAt": created_at.timestamp_millis(),
                },
            });
            if let Some(object) = create.as_object_mut() {
                if let Some(cwd) = cwd {
                    object.insert("cwd".into(), serde_json::Value::String(cwd));
                }
                if let Some(branch) = branch {
                    object.insert("branch".into(), serde_json::Value::String(branch));
                }
                if let Some(config) = config.and_then(|value| serde_json::to_value(value).ok()) {
                    object.insert("config".into(), config);
                }
            }
            let result: Result<(), String> = async {
                engine
                    .client()
                    .call(methods::MUTATE, create)
                    .await
                    .map_err(|err| format!("New thread failed: {err}"))?;
                let _ = engine
                    .client()
                    .call(
                        methods::MUTATE,
                        serde_json::json!({
                            "op": "renameChat",
                            "chatId": chat_id,
                            "title": title,
                        }),
                    )
                    .await;
                Ok(())
            }
            .await;
            this.update(cx, |composer, cx| {
                composer.sending = false;
                match result {
                    Ok(()) => {
                        if let Some(prompt) = initial_prompt {
                            composer.send(prompt, false, cx);
                        }
                    }
                    Err(message) => {
                        composer.failure = Some(message.into());
                        composer.state.update(cx, |state, cx| {
                            state.chats.retain(|chat| chat.id != chat_id);
                            state.take_thread_seed(&chat_id);
                            state.select_chat(Some(source_id), cx);
                        });
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// Queue a Run (or Steer) doc command with an optimistic echo. New chats
    /// thread the picked config in: worktree creation (when the isolated toggle
    /// is on), `Mutate createChat` with the `ChatConfig` + cwd, and the model /
    /// reasoning / options on the Run request itself (§1.7).
    pub(crate) fn send(&mut self, text: String, steer: bool, cx: &mut Context<Self>) {
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            self.failure = Some("Engine not connected".into());
            cx.notify();
            return;
        };
        // Chat id: existing selection, or client-minted for the new-chat canvas
        // (the chat then appears from the doc host once the doc materializes).
        let (chat_id, is_new) = match self.state.read(cx).selected_chat.clone() {
            Some(id) => (id, false),
            None => (uuid::Uuid::new_v4().to_string(), true),
        };
        // Where the new session runs (Current checkout / reuse an existing
        // worktree / fresh worktree off the picked base) — resolved NOW so
        // the async block needs no picker access.
        let plan = self.pickers.read(cx).checkout_plan();
        // Fully-resolved model/reasoning/options — concrete values (chat config
        // or defaults), so the engine never has to guess a "default".
        let resolved = self.pickers.read(cx).resolved(cx);
        let existing_cwd = self
            .state
            .read(cx)
            .selected_chat_row()
            .and_then(|c| c.cwd.clone());
        // The SPACE fixes the new chat's device + base folder — this is the
        // behavioral core of spaces: sessions are minted onto the space's
        // device, not necessarily this one.
        let space = self.state.read(cx).selected_space_row().cloned();
        if is_new && space.is_none() {
            self.failure = Some("Add a space first".into());
            cx.notify();
            return;
        }
        let local_device_id = self.state.read(cx).local_device_id.clone();
        let device_id = if is_new {
            space
                .as_ref()
                .map(|s| s.device_id.clone())
                .unwrap_or_else(|| "local".to_string())
        } else {
            self.state
                .read(cx)
                .selected_chat_row()
                .map(|c| c.device_id.clone())
                .or_else(|| local_device_id.clone())
                .unwrap_or_else(|| "local".to_string())
        };
        // Uploads/read-backs target the chat's HOST device (forwardable RPCs);
        // for a new chat that's the space's device (None when it's local).
        let host_device_id = if is_new {
            space
                .as_ref()
                .map(|s| s.device_id.clone())
                .filter(|id| local_device_id.as_deref() != Some(id.as_str()))
        } else {
            self.state
                .read(cx)
                .selected_chat_row()
                .map(|c| c.device_id.clone())
        };
        let space_id = space.as_ref().map(|s| s.id.clone());
        let space_path = space.as_ref().map(|s| s.path.clone());
        let space_remote = space
            .as_ref()
            .is_some_and(|s| local_device_id.as_deref() != Some(s.device_id.as_str()));
        // Snapshot-and-clear NOW (use-attachments.ts takeAttachments): the
        // strip empties the instant you hit send; a failure hands the files
        // back into the chat's stash.
        let staged = self
            .attachments
            .remove(&self.current_key)
            .unwrap_or_default();
        self.preview = None;
        let message_id = uuid::Uuid::new_v4().to_string();
        let created_at = chrono::Utc::now().timestamp_millis();

        // Image-only sends echo the same body `with_attachments` will use, so
        // the bubble never renders empty (refs are upserted in post-upload).
        let mut final_text = text.clone();
        let mut chat_title: Option<String> = None;
        if is_new {
            use crate::workflows::{
                build_workflow_prompt, load_project_workflows, resolve_workflows,
                workflow_session_title,
            };
            let shell_settings = self
                .state
                .read(cx)
                .data_dir
                .as_deref()
                .map(crate::settings::UiSettings::load)
                .unwrap_or_default();
            let project_workflows = space
                .as_ref()
                .filter(|space| local_device_id.as_deref() == Some(space.device_id.as_str()))
                .map(|space| load_project_workflows(std::path::Path::new(&space.path)))
                .unwrap_or_default();
            let resolved = resolve_workflows(&shell_settings.workflows, &project_workflows);
            if let Some(w_id) = &self.selected_workflow_id {
                if let Some(w) = resolved.workflows.iter().find(|w| &w.id == w_id) {
                    let pr_ref = self.pr_ref_input.read(cx).text();
                    final_text = build_workflow_prompt(
                        w,
                        &text,
                        if pr_ref.is_empty() {
                            None
                        } else {
                            Some(pr_ref)
                        },
                    );
                    chat_title = Some(workflow_session_title(
                        w,
                        &text,
                        if pr_ref.is_empty() {
                            None
                        } else {
                            Some(pr_ref)
                        },
                    ));
                }
            }
        }
        let echo_text = if final_text.is_empty() && !staged.is_empty() {
            attachments::ATTACHMENT_ONLY_TEXT.to_string()
        } else {
            final_text.clone()
        };

        // Optimistic echo (client-minted id doubles as the persisted message id,
        // so the doc frame dedups it away).
        let echo = SessionMessageEntry {
            id: message_id.clone(),
            role: comet_doc::MessageRole::User,
            parts: vec![MessagePart::Text {
                id: "t0".into(),
                text: echo_text.clone(),
            }],
            created_at,
            device_id: "local".into(),
            status: None,
            continuation_of: None,
        };
        self.state.update(cx, |s, cx| {
            if is_new {
                s.select_chat(Some(chat_id.clone()), cx);
            }
            s.push_echo(&chat_id, echo);
            cx.notify();
        });

        self.input.update(cx, |input, cx| input.set_text("", cx));
        self.drafts.remove(&self.current_key);
        self.failure = None;
        self.sending = true;
        cx.emit(ComposerEvent::Sent {
            chat_id: chat_id.clone(),
        });
        cx.notify();

        let steer_cmd = steer && !is_new;
        let thread_seed = if steer_cmd {
            None
        } else {
            self.state
                .update(cx, |state, _| state.take_thread_seed(&chat_id))
        };
        let retry_seed = thread_seed.clone();
        let restore_text = text.clone();
        let err_chat_id = chat_id.clone();
        let err_message_id = message_id.clone();
        self.send_task = Some(cx.spawn(async move |this, cx| {
            let result: Result<(), String> = async {
                // Resolve the working directory: existing chats keep theirs;
                // new chats run per the checkout plan (t3code env-mode): the
                // space's folder as-is, an EXISTING worktree of the picked ref
                // (a plain cwd override — multiple sessions share one
                // worktree), or a fresh isolated worktree created off the
                // picked base ref (CreateWorktree on send, targeted at the
                // space's device; the RPC relay-forwards).
                let mut cwd = if is_new {
                    space_path.clone()
                } else {
                    existing_cwd
                }
                .unwrap_or_else(|| ".".to_string());
                let mut worktree_cwd: Option<String> = None;
                // The picked ref rides createChat so the session footer names
                // it from the first frame (it read "Select ref" until the
                // host's diff reconciler got around to stamping the branch).
                let mut chat_branch: Option<String> = None;
                if is_new {
                    match &plan {
                        crate::pickers::CheckoutPlan::CurrentCheckout { branch } => {
                            chat_branch = branch.clone();
                        }
                        crate::pickers::CheckoutPlan::ReuseWorktree { path, branch } => {
                            cwd = path.clone();
                            worktree_cwd = Some(path.clone());
                            chat_branch = Some(branch.clone());
                        }
                        crate::pickers::CheckoutPlan::NewWorktree { base } => {
                            chat_branch = base.clone();
                            if let (Some(repo_path), Some(base)) = (&space_path, base) {
                                let mut params = serde_json::json!({
                                    "repoPath": repo_path,
                                    "branch": base,
                                });
                                if space_remote
                                    && let Some(object) = params.as_object_mut()
                                {
                                    object.insert(
                                        "targetDeviceId".into(),
                                        serde_json::Value::String(device_id.clone()),
                                    );
                                }
                                let value = engine
                                    .client()
                                    .call(methods::CREATE_WORKTREE, params)
                                    .await
                                    .map_err(|e| format!("Worktree failed: {e}"))?;
                                let worktree: comet_proto::Worktree = serde_json::from_value(value)
                                    .map_err(|e| format!("Worktree reply malformed: {e}"))?;
                                cwd = worktree.path.clone();
                                worktree_cwd = Some(worktree.path);
                            }
                        }
                    }
                }

                // Best-effort Mutate createChat with the picked config: the
                // engine resolves device + cwd from the SPACE row (idempotent;
                // the doc host would materialize the chat on first command
                // anyway, so failures are non-fatal).
                if is_new && let Some(space_id) = &space_id {
                    let mut mutate = serde_json::json!({
                        "op": "createChat",
                        "chatId": chat_id,
                        "spaceId": space_id,
                    });
                    if let Some(object) = mutate.as_object_mut() {
                        if let Some(worktree_cwd) = &worktree_cwd {
                            object.insert(
                                "cwd".into(),
                                serde_json::Value::String(worktree_cwd.clone()),
                            );
                        }
                        if let Some(branch) = &chat_branch {
                            object.insert(
                                "branch".into(),
                                serde_json::Value::String(branch.clone()),
                            );
                        }
                        if let Some(title) = &chat_title {
                            object.insert("title".into(), serde_json::Value::String(title.clone()));
                        }
                        if let Some(config) = resolved.chat_config()
                            && let Ok(config) = serde_json::to_value(&config)
                        {
                            object.insert("config".into(), config);
                        }
                    }
                    if let Err(err) = engine.client().call(methods::MUTATE, mutate).await {
                        tracing::warn!(error = %err, "CreateChat mutate unavailable; doc host will materialize the chat");
                    }
                    if let Some(title) = &chat_title {
                        let _ = engine
                            .client()
                            .call(
                                methods::MUTATE,
                                serde_json::json!({
                                    "op": "renameChat",
                                    "chatId": chat_id,
                                    "title": title
                                }),
                            )
                            .await;
                    }
                }

                // Stage every attachment on the host device (sequential — the
                // chunks share one channel), then thread the refs into the
                // prompt text (`with_attachments`, the persisted transport)
                // and the paths onto the Run request (inline image blocks).
                let mut content = final_text.clone();
                let mut attachment_paths: Vec<String> = Vec::new();
                if !staged.is_empty() {
                    for att in &staged {
                        match attachments::upload_attachment(
                            &engine,
                            cx.background_executor(),
                            host_device_id.as_deref(),
                            att,
                        )
                        .await
                        {
                            Ok(path) => attachment_paths.push(path),
                            Err(err) => {
                                tracing::warn!(name = %att.name, error = %err, "attachment upload failed");
                                return Err(
                                    "Couldn't upload the attachment — the device may be offline."
                                        .to_string(),
                                );
                            }
                        }
                    }
                    // Seed the transcript cache from local bytes so the sent
                    // bubble's thumbnails never round-trip (seedTranscript-
                    // Attachment in the original send path).
                    let seed_device = host_device_id.clone().unwrap_or_else(|| device_id.clone());
                    for (path, att) in attachment_paths.iter().zip(&staged) {
                        attachments::seed_attachment(&seed_device, path, &att.name, att.image.clone());
                        if seed_device != device_id {
                            attachments::seed_attachment(&device_id, path, &att.name, att.image.clone());
                        }
                    }
                    content = attachments::with_attachments(&final_text, &attachment_paths);
                    // Refresh the echo in place with the attachment refs
                    // (same id, same clock — the bubble grows its thumbnails
                    // without flickering).
                    let refreshed = SessionMessageEntry {
                        id: message_id.clone(),
                        role: comet_doc::MessageRole::User,
                        parts: vec![MessagePart::Text {
                            id: "t0".into(),
                            text: content.clone(),
                        }],
                        created_at,
                        device_id: "local".into(),
                        status: None,
                        continuation_of: None,
                    };
                    let echo_chat_id = chat_id.clone();
                    this.update(cx, |composer, cx| {
                        composer.state.update(cx, |s, cx| {
                            s.remove_echo(&echo_chat_id, &message_id);
                            s.push_echo(&echo_chat_id, refreshed);
                            cx.notify();
                        });
                    })
                    .ok();
                }

                let command = if steer_cmd {
                    SessionCommandPayload::Steer {
                        prompt: content.clone(),
                        message_id: Some(message_id.clone()),
                    }
                } else {
                    SessionCommandPayload::Run {
                        request: RunRequest {
                            prompt: content.clone(),
                            harness: resolved.harness,
                            model: resolved.model.clone(),
                            reasoning: resolved.reasoning,
                            model_options: resolved.model_options.clone(),
                            cwd,
                            sandbox: resolved.permission_mode.sandbox(),
                            auto_approve: resolved.permission_mode.auto_approve(),
                            resume: None,
                            seed: thread_seed.as_ref().map(|seed| seed.text.clone()),
                            seed_purpose: thread_seed
                                .as_ref()
                                .map(|seed| seed.purpose.to_string()),
                            seed_role: thread_seed.as_ref().map(|seed| {
                                if seed.role == MessageRole::User {
                                    "user"
                                } else {
                                    "assistant"
                                }
                                .to_string()
                            }),
                            attachments: attachment_paths,
                            acp_agent_id: resolved.chat_config().as_ref().and_then(|c| c.acp_agent_id.clone()),
                            custom_provider: None,
                        },
                        message_id: message_id.clone(),
                    }
                };
                let command = serde_json::to_value(&command)
                    .map_err(|e| format!("Send failed: {e}"))?;
                let params = serde_json::json!({ "chatId": chat_id, "command": command });
                engine
                    .client()
                    .call(methods::QUEUE_COMMAND, params)
                    .await
                    .map_err(|e| format!("Send failed: {e}"))?;
                Ok(())
            }
            .await;
            this.update(cx, |composer, cx| {
                composer.sending = false;
                if let Err(message) = result {
                    // Failure: red banner, echo removed, prompt back in the
                    // draft, staged files back in the chat's stash.
                    composer.failure = Some(message.into());
                    composer.state.update(cx, |s, cx| {
                        s.remove_echo(&err_chat_id, &err_message_id);
                        if let Some(seed) = retry_seed.clone() {
                            s.restore_thread_seed(err_chat_id.clone(), seed);
                        }
                        cx.notify();
                    });
                    composer.input.update(cx, |input, cx| input.set_text(restore_text, cx));
                    if !staged.is_empty() {
                        // Merge by id (stashAttachments): files the user staged
                        // while the send was in flight survive the hand-back.
                        let slot = composer.attachments.entry(err_chat_id.clone()).or_default();
                        let mut merged = staged.clone();
                        merged.extend(
                            slot.drain(..)
                                .filter(|e| !staged.iter().any(|f| f.id == e.id)),
                        );
                        *slot = merged;
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    pub(crate) fn interrupt(&mut self, cx: &mut Context<Self>) {
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        let Some(chat_id) = self.state.read(cx).selected_chat.clone() else {
            return;
        };
        let params = serde_json::json!({
            "chatId": chat_id,
            "command": { "kind": "interrupt" },
        });
        self.send_task = Some(cx.spawn(async move |this, cx| {
            let result = engine.client().call(methods::QUEUE_COMMAND, params).await;
            if let Err(err) = result {
                this.update(cx, |composer, cx| {
                    composer.failure = Some(format!("Stop failed: {err}").into());
                    cx.notify();
                })
                .ok();
            }
        }));
    }

    // ---- wizard glue ----

    pub(crate) fn wizard_select(&mut self, option_ix: usize, cx: &mut Context<Self>) {
        let Some(wizard) = self.wizard.as_mut() else {
            return;
        };
        let step = wizard.select(option_ix);
        let has_pick = wizard.page_has_pick();
        self.input.update(cx, |input, cx| {
            input.set_placeholder(
                if has_pick {
                    "Type your own answer, or leave this blank to use the selected option"
                } else {
                    "Type your own answer, or pick an option above"
                },
                cx,
            )
        });
        match step {
            WizardStep::AutoAdvance => self.schedule_auto_advance(cx),
            WizardStep::Done(answers) => self.wizard_finish(answers, cx),
            WizardStep::Stay => {}
        }
        cx.notify();
    }

    pub(crate) fn schedule_auto_advance(&mut self, cx: &mut Context<Self>) {
        self.advance_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(AUTO_ADVANCE_MS))
                .await;
            this.update(cx, |composer, cx| composer.wizard_advance(cx))
                .ok();
        }));
    }

    pub(crate) fn wizard_advance(&mut self, cx: &mut Context<Self>) {
        let Some(wizard) = self.wizard.as_mut() else {
            return;
        };
        match wizard.advance() {
            WizardStep::Done(answers) => self.wizard_finish(answers, cx),
            _ => {
                // Moving on: clear the shared free-text input for the next page.
                self.input.update(cx, |input, cx| input.set_text("", cx));
                cx.notify();
            }
        }
    }


}

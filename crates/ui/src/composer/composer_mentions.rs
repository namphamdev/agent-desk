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
    pub(crate) fn reset_mention(&mut self, dismissed: Option<(Range<usize>, String)>, cx: &mut Context<Self>) {
        let request = self.mention.request.wrapping_add(1);
        self.mention_task = None;
        self.mention = FileMentionState {
            request,
            dismissed,
            ..FileMentionState::default()
        };
        self.sync_mention_controls(cx);
    }

    pub(crate) fn on_input_edited(&mut self, cx: &mut Context<Self>) {
        if self.wizard.is_some() {
            if self.mention.token.is_some() || self.mention_task.is_some() {
                self.reset_mention(None, cx);
            }
            return;
        }
        let (token, still_dismissed) = {
            let input = self.input.read(cx);
            let text = input.text();
            let cursor = input.cursor_offset();
            let token = mention_token(text, cursor);
            // The dismissed-range text comparison needs the live text; compute
            // it here while we hold the borrow instead of cloning 65k+ chars
            // on every keystroke.
            let still_dismissed = token.as_ref().is_some_and(|token| {
                self.mention
                    .dismissed
                    .as_ref()
                    .is_some_and(|(range, value)| {
                        token.range == *range && text.get(range.clone()) == Some(value.as_str())
                    })
            });
            (token, still_dismissed)
        };
        if still_dismissed {
            self.mention.token = None;
            self.mention_task = None;
            self.sync_mention_controls(cx);
            cx.notify();
            return;
        }
        self.mention.dismissed = None;
        if token == self.mention.token {
            self.sync_mention_controls(cx);
            cx.notify();
            return;
        }
        self.mention.request = self.mention.request.wrapping_add(1);
        self.mention_task = None;
        // Refining an open menu keeps the stale rows visible until the new
        // response lands — clearing here made the popup bounce through the
        // skeleton (and a different height) on every keystroke.
        let refining = self.mention.token.is_some() && token.is_some();
        self.mention.token = token.clone();
        if !refining {
            self.mention.results.clear();
            self.mention.active = None;
        }
        self.mention.error = None;
        self.mention.loading = token.is_some();
        self.sync_mention_controls(cx);
        let Some(token) = token else {
            cx.notify();
            return;
        };
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            self.mention.loading = false;
            cx.notify();
            return;
        };
        let selected_worktree = match self.pickers.read(cx).checkout_plan() {
            crate::pickers::CheckoutPlan::ReuseWorktree { path, .. } => Some(path),
            _ => None,
        };
        let (params, target) = {
            let state = self.state.read(cx);
            let mut params = serde_json::Map::new();
            params.insert("query".into(), token.query.clone().into());
            let target = if let Some(chat) = state.selected_chat_row() {
                params.insert("chatId".into(), chat.id.clone().into());
                Some(chat.device_id.clone())
            } else if let Some(space) = state.selected_space_row() {
                params.insert("spaceId".into(), space.id.clone().into());
                if let Some(path) = selected_worktree {
                    params.insert("path".into(), path.into());
                }
                Some(space.device_id.clone())
            } else {
                None
            };
            if let Some(target) = &target {
                params.insert("targetDeviceId".into(), target.clone().into());
            }
            (serde_json::Value::Object(params), target)
        };
        if target.is_none() {
            self.mention.loading = false;
            cx.notify();
            return;
        }
        let request = self.mention.request;
        self.mention_task = Some(cx.spawn(async move |this, cx| {
            // A short debounce prevents one full workspace walk per keystroke
            // during normal typing. The generation check below still guards
            // requests that were already in flight when the query changed.
            cx.background_executor()
                .timer(Duration::from_millis(80))
                .await;
            let mut result = engine
                .client()
                .call(methods::SEARCH_FILES, params.clone())
                .await;
            if matches!(result, Err(RpcError::Transport(_)) | Err(RpcError::Closed)) {
                // One retry rides out a cold relay dial to the host device
                // (the diffs pane retries forever; a keystroke-scoped search
                // gets a single second chance).
                cx.background_executor()
                    .timer(Duration::from_millis(250))
                    .await;
                result = engine.client().call(methods::SEARCH_FILES, params).await;
            }
            this.update(cx, |composer, cx| {
                if !mention_response_is_current(&composer.mention, request) {
                    return;
                }
                composer.mention.loading = false;
                match result {
                    Ok(value) => match serde_json::from_value::<Vec<FileSearchMatch>>(value) {
                        Ok(results) => {
                            composer.mention.error = None;
                            composer.mention.active = (!results.is_empty()).then_some(0);
                            composer.mention.results = results;
                        }
                        Err(err) => tracing::warn!(%err, "file mention response decode failed"),
                    },
                    Err(err) => {
                        tracing::warn!(%err, "file mention search failed");
                        composer.mention.results.clear();
                        composer.mention.active = None;
                        composer.mention.error = Some(mention_error_message(&err));
                    }
                }
                composer.sync_mention_controls(cx);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    pub(crate) fn move_mention(&mut self, delta: isize, cx: &mut Context<Self>) {
        self.mention.active =
            crate::popover::menu_step(self.mention.active, self.mention.results.len(), delta);
        self.sync_mention_controls(cx);
        cx.notify();
    }

    pub(crate) fn dismiss_mention(&mut self, cx: &mut Context<Self>) {
        let dismissed = self.mention.token.as_ref().and_then(|token| {
            self.input
                .read(cx)
                .text()
                .get(token.range.clone())
                .map(|text| (token.range.clone(), text.to_string()))
        });
        self.reset_mention(dismissed, cx);
        cx.notify();
    }

    pub(crate) fn accept_mention(&mut self, cx: &mut Context<Self>) {
        let Some(token) = self.mention.token.clone() else {
            return;
        };
        let Some((path, is_dir)) = self
            .mention
            .active
            .and_then(|active| self.mention.results.get(active))
            .map(|result| (result.path.clone(), result.is_dir))
        else {
            return;
        };
        self.input.update(cx, |input, cx| {
            input.replace_mention(token.range, &path, is_dir, cx)
        });
        self.reset_mention(None, cx);
        cx.notify();
    }

    pub(crate) fn render_file_mention_popup(
        &self,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> Option<gpui::AnyElement> {
        let token = self.mention.token.as_ref()?;
        let mut card = crate::popover::popover_card(theme)
            .w(px(380.0))
            .max_h(px(280.0))
            .overflow_hidden()
            .on_mouse_down_out(cx.listener(|this, _, _, cx| this.dismiss_mention(cx)));
        if self.mention.loading && self.mention.results.is_empty() {
            card = card.child(crate::popover::skeleton_rows(
                "file-mention-loading",
                theme,
                3,
                cx.entity_id(),
                cx,
            ));
        } else if let Some(error) = self.mention.error.clone() {
            card = card.child(
                div()
                    .px(px(12.0))
                    .py(px(10.0))
                    .text_size(px(12.0))
                    .text_color(theme.danger_muted)
                    .child(error),
            );
        } else if self.mention.results.is_empty() {
            card = card.child(
                div()
                    .px(px(12.0))
                    .py(px(10.0))
                    .text_size(px(12.0))
                    .text_color(theme.text_muted)
                    .child(if token.query.is_empty() {
                        "No files available"
                    } else {
                        "No matching files"
                    }),
            );
        } else {
            for (ix, result) in self.mention.results.iter().enumerate() {
                let selected = self.mention.active == Some(ix);
                let path = result.path.clone();
                let tooltip_path: SharedString = path.clone().into();
                card = card.child(
                    crate::popover::menu_row(theme, selected, format!("file-mention-result-{ix}"))
                        .id(("file-mention-result", ix))
                        .tooltip(move |_, cx| {
                            cx.new(|_| MentionPathTooltip {
                                path: tooltip_path.clone(),
                                activation: ix as u64,
                            })
                            .into()
                        })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.mention.active = Some(ix);
                            this.accept_mention(cx);
                        }))
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(8.0))
                                .child(
                                    crate::icons::icon(if result.is_dir {
                                        crate::icons::FOLDER
                                    } else {
                                        crate::icons::DOCUMENT
                                    })
                                    .size(px(14.0))
                                    .text_color(theme.text_muted),
                                )
                                .child(
                                    div()
                                        .min_w_0()
                                        .flex_1()
                                        .overflow_hidden()
                                        .truncate()
                                        .text_size(px(12.5))
                                        .text_color(theme.text)
                                        .child(path),
                                ),
                        ),
                );
            }
        }
        let anchor = self
            .input
            .read(cx)
            .visible_point_for_index(token.range.start)?;
        Some(crate::popover::anchored_menu_above_at(
            "file-mention-popup",
            anchor,
            card.into_any_element(),
        ))
    }

    pub(crate) fn render_input_with_completion(&self, theme: &Theme, cx: &mut Context<Self>) -> gpui::Div {
        div()
            .relative()
            .child(self.input.clone())
            .children(self.render_file_mention_popup(theme, cx))
    }

    pub(crate) fn on_state_changed(&mut self, cx: &mut Context<Self>) {
        let (key, space_id, pending) = {
            let s = self.state.read(cx);
            (
                s.selected_chat.clone().unwrap_or_default(),
                s.selected_space.clone(),
                pending_input_request(&s.transcript),
            )
        };
        if space_id != self.workflow_space_id {
            self.workflow_space_id = space_id;
            self.selected_workflow_id = None;
            self.pr_ref_input
                .update(cx, |input, cx| input.set_text("", cx));
            self.input
                .update(cx, |input, cx| input.set_placeholder("Do anything…", cx));
        }

        // Draft swap on chat navigation — the input entity itself survives.
        if key != self.current_key {
            let old_text = self.input.read(cx).text().to_string();
            if old_text.is_empty() {
                self.drafts.remove(&self.current_key);
            } else {
                self.drafts.insert(self.current_key.clone(), old_text);
            }
            let draft = self.drafts.get(&key).cloned().unwrap_or_default();
            self.current_key = key;
            self.selected_workflow_id = None;
            self.pr_ref_input.update(cx, |i, cx| i.set_text("", cx));
            self.failure = None;
            self.wizard = None;
            // Attachments stay stashed under their chat key (the map swap IS
            // the navigation); only the transient chrome resets.
            self.preview = None;
            self.reset_mention(None, cx);
            // Route changes snap (round 5/6): a mode difference between the
            // old and new session's composer must not glide across
            // navigation. Killing the in-flight morph here isn't enough —
            // the nav-driven flip only commits AFTER the swapped draft has
            // been re-measured, one or two renders later, so the whole
            // window snaps (see ROUTE_SNAP_MS).
            self.flip_morph = None;
            self.last_rendered_height = 0.0;
            self.route_snap_until = Some(Instant::now() + Duration::from_millis(ROUTE_SNAP_MS));
            self.input.update(cx, |input, cx| {
                input.set_placeholder("Do anything…", cx);
                input.set_text(draft, cx);
            });
        }

        // Question panel lifecycle (wizard state cached per request id).
        match pending {
            Some((request_id, questions)) if !self.answered_requests.contains(&request_id) => {
                let same = self
                    .wizard
                    .as_ref()
                    .is_some_and(|w| w.request_id == request_id);
                if !same {
                    self.reset_mention(None, cx);
                    self.wizard = Some(Wizard::new(request_id, questions));
                    self.advance_task = None;
                    // The shared input becomes the panel's free-text override.
                    self.input.update(cx, |input, cx| {
                        input.set_placeholder("Type your own answer, or pick an option above", cx)
                    });
                }
            }
            _ => {
                if let Some(wizard) = self.wizard.as_ref() {
                    // LATCH (original composer.tsx `inputLatch`): a transient
                    // fold/sync blip — or a steer appended behind the
                    // streaming entry — must not unmount the panel and lose
                    // the user's picks. Release only on explicit resolution
                    // (here or on another device) or when a NON-EMPTY
                    // transcript shows the question superseded (a newer
                    // assistant entry took over). Never on run death: the
                    // question stays answerable until answered — the engine
                    // delivers a dead run's answer as a resumed turn.
                    let transcript = self.state.read(cx).transcript.clone();
                    let released = input_request_resolved(&transcript, &wizard.request_id)
                        || (!transcript.is_empty()
                            && !self.answered_requests.contains(&wizard.request_id));
                    if released {
                        self.wizard = None;
                        self.advance_task = None;
                        self.input
                            .update(cx, |input, cx| input.set_placeholder("Do anything…", cx));
                    }
                }
            }
        }
        cx.notify();
    }

    pub(crate) fn run_live(&self, cx: &App) -> bool {
        let s = self.state.read(cx);
        let Some(chat_id) = s.selected_chat.as_deref() else {
            return false;
        };
        matches!(
            s.indicator_for(chat_id, chrono::Utc::now()),
            Indicator::Working | Indicator::AwaitingInput
        )
    }

    pub(crate) fn button_mode(&self, cx: &App) -> SendButtonMode {
        // A staged image counts as content: image-only sends are legal
        // (the prompt body becomes "See the attached image(s).").
        let has_pr_ref = self.state.read(cx).selected_chat.is_none()
            && self.selected_workflow_id.is_some()
            && !self.pr_ref_input.read(cx).text().trim().is_empty();
        let has_text = !self.input.read(cx).text().trim().is_empty()
            || has_pr_ref
            || !self.staged().is_empty();
        send_button_mode(self.run_live(cx), has_text)
    }

    pub(crate) fn on_submit(&mut self, cx: &mut Context<Self>) {
        if self.wizard.is_some() {
            // Enter inside the panel's free-text input submits the page.
            let typed = self.input.read(cx).text().trim().to_string();
            if let Some(w) = self.wizard.as_mut() {
                w.set_typed(typed);
            }
            self.wizard_advance(cx);
            return;
        }
        let text = self.input.read(cx).text().trim().to_string();
        let pr_ref_only = self.state.read(cx).selected_chat.is_none()
            && self.selected_workflow_id.is_some()
            && !self.pr_ref_input.read(cx).text().trim().is_empty();
        match self.button_mode(cx) {
            SendButtonMode::Stop => self.interrupt(cx),
            _ if text.is_empty() && self.staged().is_empty() && !pr_ref_only => {}
            SendButtonMode::Send => self.send(text, false, cx),
            SendButtonMode::Steer => self.send(text, true, cx),
        }
    }
}

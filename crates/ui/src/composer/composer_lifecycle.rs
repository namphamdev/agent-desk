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
    pub fn new(state: Entity<AppState>, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| {
            let mut input = ComposerInput::new("Do anything…", cx);
            input.enable_mentions();
            input
        });
        let pr_ref_input = cx.new(|cx| ComposerInput::new("#42 or pull request URL", cx));
        let pickers = cx.new(|cx| Pickers::new(state.clone(), cx));
        // The footer toolbar (checkout kind + ref picker) is rendered INLINE
        // by the composer from picker state — a pickers-side notify (refs
        // loaded, popover toggled, pick made) must repaint the composer too.
        let pickers_observe = cx.observe(&pickers, |_, _, cx| cx.notify());
        let observe = cx.observe(&state, |this: &mut Self, _, cx| this.on_state_changed(cx));
        let input_events = cx.subscribe(&input, |this: &mut Self, _, event, cx| match event {
            ComposerInputEvent::Submitted => this.on_submit(cx),
            ComposerInputEvent::Edited | ComposerInputEvent::CursorMoved => {
                this.on_input_edited(cx)
            }
            ComposerInputEvent::ViewportChanged => cx.notify(),
            ComposerInputEvent::MentionNavigate(delta) => this.move_mention(*delta, cx),
            ComposerInputEvent::MentionAccept => this.accept_mention(cx),
            ComposerInputEvent::MentionDismiss => this.dismiss_mention(cx),
            ComposerInputEvent::PastedImages(images) => {
                let staged = images
                    .iter()
                    .map(|image| attachments::stage_clipboard_image(image.clone()))
                    .collect();
                this.add_staged(staged, cx);
            }
            ComposerInputEvent::PastedPaths(paths) => this.add_paths(paths.clone(), cx),
        });
        let pr_ref_events =
            cx.subscribe(&pr_ref_input, |this: &mut Self, _, event, cx| match event {
                ComposerInputEvent::Submitted => this.on_submit(cx),
                ComposerInputEvent::Edited => cx.notify(),
                ComposerInputEvent::PastedImages(_) | ComposerInputEvent::PastedPaths(_) => {}
                _ => {}
            });
        let current_key = state.read(cx).selected_chat.clone().unwrap_or_default();
        let workflow_space_id = state.read(cx).selected_space.clone();
        let mut composer = Self {
            state,
            input,
            pickers,
            drafts: HashMap::new(),
            attachments: HashMap::new(),
            preview: None,
            picker_task: None,
            mention_task: None,
            mention: FileMentionState::default(),
            current_key,
            selected_workflow_id: None,
            workflow_space_id,
            pr_ref_input,
            sending: false,
            failure: None,
            wizard: None,
            wizard_focus: cx.focus_handle(),
            answered_requests: HashSet::new(),
            advance_task: None,
            send_task: None,
            expanded_mode: false,
            flip_epoch: 0,
            compact_capacity: 0.0,
            expanded_anchor: 0.0,
            last_seen_width: 0.0,
            width_changed_at: None,
            settle_task: None,
            flip_morph: None,
            last_rendered_height: 0.0,
            morph_clock: Instant::now(),
            route_snap_until: None,
            _observe: observe,
            _pickers_observe: pickers_observe,
            _input_events: input_events,
            _pr_ref_events: pr_ref_events,
        };
        // Dev knob: pre-stage attachments (drop/paste can't be synthesized on
        // a rig) — `COMET_ATTACH=/path/a.png[,/path/b.png]`, and
        // `COMET_ATTACH_PREVIEW=1` boots with the first one's lightbox open.
        if let Ok(spec) = std::env::var("COMET_ATTACH") {
            let staged: Vec<StagedAttachment> = spec
                .split(',')
                .filter(|s| !s.trim().is_empty())
                .filter_map(|path| {
                    match attachments::stage_file(std::path::Path::new(path.trim())) {
                        Ok(att) => Some(att),
                        Err(err) => {
                            tracing::warn!(%path, error = %err, "COMET_ATTACH stage failed");
                            None
                        }
                    }
                })
                .collect();
            if std::env::var("COMET_ATTACH_PREVIEW").is_ok_and(|v| v == "1")
                && let Some(first) = staged.first()
            {
                composer.preview = Some(attachments::PreviewImage {
                    name: first.name.clone().into(),
                    image: first.image.clone(),
                });
            }
            if !staged.is_empty() {
                composer
                    .attachments
                    .entry(composer.current_key.clone())
                    .or_default()
                    .extend(staged);
            }
        }
        composer
    }

    pub fn is_sending(&self) -> bool {
        self.sending
    }

    /// Capture-knob passthrough (`COMET_OPEN_DIALOG=model`): open the
    /// combined harness/model menu.
    pub fn debug_open_model_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.pickers
            .update(cx, |pickers, cx| pickers.open_model_menu(window, cx));
    }

    pub fn invalidate_model_catalogs(&mut self, cx: &mut Context<Self>) {
        self.pickers
            .update(cx, |pickers, cx| pickers.invalidate_model_catalogs(cx));
        cx.notify();
    }

    // ---- attachment staging (use-attachments.ts) ----

    /// Staged attachments for the chat the composer is showing.
    pub(crate) fn staged(&self) -> &[StagedAttachment] {
        self.attachments
            .get(&self.current_key)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    pub(crate) fn add_staged(&mut self, staged: Vec<StagedAttachment>, cx: &mut Context<Self>) {
        if staged.is_empty() {
            return;
        }
        self.attachments
            .entry(self.current_key.clone())
            .or_default()
            .extend(staged);
        cx.notify();
    }

    /// Stage image files (picker / drop / pasted paths). Non-images are
    /// skipped silently (matching the original's `image/*` filter); read
    /// failures and oversize files surface in the failure notice.
    pub(crate) fn add_paths(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        let mut staged = Vec::new();
        for path in &paths {
            if attachments::format_by_extension(path).is_none() {
                continue;
            }
            match attachments::stage_file(path) {
                Ok(att) => staged.push(att),
                Err(message) => {
                    self.failure = Some(message.into());
                    cx.notify();
                }
            }
        }
        self.add_staged(staged, cx);
    }

    pub(crate) fn remove_attachment(&mut self, id: &str, cx: &mut Context<Self>) {
        if let Some(list) = self.attachments.get_mut(&self.current_key) {
            list.retain(|a| a.id != id);
            if list.is_empty() {
                self.attachments.remove(&self.current_key);
            }
        }
        cx.notify();
    }

    /// Drop a deleted chat's per-chat composer state — staged attachments hold
    /// raw image bytes, and a deleted chat's stage could never be sent again.
    pub fn purge_chat(&mut self, chat_id: &str) {
        self.attachments.remove(chat_id);
    }

    /// The staged-thumbnail strip (attachment-ui.tsx AttachmentStrip):
    /// `flex flex-wrap gap-2 px-4 pt-3`, 56px rounded thumbs, a remove button
    /// revealed on hover, click opens the full-size preview.
    pub(crate) fn render_attachment_strip(&self, theme: &Theme, cx: &mut Context<Self>) -> Option<gpui::Div> {
        let staged = self.staged();
        if staged.is_empty() {
            return None;
        }
        let mut strip = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .gap(px(STRIP_GAP))
            .px(px(STRIP_PAD_X))
            .pt(px(STRIP_PAD_TOP));
        for (ix, att) in staged.iter().enumerate() {
            let group: SharedString = format!("composer-att-{}", att.id).into();
            let preview = attachments::PreviewImage {
                name: att.name.clone().into(),
                image: att.image.clone(),
            };
            let remove_id = att.id.clone();
            strip = strip.child(
                div()
                    .group(group.clone())
                    .relative()
                    .child(
                        div()
                            .id(("composer-att-thumb", ix))
                            .size(px(STRIP_THUMB))
                            .rounded(px(8.0))
                            .overflow_hidden()
                            .border_1()
                            .border_color(crate::theme::hairline(0.10))
                            .cursor_pointer()
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.preview = Some(preview.clone());
                                cx.notify();
                            }))
                            .child(
                                img(att.image.clone())
                                    .size_full()
                                    .object_fit(ObjectFit::Cover),
                            ),
                    )
                    .child(
                        div()
                            .id(("composer-att-remove", ix))
                            .absolute()
                            .top(px(-6.0))
                            .right(px(-6.0))
                            .size(px(18.0))
                            .rounded_full()
                            .bg(theme.bg)
                            .flex()
                            .items_center()
                            .justify_center()
                            .cursor_pointer()
                            .shadow_sm()
                            .opacity(0.0)
                            .group_hover(group, |s| s.opacity(1.0))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.remove_attachment(&remove_id, cx);
                            }))
                            .child(
                                crate::icons::icon(crate::icons::CLOSE_CIRCLE)
                                    .size(px(14.0))
                                    .text_color(theme.text_muted),
                            ),
                    ),
            );
        }
        Some(strip)
    }

    /// Paperclip: the native image picker (the original's hidden
    /// `<input type=file accept=image/* multiple>`).
    pub(crate) fn open_file_picker(&mut self, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Attach".into()),
        });
        self.picker_task = Some(cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = rx.await {
                this.update(cx, |composer, cx| composer.add_paths(paths, cx))
                    .ok();
            }
        }));
    }

    pub(crate) fn sync_mention_controls(&mut self, cx: &mut Context<Self>) {
        let open = self.mention.token.is_some();
        let has_selection = self.mention.active.is_some();
        self.input.update(cx, |input, cx| {
            input.set_mention_controls(open, has_selection, cx)
        });
    }
}

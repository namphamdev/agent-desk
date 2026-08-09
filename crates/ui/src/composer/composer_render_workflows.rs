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
    pub(crate) fn render_workflows_canvas(
        &self,
        theme: &crate::theme::Theme,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        use crate::settings::UiSettings;
        use crate::workflows::{load_project_workflows, resolve_workflows};
        use gpui::prelude::*;
        use gpui::{div, px};

        let shell_settings = self
            .state
            .read(cx)
            .data_dir
            .as_deref()
            .map(UiSettings::load)
            .unwrap_or_default();
        let project_workflows = {
            let state = self.state.read(cx);
            state
                .selected_space_row()
                .filter(|space| state.local_device_id.as_deref() == Some(space.device_id.as_str()))
                .map(|space| load_project_workflows(std::path::Path::new(&space.path)))
                .unwrap_or_default()
        };

        let resolved = resolve_workflows(&shell_settings.workflows, &project_workflows);

        let mut row = div().flex().flex_row().flex_wrap().gap(px(8.0));

        let free_chat_selected = self.selected_workflow_id.is_none();

        row = row.child(
            div()
                .id("workflow-free-chat")
                .p(px(8.0))
                .rounded_md()
                .border_1()
                .border_color(if free_chat_selected {
                    theme.accent
                } else {
                    theme.border
                })
                .bg(if free_chat_selected {
                    theme.accent.opacity(0.1)
                } else {
                    theme.surface
                })
                .cursor_pointer()
                .on_click(cx.listener(|this, _, _, cx| {
                    this.selected_workflow_id = None;
                    this.pr_ref_input.update(cx, |i, cx| i.set_text("", cx));
                    this.input
                        .update(cx, |input, cx| input.set_placeholder("Do anything…", cx));
                    cx.notify();
                }))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .child(div().text_size(px(12.0)).child("Free chat"))
                        .child(
                            div()
                                .mt(px(2.0))
                                .text_size(px(10.0))
                                .text_color(theme.text_muted)
                                .child("Send the message as written"),
                        ),
                ),
        );

        for w in &resolved.workflows {
            let is_selected = self.selected_workflow_id.as_ref() == Some(&w.id);
            let id = w.id.clone();
            let label = w.label.clone();
            let description = w.description.clone();
            let needs_pr_ref = w.needs_pr_ref;
            let placeholder = w.task_placeholder.clone();

            row = row.child(
                div()
                    .id(SharedString::from(format!("workflow-{id}")))
                    .p(px(8.0))
                    .rounded_md()
                    .border_1()
                    .border_color(if is_selected {
                        theme.accent
                    } else {
                        theme.border
                    })
                    .bg(if is_selected {
                        theme.accent.opacity(0.1)
                    } else {
                        theme.surface
                    })
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.selected_workflow_id = Some(id.clone());
                        if !needs_pr_ref {
                            this.pr_ref_input.update(cx, |i, cx| i.set_text("", cx));
                        }
                        this.input.update(cx, |input, cx| {
                            input.set_placeholder(placeholder.clone(), cx)
                        });
                        cx.notify();
                    }))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .child(div().text_size(px(12.0)).child(label))
                            .child(
                                div()
                                    .mt(px(2.0))
                                    .text_size(px(10.0))
                                    .text_color(theme.text_muted)
                                    .child(description),
                            ),
                    ),
            );
        }

        let mut container = div().flex().flex_col().gap(px(8.0)).child(row);

        if let Some(workflow_id) = &self.selected_workflow_id {
            if let Some(w) = resolved.workflows.iter().find(|w| &w.id == workflow_id) {
                if w.needs_pr_ref {
                    container = container.child(
                        div()
                            .w_full()
                            .mt(px(8.0))
                            .p(px(8.0))
                            .border_1()
                            .border_color(theme.border)
                            .rounded_md()
                            .bg(theme.surface)
                            .child(self.pr_ref_input.clone()),
                    );
                }
            }
        }

        container
    }
}

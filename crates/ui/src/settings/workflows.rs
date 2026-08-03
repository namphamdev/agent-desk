use std::path::PathBuf;

use gpui::{App, Context, Entity, EventEmitter, Window, div, prelude::*, px};

use crate::composer::ComposerInput;
use crate::settings::widgets;
use crate::state::AppState;
use crate::theme::Theme;
use crate::workflows::{
    WorkflowDefinition, builtin_workflows, normalize_workflow_list, parse_workflow_json,
    project_workflows_path, save_project_workflows,
};

#[derive(Debug, Clone)]
pub enum WorkflowsEvent {
    GlobalChanged(Vec<WorkflowDefinition>),
}

pub struct WorkflowsPage {
    state: Entity<AppState>,
    global_editor: Entity<ComposerInput>,
    project_editor: Entity<ComposerInput>,
    project_path: Option<PathBuf>,
    global_error: Option<String>,
    project_error: Option<String>,
    save_success: Option<String>,
    _observation: gpui::Subscription,
}

impl EventEmitter<WorkflowsEvent> for WorkflowsPage {}

impl WorkflowsPage {
    pub fn new(
        global_workflows: Vec<WorkflowDefinition>,
        state: Entity<AppState>,
        cx: &mut Context<Self>,
    ) -> Self {
        let global_json = if global_workflows.is_empty() {
            String::new()
        } else {
            serde_json::to_string_pretty(&global_workflows).unwrap_or_default()
        };
        let global_editor = cx.new(|cx| {
            let mut input = ComposerInput::new("[]", cx);
            input.set_text(global_json, cx);
            input
        });
        let project_editor = cx.new(|cx| ComposerInput::new("[]", cx));
        let mut this = Self {
            state: state.clone(),
            global_editor,
            project_editor,
            project_path: None,
            global_error: None,
            project_error: None,
            save_success: None,
            _observation: cx.observe(&state, |_, _, cx| cx.notify()),
        };
        this.load_project_file(cx);
        this
    }

    fn selected_local_cwd(&self, cx: &App) -> Option<String> {
        let state = self.state.read(cx);
        let local_device_id = state.local_device_id.as_deref()?;
        state
            .selected_space_row()
            .filter(|space| space.device_id == local_device_id)
            .map(|space| space.path.clone())
    }

    fn load_project_file(&mut self, cx: &mut Context<Self>) {
        let cwd = self.selected_local_cwd(cx);
        self.project_path = cwd
            .as_deref()
            .map(std::path::Path::new)
            .map(project_workflows_path);
        self.project_error = None;
        let text = match cwd {
            Some(cwd) => {
                let path = project_workflows_path(std::path::Path::new(&cwd));
                match std::fs::read_to_string(&path) {
                    Ok(text) => match parse_workflow_json(&text) {
                        Ok(workflows) => {
                            serde_json::to_string_pretty(&workflows).unwrap_or_default()
                        }
                        Err(error) => {
                            self.project_error =
                                Some(format!("{} is invalid: {error}", path.display()));
                            text
                        }
                    },
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
                    Err(error) => {
                        self.project_error =
                            Some(format!("Could not read {}: {error}", path.display()));
                        String::new()
                    }
                }
            }
            None => String::new(),
        };
        self.project_editor
            .update(cx, |editor, cx| editor.set_text(text, cx));
    }

    fn save_global(&mut self, cx: &mut Context<Self>) {
        self.global_error = None;
        self.save_success = None;
        let text = self.global_editor.read(cx).text().to_string();
        let parsed = if text.trim().is_empty() {
            Vec::new()
        } else {
            match parse_workflow_json(&text) {
                Ok(workflows) => workflows,
                Err(error) => {
                    self.global_error = Some(format!("Invalid JSON: {error}"));
                    cx.notify();
                    return;
                }
            }
        };
        cx.emit(WorkflowsEvent::GlobalChanged(normalize_workflow_list(
            parsed,
        )));
        self.save_success = Some("Global overrides saved".into());
        cx.notify();
    }

    fn clear_global(&mut self, cx: &mut Context<Self>) {
        self.global_editor
            .update(cx, |editor, cx| editor.set_text("", cx));
        self.save_global(cx);
    }

    fn load_builtins(&mut self, cx: &mut Context<Self>) {
        let text = serde_json::to_string_pretty(&builtin_workflows()).unwrap_or_default();
        self.global_editor
            .update(cx, |editor, cx| editor.set_text(text, cx));
        self.global_error = None;
        self.save_success = None;
        cx.notify();
    }

    fn save_project(&mut self, cx: &mut Context<Self>) {
        self.project_error = None;
        self.save_success = None;
        let Some(cwd) = self.selected_local_cwd(cx) else {
            self.project_error =
                Some("Project workflows can only be edited on the space's owning device".into());
            cx.notify();
            return;
        };
        let text = self.project_editor.read(cx).text().to_string();
        let parsed = if text.trim().is_empty() {
            Vec::new()
        } else {
            match parse_workflow_json(&text) {
                Ok(workflows) => workflows,
                Err(error) => {
                    self.project_error = Some(format!("Invalid JSON: {error}"));
                    cx.notify();
                    return;
                }
            }
        };
        match save_project_workflows(std::path::Path::new(&cwd), &parsed) {
            Ok(()) => {
                self.project_path = Some(project_workflows_path(std::path::Path::new(&cwd)));
                self.save_success = Some(if parsed.is_empty() {
                    "Project overrides cleared".into()
                } else {
                    "Project overrides saved".into()
                });
            }
            Err(error) => {
                self.project_error = Some(format!("Failed to save project file: {error}"));
            }
        }
        cx.notify();
    }

    fn clear_project(&mut self, cx: &mut Context<Self>) {
        self.project_editor
            .update(cx, |editor, cx| editor.set_text("", cx));
        self.save_project(cx);
    }
}

impl Render for WorkflowsPage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let selected_path = self
            .selected_local_cwd(cx)
            .as_deref()
            .map(std::path::Path::new)
            .map(project_workflows_path);
        if selected_path != self.project_path {
            self.load_project_file(cx);
        }
        let theme = Theme::of(cx);

        let global_row = widgets::card_row(theme, false).child(
            div()
                .min_w_0()
                .flex_1()
                .child(widgets::row_title(theme, "Global Overrides"))
                .child(widgets::meta_line(
                    theme,
                    vec![
                        div()
                            .child("Override default built-in workflows for all spaces.")
                            .into_any_element(),
                    ],
                ))
                .child(
                    div()
                        .mt(px(8.0))
                        .h(px(200.0))
                        .overflow_hidden()
                        .bg(theme.surface)
                        .border_1()
                        .border_color(theme.border)
                        .rounded_md()
                        .p(px(8.0))
                        .child(self.global_editor.clone()),
                )
                .when_some(self.global_error.clone(), |el, err| {
                    el.child(
                        div()
                            .mt(px(4.0))
                            .text_color(gpui::rgba(0xff0000ff))
                            .child(err),
                    )
                })
                .child(
                    div()
                        .flex()
                        .gap_2()
                        .mt(px(8.0))
                        .child(
                            crate::popover::btn_primary(theme, "Save")
                                .id("workflows-save-global")
                                .on_click(cx.listener(|this, _, _, cx| this.save_global(cx))),
                        )
                        .child(
                            widgets::ghost_action(theme)
                                .id("workflows-clear-global")
                                .child("Clear")
                                .on_click(cx.listener(|this, _, _, cx| this.clear_global(cx))),
                        )
                        .child(
                            widgets::ghost_action(theme)
                                .id("workflows-load-builtins")
                                .child("Load built-ins")
                                .on_click(cx.listener(|this, _, _, cx| this.load_builtins(cx))),
                        ),
                ),
        );

        let project_row = widgets::card_row(theme, false).child(
            div()
                .min_w_0()
                .flex_1()
                .child(widgets::row_title(
                    theme,
                    "Project Overrides (.comet/workflows.json)",
                ))
                .child(widgets::meta_line(
                    theme,
                    vec![
                        div()
                            .child("Override workflows for the currently selected space.")
                            .into_any_element(),
                    ],
                ))
                .child(
                    div()
                        .mt(px(8.0))
                        .h(px(200.0))
                        .overflow_hidden()
                        .bg(theme.surface)
                        .border_1()
                        .border_color(theme.border)
                        .rounded_md()
                        .p(px(8.0))
                        .child(self.project_editor.clone()),
                )
                .when_some(self.project_error.clone(), |el, err| {
                    el.child(
                        div()
                            .mt(px(4.0))
                            .text_color(gpui::rgba(0xff0000ff))
                            .child(err),
                    )
                })
                .child(
                    div()
                        .flex()
                        .gap_2()
                        .mt(px(8.0))
                        .child(
                            crate::popover::btn_primary(theme, "Save")
                                .id("workflows-save-project")
                                .on_click(cx.listener(|this, _, _, cx| this.save_project(cx))),
                        )
                        .child(
                            widgets::ghost_action(theme)
                                .id("workflows-clear-project")
                                .child("Clear")
                                .on_click(cx.listener(|this, _, _, cx| this.clear_project(cx))),
                        ),
                ),
        );

        div()
            .id("workflows-page")
            .size_full()
            .overflow_y_scroll()
            .child(
                widgets::page_column()
                    .child(widgets::page_header(theme, "Workflows", None))
                    .child(widgets::page_subtitle(
                        theme,
                        "Configure task workflows and prompt templates.",
                    ))
                    .when_some(self.save_success.clone(), |el, msg| {
                        el.child(widgets::badge(theme, msg))
                    })
                    .child(
                        widgets::section_card(theme)
                            .child(global_row)
                            .child(project_row),
                    ),
            )
    }
}

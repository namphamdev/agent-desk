//! `impl Changes` block #5: the commit form — agent/model pickers, the
//! "AI message" generator trigger, subject/body inputs, the commit button,
//! and the right-click file context menu.

use gpui::{AnyElement, ClipboardItem, Context, SharedString, div, prelude::*, px};

use comet_rpc::methods;

use crate::popover;
use crate::theme::Theme;

use super::resolve::GitGenerationPicker;
use super::{Changes, COMMIT_DESC_MAX_H};

impl Changes {
    pub(super) fn render_generation_controls(&mut self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let disabled = self.git_busy.is_some() || self.generation_loading || self.git_generating;
        let harness_label = self
            .selected_harness
            .and_then(|selected| {
                // ACP agents share `HarnessId::Acp`, so match on the agent id
                // too — otherwise every ACP agent resolves the first one's
                // name (or the generic "ACP Agent").
                self.harnesses.iter().find(|descriptor| {
                    descriptor.id == selected
                        && descriptor.acp_agent_id == self.selected_acp_agent
                })
            })
            .map(|descriptor| descriptor.name.clone())
            .unwrap_or_else(|| {
                if self.generation_loading {
                    "Loading clients…".into()
                } else {
                    "Select client".into()
                }
            });
        let model_label = self
            .selected_model
            .as_deref()
            .and_then(|selected| self.models.iter().find(|model| model.id == selected))
            .map(|model| model.label.clone())
            .unwrap_or_else(|| {
                if self.generation_loading {
                    "Loading models…".into()
                } else {
                    "Select model".into()
                }
            });
        let selector = |id: &'static str, label: String| {
            div()
                .id(id)
                .h(px(28.0))
                .min_w_0()
                .flex_1()
                .px(px(8.0))
                .flex()
                .items_center()
                .gap(px(5.0))
                .rounded(px(6.0))
                .border_1()
                .border_color(theme.border)
                .text_size(px(10.0))
                .text_color(if disabled {
                    theme.text_faint
                } else {
                    theme.text_muted
                })
                .when(!disabled, |el| {
                    el.cursor_pointer()
                        .hover(|style| style.bg(crate::theme::white_alpha(0.05)))
                })
                .child(div().flex_1().min_w_0().truncate().child(label))
                .child(
                    crate::icons::icon(crate::icons::ALT_ARROW_DOWN)
                        .size(px(10.0))
                        .text_color(theme.text_faint),
                )
        };

        let harness_picker = if self.generation_picker == Some(GitGenerationPicker::Harness) {
            let rows = self
                .harnesses
                .iter()
                .enumerate()
                .map(|(ix, descriptor)| {
                    let harness = descriptor.id;
                    let acp_agent_id = descriptor.acp_agent_id.clone();
                    // For ACP, two installed agents share `HarnessId::Acp` —
                    // the agent id is what marks the right row as selected.
                    let selected = self.selected_harness == Some(harness)
                        && self.selected_acp_agent == acp_agent_id;
                    div()
                        .id(SharedString::from(format!("git-harness-{ix}")))
                        .h(px(30.0))
                        .px(px(Theme::SPACE_MD))
                        .flex()
                        .items_center()
                        .text_size(px(11.0))
                        .text_color(if selected {
                            theme.text
                        } else {
                            theme.text_muted
                        })
                        .bg(if selected {
                            crate::theme::white_alpha(0.05)
                        } else {
                            gpui::transparent_black()
                        })
                        .cursor_pointer()
                        .hover(|style| style.bg(crate::theme::white_alpha(0.07)))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.select_harness(harness, acp_agent_id.clone(), cx);
                        }))
                        .child(SharedString::from(descriptor.name.clone()))
                        .into_any_element()
                })
                .collect::<Vec<_>>();
            let menu = popover::popover_card(theme)
                .w(px(200.0))
                .mt(px(16.0))
                .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                    this.generation_picker = None;
                    cx.notify();
                }))
                .child(
                    div()
                        .id("git-harness-list")
                        .flex()
                        .flex_col()
                        .max_h(px(240.0))
                        .overflow_y_scroll()
                        .track_scroll(&self.generation_scroll)
                        .children(rows),
                );
            Some(popover::anchored_menu(
                "git-harness-popover",
                menu.into_any_element(),
            ))
        } else {
            None
        };

        let model_picker = if self.generation_picker == Some(GitGenerationPicker::Model) {
            let query = self.model_search.read(cx).text().to_string();
            let labels = self
                .models
                .iter()
                .map(|model| {
                    format!(
                        "{} {} {}",
                        model.label,
                        model.id,
                        model.description.as_deref().unwrap_or_default()
                    )
                })
                .collect::<Vec<_>>();
            let filtered_indices = popover::filter_indices(&query, &labels);
            let rows = filtered_indices
                .iter()
                .map(|&ix| {
                    let model = &self.models[ix];
                    let model_id = model.id.clone();
                    let model_label = model.label.clone();
                    let selected = self.selected_model.as_deref() == Some(model.id.as_str());
                    div()
                        .id(SharedString::from(format!("git-model-{ix}")))
                        .h(px(30.0))
                        .px(px(Theme::SPACE_MD))
                        .flex()
                        .items_center()
                        .text_size(px(11.0))
                        .text_color(if selected {
                            theme.text
                        } else {
                            theme.text_muted
                        })
                        .bg(if selected {
                            crate::theme::white_alpha(0.05)
                        } else {
                            gpui::transparent_black()
                        })
                        .cursor_pointer()
                        .hover(|style| style.bg(crate::theme::white_alpha(0.07)))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.selected_model = Some(model_id.clone());
                            if let Some(harness) = this.selected_harness {
                                this.generation_defaults.remember_model(
                                    harness,
                                    model_id.clone(),
                                    model_label.clone(),
                                );
                                this.save_generation_defaults();
                            }
                            this.generation_picker = None;
                            this.model_search.update(cx, |input, cx| {
                                input.set_text("", cx);
                            });
                            cx.notify();
                        }))
                        .child(SharedString::from(self.models[ix].label.clone()))
                        .into_any_element()
                })
                .collect::<Vec<_>>();
            let search =
                popover::search_input_frame(theme, self.model_search.clone().into_any_element());
            let menu = popover::popover_card(theme)
                .w(px(200.0))
                .mt(px(16.0))
                .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                    this.generation_picker = None;
                    this.model_search.update(cx, |input, cx| {
                        input.set_text("", cx);
                    });
                    cx.notify();
                }))
                .child(search)
                .child(
                    div()
                        .id("git-model-list")
                        .flex()
                        .flex_col()
                        .max_h(px(200.0))
                        .overflow_y_scroll()
                        .track_scroll(&self.generation_scroll)
                        .children(rows),
                );
            Some(popover::anchored_menu(
                "git-model-popover",
                menu.into_any_element(),
            ))
        } else {
            None
        };
        let can_generate = !disabled
            && self.selected_harness.is_some()
            && self.selected_model.is_some()
            && self
                .git_status
                .as_ref()
                .is_some_and(|status| !status.files.is_empty());

        div()
            .flex_none()
            .flex()
            .flex_col()
            .border_b_1()
            .border_color(crate::theme::white_alpha(0.05))
            .child(
                div()
                    .h(px(40.0))
                    .px(px(Theme::SPACE_MD))
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(
                        selector("git-harness-select", harness_label)
                            .when(!disabled, |el| {
                                el.on_click(cx.listener(|this, _, _, cx| {
                                    this.generation_picker = if this.generation_picker
                                        == Some(GitGenerationPicker::Harness)
                                    {
                                        None
                                    } else {
                                        Some(GitGenerationPicker::Harness)
                                    };
                                    if this.harnesses.is_empty() {
                                        this.load_generation_options(cx);
                                    }
                                    cx.notify();
                                }))
                            })
                            .when_some(harness_picker, |el, menu| el.child(menu)),
                    )
                    .child(
                        selector("git-model-select", model_label)
                            .when(!disabled, |el| {
                                el.on_click(cx.listener(|this, _, _, cx| {
                                    let closing =
                                        this.generation_picker == Some(GitGenerationPicker::Model);
                                    this.generation_picker = if this.generation_picker
                                        == Some(GitGenerationPicker::Model)
                                    {
                                        None
                                    } else {
                                        Some(GitGenerationPicker::Model)
                                    };
                                    if closing {
                                        this.model_search.update(cx, |input, cx| {
                                            input.set_text("", cx);
                                        });
                                    }
                                    cx.notify();
                                }))
                            })
                            .when_some(model_picker, |el, menu| el.child(menu)),
                    )
                    .child(
                        div()
                            .id("git-generate-message")
                            .h(px(28.0))
                            .px(px(9.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.0))
                            .border_1()
                            .border_color(theme.border)
                            .text_size(px(10.0))
                            .text_color(if can_generate {
                                theme.text
                            } else {
                                theme.text_faint
                            })
                            .when(can_generate, |el| {
                                el.cursor_pointer()
                                    .hover(|style| style.bg(crate::theme::white_alpha(0.07)))
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.generate_commit_message(cx);
                                    }))
                            })
                            .child(SharedString::from(if self.git_generating {
                                "Generating…"
                            } else {
                                "AI message"
                            })),
                    ),
            )
            .into_any_element()
    }

    pub(super) fn render_commit(&mut self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let can_commit = self.git_busy.is_none()
            && !self.git_generating
            && !self.subject.read(cx).text().trim().is_empty()
            && self.git_status.as_ref().is_some_and(|status| {
                status.is_repo && status.files.iter().any(|file| file.staged)
            });
        div()
            .flex_none()
            .p(px(Theme::SPACE_MD))
            .flex()
            .flex_col()
            .gap(px(7.0))
            .border_t_1()
            .border_color(theme.border)
            .child(
                div()
                    .min_h(px(30.0))
                    .px(px(8.0))
                    .py(px(4.0))
                    .rounded(px(6.0))
                    .border_1()
                    .border_color(theme.border)
                    .bg(crate::theme::white_alpha(0.025))
                    .text_size(px(12.0))
                    .child(self.subject.clone()),
            )
            .child(
                div()
                    .min_h(px(48.0))
                    .max_h(px(COMMIT_DESC_MAX_H))
                    .overflow_hidden()
                    .px(px(8.0))
                    .py(px(4.0))
                    .rounded(px(6.0))
                    .border_1()
                    .border_color(theme.border)
                    .bg(crate::theme::white_alpha(0.025))
                    .text_size(px(12.0))
                    .child(self.body.clone()),
            )
            .child(
                div()
                    .id("git-commit")
                    .h(px(30.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(7.0))
                    .bg(if can_commit {
                        theme.text
                    } else {
                        theme.surface_raised
                    })
                    .text_size(px(12.0))
                    .text_color(if can_commit {
                        theme.bg
                    } else {
                        theme.text_faint
                    })
                    .when(can_commit, |el| {
                        el.cursor_pointer()
                            .on_click(cx.listener(|this, _, _, cx| this.commit(cx)))
                    })
                    .child(SharedString::from(if self.git_busy == Some("commit") {
                        "Committing…"
                    } else {
                        "Commit staged changes"
                    })),
            )
            .into_any_element()
    }

    pub(super) fn render_file_menu(&self, theme: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (file, position) = self.file_menu.clone()?;
        let discard = file.clone();
        let ignore = file.clone();
        let reveal = file.clone();
        let copy_absolute = file.clone();
        let copy_relative = file.clone();
        let cwd = self.git_context(cx).map(|(cwd, _)| cwd)?;
        let untracked = file.kind == "untracked";
        let row = |id: String, label: &'static str| {
            popover::menu_row(theme, false, id).child(SharedString::from(label))
        };
        let menu = popover::popover_card(theme)
            .w(px(210.0))
            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                this.file_menu = None;
                cx.notify();
            }))
            .flex()
            .flex_col()
            .child(
                row(
                    format!("git-menu-discard-{}", discard.path),
                    "Discard changes",
                )
                .id(SharedString::from(format!(
                    "git-menu-discard-{}",
                    discard.path
                )))
                .text_color(theme.danger)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.run_file_action(methods::GIT_DISCARD, discard.path.clone(), untracked, cx);
                })),
            )
            .child(
                row(format!("git-menu-ignore-{}", ignore.path), "Ignore file")
                    .id(SharedString::from(format!(
                        "git-menu-ignore-{}",
                        ignore.path
                    )))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.run_file_action(methods::GIT_IGNORE, ignore.path.clone(), false, cx);
                    })),
            )
            .child(popover::menu_separator())
            .child(
                row(
                    format!("git-menu-copy-path-{}", copy_absolute.path),
                    "Copy file path",
                )
                .id(SharedString::from(format!(
                    "git-menu-copy-path-{}",
                    copy_absolute.path
                )))
                .on_click(cx.listener(move |this, _, _, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(
                        std::path::Path::new(&cwd)
                            .join(&copy_absolute.path)
                            .to_string_lossy()
                            .into_owned(),
                    ));
                    this.file_menu = None;
                    cx.notify();
                })),
            )
            .child(
                row(
                    format!("git-menu-copy-relative-{}", copy_relative.path),
                    "Copy relative file path",
                )
                .id(SharedString::from(format!(
                    "git-menu-copy-relative-{}",
                    copy_relative.path
                )))
                .on_click(cx.listener(move |this, _, _, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(copy_relative.path.clone()));
                    this.file_menu = None;
                    cx.notify();
                })),
            )
            .child(
                row(
                    format!("git-menu-reveal-{}", reveal.path),
                    "Reveal in Finder",
                )
                .id(SharedString::from(format!(
                    "git-menu-reveal-{}",
                    reveal.path
                )))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.run_file_action(methods::GIT_REVEAL, reveal.path.clone(), false, cx);
                })),
            )
            .into_any_element();
        Some(popover::menu_at("git-file-context-menu", position, menu))
    }
}

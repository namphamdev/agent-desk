//! `impl Pickers` render: the combined harness+model switcher popover,
//! the traits popover, and the harness brand icon resolver.

use gpui::{AnyElement, Context, SharedString, div, prelude::*, px};

use comet_engine::registry::HarnessDescriptor;
use comet_proto::HarnessId;

use crate::dev_inspector::{self, InspectClickExt as _, InspectExt as _};
use crate::popover::{self, Loadable};
use crate::theme::Theme;

use super::logic::{reasoning_label, visible_harnesses};
use super::{PickerKind, Pickers};

impl Pickers {
    /// The combined harness + model switcher (comet harness-model-picker.tsx):
    /// a vertical harness rail of square brand-icon tabs on the left, the
    /// viewed harness's models on the right. On an existing chat the other
    /// tabs stay visible but disabled — the lock reads as a rule.
    pub(super) fn render_harness_model_popover(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(cx).clone();
        let locked = self.harness_locked(cx);
        let effective = self.effective_harness(cx);
        let model_scroll = self.model_scroll.clone();

        let rail: AnyElement = match &self.harnesses {
            Loadable::Loading | Loadable::Idle => div()
                .p(px(4.0))
                .child(popover::skeleton_rows(
                    "harness-skeleton",
                    &theme,
                    3,
                    cx.entity_id(),
                    cx,
                ))
                .into_any_element(),
            Loadable::Error(message) => {
                let message = message.clone();
                self.retry_row(
                    "harness-retry",
                    &message,
                    PickerKind::HarnessModel,
                    &theme,
                    cx,
                )
            }
            Loadable::Ready(list) => {
                let mut descriptors: Vec<HarnessDescriptor> = visible_harnesses(list);
                // The committed harness always gets its rail tab, even when
                // it's the (normally hidden) mock harness of a dev session.
                if let Some(effective) = effective
                    && !descriptors.iter().any(|d| d.id == effective)
                    && let Some(descriptor) = list.iter().find(|d| d.id == effective)
                {
                    descriptors.insert(0, descriptor.clone());
                }
                // Vertical agents rail (the palette's Devices-rail language):
                // brand icon + name per row, active carries the glass ring.
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .p(px(4.0))
                    .child(popover::menu_heading(&theme, "Agents"))
                    .children(descriptors.into_iter().enumerate().map(|(ix, descriptor)| {
                        let harness = descriptor.id;
                        let acp_agent_id = descriptor.acp_agent_id.clone();
                        let is_viewed = effective == Some(harness)
                            && (harness != HarnessId::Acp
                                || self.config.acp_agent_id == acp_agent_id);
                        let is_disabled = locked && !is_viewed;
                        let (icon_path, tint) =
                            harness_brand_icon(harness, acp_agent_id.as_deref());
                        // Prefer the icon URL carried by the descriptor (always
                        // populated by the engine for ACP agents that declare
                        // one) so the logo renders without depending on the
                        // ICON_URLS global being warmed by the settings page.
                        let acp_logo = descriptor
                            .icon
                            .as_deref()
                            .filter(|u| !u.is_empty())
                            .map(|url| crate::acp_logo::logo(url, cx));
                        let name: SharedString = descriptor.name.clone().into();
                        div()
                            .id(("harness-tab", ix))
                            .inspect_tag("harness-tab")
                            .h(px(30.0))
                            .px(px(8.0))
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.0))
                            .rounded(px(8.0))
                            .text_size(px(12.0))
                            .font_weight(gpui::FontWeight::MEDIUM)
                            .text_color(if is_viewed {
                                theme.text
                            } else {
                                theme.text_muted
                            })
                            .when(is_viewed, |el| {
                                el.bg(crate::theme::card_selected_bg())
                                    .shadow(crate::theme::card_selected_shadows())
                            })
                            .when(is_disabled, |el| el.opacity(0.35))
                            .when(!is_disabled, |el| el.cursor_pointer())
                            // Hover must not replace the viewed row's selected
                            // fill with the weaker wash — that dims the active
                            // row under the pointer (same rule as the sidebar
                            // rows in shell.rs).
                            .when(!is_disabled && !is_viewed, |el| {
                                el.hover(|s| s.bg(crate::theme::ink(0.06)))
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.pick_harness(harness, acp_agent_id.clone(), cx);
                            }))
                            .child(match acp_logo {
                                Some(crate::acp_logo::Logo::Ready(image)) => gpui::img(image)
                                    .size(px(16.0))
                                    .flex_none()
                                    .into_any_element(),
                                _ => crate::icons::icon(icon_path)
                                    .size(px(16.0))
                                    .flex_none()
                                    .text_color(tint.unwrap_or(if is_viewed {
                                        theme.text
                                    } else {
                                        theme.text_muted
                                    }))
                                    .into_any_element(),
                            })
                            .child(div().min_w_0().truncate().child(name))
                    }))
                    .into_any_element()
            }
        };

        let _ = locked; // the lock still dims foreign rail rows above

        // The rows are collected FLAT — they become the scroll container's
        // direct children so `scroll_to_item(active)` maps 1:1 (the palette's
        // keyboard-follow standard).
        let model_children: Vec<AnyElement> = match effective.map(|h| {
            let acp_agent_id = self.effective_acp_agent_id(cx);
            (h, self.models.get(&(h, acp_agent_id)))
        }) {
            Some((_, Some(Loadable::Ready(_)))) => {
                // The check mirrors the chip: the resolved concrete pick (draft
                // / chat config / remembered, else the harness default row).
                let selected = self.selected_model(cx).map(|m| m.id.clone());
                let active = self.active;
                let models = self.filtered_model_rows(cx);
                if models.is_empty() {
                    vec![
                        div()
                            .px(px(8.0))
                            .py(px(24.0))
                            .text_size(px(12.0))
                            .text_color(theme.text_muted.opacity(0.6))
                            .text_center()
                            .child(SharedString::from("No models found."))
                            .into_any_element(),
                    ]
                } else {
                    models
                        .into_iter()
                        .enumerate()
                        .map(|(ix, model)| {
                            let label: SharedString = model.label.clone().into();
                            let description: Option<SharedString> =
                                model.description.clone().map(Into::into);
                            let id = model.id.clone();
                            let is_selected = selected.as_deref() == Some(model.id.as_str())
                                || (selected.is_none() && ix == 0);
                            popover::menu_row_nav(
                                &theme,
                                is_selected,
                                ix == active,
                                format!("model-row-{ix}"),
                            )
                            .when(is_selected || ix == active, |el| {
                                el.shadow(crate::theme::card_selected_shadows())
                            })
                            .id(("model-row", ix))
                            .inspect_click(dev_inspector::inspect_meta("model-row"))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.pick_model(id.clone(), cx);
                            }))
                            .child(
                                // Name + 11px muted description subline, per
                                // harness-model-picker.tsx (`min-w-0 flex-1` column).
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .flex()
                                    .flex_col()
                                    .child(div().w_full().truncate().child(label))
                                    .when_some(description, |el, description| {
                                        el.child(
                                            div()
                                                .w_full()
                                                .truncate()
                                                .text_size(px(11.0))
                                                .text_color(theme.text_muted.opacity(0.7))
                                                .child(description),
                                        )
                                    }),
                            )
                            .when(is_selected, |el| el.child(popover::menu_check(&theme)))
                            .into_any_element()
                        })
                        .collect()
                }
            }
            Some((_, Some(Loadable::Error(message)))) => {
                let message = message.clone();
                vec![self.retry_row(
                    "model-retry",
                    &message,
                    PickerKind::HarnessModel,
                    &theme,
                    cx,
                )]
            }
            _ => vec![
                div()
                    .px(px(8.0))
                    .py(px(24.0))
                    .text_size(px(12.0))
                    .text_color(theme.text_muted.opacity(0.6))
                    .text_center()
                    .child(SharedString::from("Loading models…"))
                    .into_any_element(),
            ],
        };

        // The palette architecture: agents rail LEFT, the viewed harness's
        // models pane beside it. Traits (reasoning ladder + options) live in
        // their own composer chip + dropdown now — they're properties of the
        // selected model, so they follow the pick instead of sharing the
        // browse surface. FIXED height so harness switches and loading
        // skeletons don't resize the card.
        div()
            .h(px(420.0))
            .flex()
            .flex_col()
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .flex_row()
                    .items_stretch()
                    .child(
                        div()
                            .w(px(148.0))
                            .flex_none()
                            .border_r_1()
                            .border_color(crate::theme::hairline(0.06))
                            .child(rail),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(
                                // Pinned heading (the palette's crumbs slot).
                                div()
                                    .flex_none()
                                    .px(px(4.0))
                                    .pt(px(4.0))
                                    .child(popover::menu_heading(&theme, "Models")),
                            )
                            .child(div().p(px(4.0)).child(self.search_box(&theme)))
                            .child(
                                // Models scroll — gutters on the WRAPPER,
                                // outside the scroll viewport (in-content
                                // bottom padding is eaten by the extent), and
                                // rows as DIRECT children so keyboard
                                // `scroll_to_item` indices line up.
                                div().flex_1().min_h_0().pb(px(4.0)).child(
                                    div()
                                        .id("model-menu-scroll")
                                        .inspect_tag("model-menu-scroll")
                                        .size_full()
                                        .flex()
                                        .flex_col()
                                        .gap(px(2.0))
                                        .px(px(4.0))
                                        .overflow_y_scroll()
                                        .track_scroll(&model_scroll)
                                        .children(model_children),
                                ),
                            ),
                    ),
            )
            .child(
                // The palette's legend footer, on the recessed band.
                div()
                    .flex_none()
                    .bg(popover::band())
                    .border_t_1()
                    .border_color(crate::theme::hairline(0.06))
                    .px(px(12.0))
                    .py(px(8.0))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(12.0))
                    .child(popover::key_hint_pair(
                        &theme,
                        crate::icons::ARROW_UP,
                        crate::icons::ARROW_DOWN,
                        "Navigate",
                    ))
                    .child(popover::key_hint(&theme, crate::icons::RETURN, "Select")),
            )
            .into_any_element()
    }

    /// The traits DROPDOWN body: the reasoning ladder plus every advertised
    /// model option as headed segmented-chip sections. Selecting keeps the
    /// dropdown open; the active chip carries the wash + ring. Mouse-only —
    /// arrow keys are unused in this narrow popover.
    pub(super) fn render_traits_sections(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(cx).clone();
        let Some(model) = self.selected_model(cx).cloned() else {
            return popover::skeleton_rows("traits-skeleton", &theme, 3, cx.entity_id(), cx);
        };
        let levels = self.trait_ladder(cx);
        // Display the effective level (draft pick or the chat's config), so
        // the ladder check mirrors the chip summary.
        let current = self.effective_reasoning(cx);

        let ladder: AnyElement = if levels.is_empty() {
            gpui::Empty.into_any_element()
        } else {
            div()
                .flex()
                .flex_col()
                .child(popover::menu_heading(&theme, "Reasoning"))
                .child(
                    div()
                        .px(px(4.0))
                        .flex()
                        .flex_row()
                        .flex_wrap()
                        .gap(px(4.0))
                        .children(levels.into_iter().enumerate().map(|(ix, level)| {
                            let is_active = current == Some(level);
                            trait_chip(&theme, is_active)
                                .id(("reasoning-row", ix))
                                .inspect_tag("reasoning-row")
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.pick_reasoning(level, cx);
                                }))
                                .child(SharedString::from(reasoning_label(level)))
                        })),
                )
                .into_any_element()
        };

        let selections = self.explicit_options(cx);
        let options =
            div()
                .flex()
                .flex_col()
                .gap(px(2.0))
                .children(model.options.iter().enumerate().map(|(opt_ix, option)| {
                    let selected_choice = selections
                        .get(&option.id)
                        .and_then(|v| v.as_str())
                        .unwrap_or(&option.default_choice)
                        .to_string();
                    let option_id = option.id.clone();
                    let default_choice = option.default_choice.clone();
                    div()
                        .flex()
                        .flex_col()
                        .child(popover::menu_heading(&theme, &option.label))
                        .child(
                            div()
                                .px(px(4.0))
                                .flex()
                                .flex_row()
                                .flex_wrap()
                                .gap(px(4.0))
                                .children(option.choices.iter().enumerate().map(
                                    |(choice_ix, choice)| {
                                        let is_active = selected_choice == choice.id;
                                        let choice_id = choice.id.clone();
                                        let option_id = option_id.clone();
                                        let is_default = choice.id == default_choice;
                                        trait_chip(&theme, is_active)
                                            .id(("trait-choice", opt_ix * 32 + choice_ix))
                                            .inspect_tag("trait-choice")
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                this.pick_option(
                                                    option_id.clone(),
                                                    choice_id.clone(),
                                                    is_default,
                                                    cx,
                                                );
                                            }))
                                            .child(SharedString::from(choice.label.clone()))
                                    },
                                )),
                        )
                }));

        div()
            .flex()
            .flex_col()
            .gap(px(4.0))
            .pb(px(4.0))
            .child(ladder)
            .child(options)
            .into_any_element()
    }

    /// The traits DROPDOWN (comet TraitsPicker): a narrow card over the
    /// traits chip holding the reasoning ladder + advertised model options.
    /// Traits are properties of the *selected* model, so they follow the pick
    /// instead of sharing the model browse surface. The card grows with its
    /// content and scrolls only when a model advertises many option groups.
    pub(super) fn render_traits_popover(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let body = self.render_traits_sections(cx);
        div()
            .id("traits-scroll")
            .inspect_tag("traits-scroll")
            .max_h(px(360.0))
            .overflow_y_scroll()
            .p(px(4.0))
            .child(body)
            .into_any_element()
    }
}

/// A segmented choice chip for the traits inspector (reasoning ladder /
/// model options): the key-cap voice — every chip carries a faint fill so it
/// reads as a pressable segment (bare text read as labels, not buttons);
/// the active chip adds the app-wide wash + glass ring.
/// The caller adds id/click/label.
fn trait_chip(theme: &Theme, active: bool) -> gpui::Div {
    div()
        .h(px(24.0))
        .px(px(10.0))
        .rounded(px(6.0))
        .flex()
        .flex_row()
        .items_center()
        .text_size(px(11.5))
        .cursor_pointer()
        .when(active, |el| {
            el.bg(crate::theme::card_selected_bg())
                .text_color(theme.text)
        })
        .when(!active, |el| {
            el.bg(crate::theme::ink(0.04))
                .text_color(theme.text_muted.opacity(0.7))
                .hover(|s| s.bg(theme.element_hover))
        })
        .when(active, |el| {
            el.shadow(crate::theme::card_selected_shadows())
        })
}

/// Brand mark + optional tint for a harness (the Claude mark keeps its brand
/// orange even on the monochrome surface; the mock harness scripts
/// Claude-flavoured runs, so it wears the Claude mark).
///
/// When the harness is [`HarnessId::Acp`], `acp_agent_id` selects the brand
/// mark of the specific ACP client (e.g. the Factory Droid mark for
/// `factory-droid`). Unknown ACP agents fall back to the generic widget icon.
pub(crate) fn harness_brand_icon(
    harness: HarnessId,
    acp_agent_id: Option<&str>,
) -> (&'static str, Option<gpui::Hsla>) {
    match harness {
        HarnessId::ClaudeCode | HarnessId::Mock => (
            crate::icons::CLAUDE_MARK,
            Some(crate::icons::claude_brand()),
        ),
        HarnessId::Codex => (crate::icons::OPENAI_MARK, None),
        HarnessId::Acp => acp_brand_icon(acp_agent_id),
        HarnessId::Cursor => (crate::icons::CURSOR_MARK, None),
        HarnessId::Minswe => (crate::icons::WIDGET, None),
    }
}

/// Per-agent brand mark for a known ACP client, identified by its registry id.
/// Unknown agents fall back to the generic widget icon so custom/unpublished
/// agents still render a sensible glyph.
fn acp_brand_icon(acp_agent_id: Option<&str>) -> (&'static str, Option<gpui::Hsla>) {
    match acp_agent_id {
        Some("factory-droid") => (crate::icons::DROID_MARK, None),
        _ => (crate::icons::WIDGET, None),
    }
}

/// Display-only toggle switch (comet branch-picker.tsx `Toggle`): an 18×32
/// pill whose knob slides right and track flips white when on. State is owned
/// by the parent row.
#[allow(dead_code)]
fn toggle_switch(theme: &Theme, on: bool) -> gpui::Div {
    div()
        .flex_none()
        .w(px(32.0))
        .h(px(18.0))
        .rounded_full()
        .bg(if on {
            theme.text
        } else {
            crate::theme::ink(0.15)
        })
        .relative()
        .child(
            div()
                .absolute()
                .top(px(2.0))
                .left(px(if on { 16.0 } else { 2.0 }))
                .size(px(14.0))
                .rounded_full()
                .bg(if on {
                    theme.on_solid
                } else {
                    crate::theme::ink(0.7)
                }),
        )
}

/// Attach the (single) open popover overlay to its trigger chip.
pub(super) fn attach_overlay(
    chip: gpui::Stateful<gpui::Div>,
    overlay: &mut Option<(PickerKind, AnyElement)>,
    kind: PickerKind,
    id: &'static str,
) -> gpui::Stateful<gpui::Div> {
    if overlay.as_ref().is_some_and(|(k, _)| *k == kind)
        && let Some((_, element)) = overlay.take()
    {
        return chip.child(popover::anchored_menu_above(id, element));
    }
    chip
}


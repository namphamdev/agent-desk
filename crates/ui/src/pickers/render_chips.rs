//! `impl Pickers` render: trigger chips and the composer footer row.

use gpui::{AnyElement, Context, SharedString, div, prelude::*, px};

use crate::motion;
use crate::theme::Theme;

use super::config::CheckoutKind;
use super::render_model::attach_overlay;
use super::{attach_overlay_end, PickerKind, Pickers};

impl Pickers {
    pub(super) fn trigger_chip(
        &self,
        kind: PickerKind,
        label: SharedString,
        set: bool,
        chip_icon: Option<(&'static str, Option<gpui::Hsla>)>,
        suffix: Option<SharedString>,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let id: &'static str = match kind {
            PickerKind::Branch => "picker-branch",
            PickerKind::Checkout => "picker-checkout",
            PickerKind::HarnessModel => "picker-model",
            PickerKind::Traits => "picker-traits",
            PickerKind::Permission => "picker-permission",
        };
        let open = self.open == Some(kind);
        // Ghost pill (comet composer/styles.tsx `pill`): `h-8 rounded-lg px-2.5
        // gap-1.5 text-[12px] font-medium text-muted-foreground`, icons size-4,
        // hover/open wash — no border, no caret; the actions row stays quiet.
        div()
            .id(id)
            .h(px(32.0))
            .max_w(px(208.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .px(px(10.0))
            .rounded(px(8.0))
            .text_size(px(12.0))
            .font_weight(gpui::FontWeight::MEDIUM)
            // comet composer/styles.tsx `pill`: `transition-colors` — the wash
            // and text brighten fade over 150ms.
            .text_color(motion::hover_blend(
                id,
                if set {
                    theme.text.opacity(0.9)
                } else {
                    theme.text_muted
                },
                theme.text,
            ))
            .bg(if open {
                theme.element_hover
            } else {
                motion::hover_blend(id, gpui::transparent_black(), theme.element_hover)
            })
            .on_hover(motion::hover_listener(id))
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, window, cx| this.toggle(kind, window, cx)))
            .when_some(chip_icon, |el, (path, tint)| {
                el.child(
                    crate::icons::icon(path)
                        .size(px(16.0))
                        .text_color(tint.unwrap_or(theme.text_muted)),
                )
            })
            .child(div().min_w_0().truncate().child(label))
            // The effort half of the combined model+effort chip: muted, no
            // icon (user request) — one button, two tones.
            .when_some(suffix, |el, suffix| {
                el.child(
                    div()
                        .flex_none()
                        .text_color(theme.text_muted.opacity(0.7))
                        .child(suffix),
                )
            })
    }

    /// A footer-row trigger (t3code ghost `Button size="xs"`): leading icon,
    /// truncating label, trailing chevron — smaller and quieter than the
    /// in-pill chips.
    pub(super) fn footer_chip(
        &self,
        kind: PickerKind,
        id: &'static str,
        icon_path: &'static str,
        label: SharedString,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let open = self.open == Some(kind);
        div()
            .id(id)
            .h(px(20.0))
            .max_w(px(280.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .px(px(8.0))
            .rounded(px(6.0))
            .text_size(px(12.0))
            .font_weight(gpui::FontWeight::MEDIUM)
            .text_color(motion::hover_blend(
                id,
                theme.text_muted.opacity(0.7),
                theme.text.opacity(0.8),
            ))
            .bg(if open {
                theme.element_hover
            } else {
                motion::hover_blend(id, gpui::transparent_black(), theme.element_hover)
            })
            .on_hover(motion::hover_listener(id))
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, window, cx| this.toggle(kind, window, cx)))
            .child(
                crate::icons::icon(icon_path)
                    .size(px(12.0))
                    .text_color(theme.text_muted.opacity(0.7)),
            )
            .child(div().min_w_0().truncate().child(label))
            .child(
                crate::icons::icon(crate::icons::ALT_ARROW_DOWN)
                    .size(px(12.0))
                    .text_color(theme.text_muted.opacity(0.5)),
            )
    }

    /// A read-only footer label (locked sessions — t3code's
    /// `resolveLockedWorkspaceLabel` span).
    pub(super) fn footer_label(icon_path: &'static str, label: SharedString, theme: &Theme) -> gpui::Div {
        div()
            .h(px(20.0))
            .max_w(px(280.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .px(px(8.0))
            .text_size(px(12.0))
            .font_weight(gpui::FontWeight::MEDIUM)
            .text_color(theme.text_muted.opacity(0.6))
            .child(
                crate::icons::icon(icon_path)
                    .size(px(12.0))
                    .text_color(theme.text_muted.opacity(0.6)),
            )
            .child(div().min_w_0().truncate().child(label))
    }

    /// The composer footer row (t3code BranchToolbar): checkout-kind on the
    /// left, the ref selector right-aligned. `None` for non-git spaces. On an
    /// existing session both sides are read-only labels ("Worktree" /
    /// "Local checkout" + the chat's branch).
    pub fn render_footer(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = Theme::of(cx).clone();
        // A selected chat whose workspace row hasn't synced yet (the moment
        // right after send mints it) still renders the DRAFT footer — the
        // values are identical, so the toolbar never blinks through a
        // half-empty locked state.
        let (space, session) = {
            let state = self.state.read(cx);
            let space = state.selected_space_row().cloned()?;
            let session = state
                .selected_chat
                .as_ref()
                .and_then(|_| state.selected_chat_row().cloned());
            (space, session)
        };
        if !space.git_detected {
            return None;
        }
        let new_chat = session.is_none();

        // Refs feed both modes (draft labels, mid-session switch list) —
        // eager + idempotent.
        self.ensure_refs(false, cx);

        // Symmetric: the container's 8px gap sits above the toolbar; bleeding
        // 8 of the container's 16px bottom padding (mb -8) leaves 8 below —
        // equal air on both sides of the row.
        let row = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(8.0))
            .px(px(10.0))
            .mb(px(-8.0));

        // The ref side is LIVE in both modes: draft pick on a new chat,
        // checkout switch on an existing session (t3code keeps its branch
        // selector interactive mid-session too).
        let ref_label = match &session {
            Some(chat) => chat
                .branch
                .clone()
                .map(SharedString::from)
                .unwrap_or_else(|| SharedString::from("Select ref")),
            None => self.ref_label(),
        };
        let mut overlay: Option<(PickerKind, AnyElement)> = match self.open {
            Some(PickerKind::Branch) => {
                let content = self.render_branch_popover(cx);
                Some((PickerKind::Branch, self.popover_frame(320.0, content, cx)))
            }
            Some(PickerKind::Checkout) if new_chat => {
                let content = self.render_checkout_popover(cx);
                Some((PickerKind::Checkout, self.popover_frame(224.0, content, cx)))
            }
            _ => None,
        };
        let ref_chip = self.footer_chip(
            PickerKind::Branch,
            "picker-branch",
            crate::icons::GIT_BRANCH,
            ref_label,
            &theme,
            cx,
        );
        let ref_side =
            attach_overlay_end(ref_chip, &mut overlay, PickerKind::Branch, "branch-popover");

        if let Some(chat) = &session {
            // The checkout KIND is fixed at creation (harness resume is
            // cwd-scoped — the session never moves folders): label only.
            let is_worktree = chat.cwd.as_deref().is_some_and(|cwd| cwd != space.path);
            let (icon_path, label) = if is_worktree {
                (crate::icons::FOLDER_WITH_FILES, "Worktree")
            } else {
                (crate::icons::FOLDER, "Local checkout")
            };
            let left = Self::footer_label(icon_path, SharedString::from(label), &theme);
            return Some(row.child(left).child(ref_side).into_any_element());
        }

        let kind_icon = match (self.config.checkout, self.selected_ref_worktree().is_some()) {
            (CheckoutKind::Local, false) => crate::icons::FOLDER,
            _ => crate::icons::FOLDER_WITH_FILES,
        };
        let kind_chip = self.footer_chip(
            PickerKind::Checkout,
            "picker-checkout",
            kind_icon,
            SharedString::from(self.checkout_label()),
            &theme,
            cx,
        );
        Some(
            row.child(attach_overlay(
                kind_chip,
                &mut overlay,
                PickerKind::Checkout,
                "checkout-popover",
            ))
            .child(ref_side)
            .into_any_element(),
        )
    }

}


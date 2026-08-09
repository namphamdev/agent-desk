//! Composer pickers (feature-inventory §1.7): RepoPicker (recents + search +
//! in-app folder browser + clone/create), BranchPicker (search + isolated-
//! worktree toggle), HarnessModelPicker (harness rail + model list, harness
//! locked once the chat exists), TraitsPicker (its own composer chip +
//! dropdown — reasoning ladder + advertised model options; trigger shows the
//! non-default summary "High · 1M · Fast", hidden when the model advertises
//! neither a ladder nor options).
//!
//! All selections accumulate into a [`DraftConfig`] the composer threads into
//! the Run command and the `Mutate createChat` call on first send.
//!
//! Pure logic (repo ordering, folder-browser navigation, traits summary) lives
//! in free functions with unit tests; RPC results land in [`Loadable`] slots
//! rendered as skeletons / inline errors with Retry.

mod config;
mod logic;
mod r#impl;
mod impl_load;
mod impl_query;
mod render_chips;
mod render_popovers;
mod render_model;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;

use gpui::{
    AnyElement, Context, Entity, FocusHandle, Focusable as _,
    SharedString, Subscription, Task, Window, div, prelude::*, px,
};

use comet_engine::registry::HarnessDescriptor;
use comet_proto::{
    HarnessId, Model, PermissionMode, RepoRef,
};

use crate::composer::ComposerInput;
use crate::popover::{self, Loadable};
use crate::settings::composer::ComposerDefaults;
use crate::state::AppState;
use crate::theme::Theme;

pub use config::{CheckoutKind, CheckoutPlan, DraftConfig, ResolvedRunConfig};
pub use logic::{
    breadcrumbs, browser_rows, child_path, clamp_reasoning, default_model, default_reasoning,
    filter_models, is_absolute_path, mock_harness_enabled, parent_path, reasoning_label,
    traits_summary, visible_harnesses, visible_harnesses_impl,
};

pub(crate) use render_model::harness_brand_icon;

/// Display cap for the ref list (t3code shows pages of 100 with a status
/// footer; a flat cap + "Showing X of Y refs" reads the same without
/// pagination plumbing).
pub(super) const MAX_REF_ROWS: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickerKind {
    Branch,
    /// The checkout-kind dropdown in the composer footer (Current
    /// checkout/worktree | New worktree).
    Checkout,
    HarnessModel,
    Traits,
    Permission,
}

pub struct Pickers {
    pub(super) state: Entity<AppState>,
    pub(super) config: DraftConfig,
    /// Sticky last-used picks (comet `comet.composer.defaults:v1`): seeds the
    /// new-chat chips and is rewritten on every new-chat pick.
    pub(super) defaults: ComposerDefaults,
    /// Where [`Self::defaults`] persists (`{data_dir}/composer-defaults.json`);
    /// `None` before bootstrap stamps the state (writes are skipped).
    pub(super) data_dir: Option<PathBuf>,
    /// Selection the draft picks belong to — switching chats drops them so a
    /// pick made in one chat never leaks into another.
    pub(super) draft_owner: Option<String>,
    /// Space the branch draft/cache belong to (see the state observer).
    pub(super) space_owner: Option<String>,
    pub(super) open: Option<PickerKind>,
    pub(super) harnesses: Loadable<Vec<HarnessDescriptor>>,
    pub(super) models: HashMap<(HarnessId, Option<String>), Loadable<Vec<Model>>>,
    pub(super) refs: Loadable<Vec<RepoRef>>,
    /// Space id the `refs` slot belongs to (invalidated on space change).
    pub(super) refs_space: Option<String>,
    /// Highlighted row in the open list (keyboard nav).
    pub(super) active: usize,
    /// Models-list scroll — keyboard nav keeps the highlighted row in view
    /// (`scroll_to_item`; the add-space palette standard).
    pub(super) model_scroll: gpui::ScrollHandle,
    /// Shared search / URL / name input, reused across popovers.
    pub(super) search: Entity<ComposerInput>,
    pub(super) focus: FocusHandle,
    /// Re-open suppression after outside-click dismissal (the dismiss and the
    /// trigger click would otherwise toggle twice).
    pub(super) suppressed: Option<(PickerKind, Instant)>,
    /// `COMET_OPEN_PICKER` boot: keep claiming focus until it sticks, so
    /// keyboard nav drives the data-side-opened popover (headless rigs have
    /// no synthetic pointer, but synthetic keys do arrive).
    pub(super) boot_focus_pending: bool,
    pub(super) load_task: Option<Task<()>>,
    /// Own slot: the refs load runs concurrently with the eager
    /// harness/model loads — sharing `load_task` would abort one mid-flight.
    pub(super) refs_task: Option<Task<()>>,
    /// In-flight mid-session `SwitchRef` (the ref being switched to).
    pub(super) switching: Option<String>,
    pub(super) switch_task: Option<Task<()>>,
    /// Last mid-session switch failure (shown in the ref popover).
    pub(super) switch_error: Option<String>,
    pub(super) mutate_task: Option<Task<()>>,
    pub(super) _search_events: Subscription,
    pub(super) _state_observe: Subscription,
}

pub(super) fn attach_overlay_end(
    chip: gpui::Stateful<gpui::Div>,
    overlay: &mut Option<(PickerKind, AnyElement)>,
    kind: PickerKind,
    id: &'static str,
) -> gpui::Stateful<gpui::Div> {
    if overlay.as_ref().is_some_and(|(k, _)| *k == kind)
        && let Some((_, element)) = overlay.take()
    {
        return chip
            .relative()
            .child(popover::anchored_menu_above_end(id, element));
    }
    chip
}

impl Render for Pickers {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(cx).clone();
        // A COMET_OPEN_PICKER popover never went through `toggle`, so claim
        // its keyboard focus here (re-claim until it sticks — the shell's
        // first-paint fallback focuses the composer after our first render).
        if self.boot_focus_pending {
            match self.open {
                Some(PickerKind::Branch) | Some(PickerKind::HarnessModel) => {
                    let placeholder = if self.open == Some(PickerKind::HarnessModel) {
                        "Search models…"
                    } else {
                        "Search refs…"
                    };
                    self.search.update(cx, |input, cx| {
                        input.set_placeholder(placeholder, cx);
                    });
                    let handle = self.search.read(cx).focus_handle(cx);
                    if handle.is_focused(window) {
                        self.boot_focus_pending = false;
                    } else {
                        window.focus(&handle, cx);
                    }
                }
                Some(_) => {
                    if self.focus.is_focused(window) {
                        self.boot_focus_pending = false;
                    } else {
                        window.focus(&self.focus, cx);
                    }
                }
                None => self.boot_focus_pending = false,
            }
        }

        // Eager-load the harness catalog + effective harness's models so the
        // chip reads "Fable 5" (a concrete pick) before any popover opens.
        self.ensure_harnesses(cx);
        if let Some(harness) = self.effective_harness(cx) {
            let acp_agent_id = self.effective_acp_agent_id(cx);
            self.ensure_models(harness, acp_agent_id, cx);
        }
        // A popover opened data-side (COMET_OPEN_PICKER) never went through
        // `toggle`, so kick its loads here (all ensure_* are idempotent).
        if matches!(
            self.open,
            Some(PickerKind::Branch) | Some(PickerKind::Checkout)
        ) && matches!(self.refs, Loadable::Idle)
        {
            self.ensure_refs(false, cx);
        }
        // Chip shows the model's display name alone (comet `modelText`); the
        // harness reads from the brand mark beside it. Never "Default model":
        // before the catalog lands the remembered label (or the configured id)
        // names the pick; the loaded list then resolves it to a concrete row.
        let model_label: SharedString = {
            let loaded = self.selected_model(cx).map(|m| m.label.clone());
            let label = loaded.or_else(|| {
                let remembered = self
                    .effective_harness(cx)
                    .and_then(|h| self.defaults.model_for(h));
                match self.effective_model_id(cx) {
                    Some(id) => Some(
                        remembered
                            .filter(|m| m.id == id)
                            .map(|m| m.label.clone())
                            .or_else(|| self.defaults.label_for(id).map(str::to_string))
                            .unwrap_or_else(|| id.to_string()),
                    ),
                    None => remembered.map(|m| m.label.clone()),
                }
            });
            label.map(SharedString::from).unwrap_or_default()
        };
        let harness_icon: (&'static str, Option<gpui::Hsla>) = self
            .effective_harness(cx)
            .map(|harness| {
                let acp_agent_id = self.effective_acp_agent_id(cx);
                harness_brand_icon(harness, acp_agent_id.as_deref())
            })
            .unwrap_or((
                crate::icons::CLAUDE_MARK,
                Some(crate::icons::claude_brand()),
            ));
        let explicit_options = self.explicit_options(cx);
        let traits_set = traits_summary(
            self.selected_model(cx),
            self.effective_reasoning(cx),
            &explicit_options,
        );
        let traits_label: SharedString = traits_set
            .clone()
            .map(SharedString::from)
            .unwrap_or_else(|| SharedString::from("Traits"));
        let permission_label = SharedString::from(match self.effective_permission_mode(cx) {
            PermissionMode::Default => "Default",
            PermissionMode::Plan => "Plan",
            PermissionMode::AcceptEdits => "Accept edits",
            PermissionMode::FullAccess => "Full access",
        });

        // Render the open popover's body first (mutable borrow), then the
        // chips. Branch/Checkout render in the composer FOOTER row (see
        // `render_footer`), not here.
        let mut overlay: Option<(PickerKind, AnyElement)> = match self.open {
            Some(PickerKind::Branch) | Some(PickerKind::Checkout) => None,
            Some(PickerKind::HarnessModel) => {
                let content = self.render_harness_model_popover(cx);
                Some((
                    PickerKind::HarnessModel,
                    self.popover_frame_flush(460.0, content, cx),
                ))
            }
            Some(PickerKind::Permission) => {
                let content = self.render_permission_popover(cx);
                Some((
                    PickerKind::Permission,
                    self.popover_frame(260.0, content, cx),
                ))
            }
            Some(PickerKind::Traits) => {
                let content = self.render_traits_popover(cx);
                Some((PickerKind::Traits, self.popover_frame(280.0, content, cx)))
            }
            None => None,
        };

        // Left cluster (the branch chip moved to the composer FOOTER row).
        // Right cluster: agent+model and traits — the composer appends
        // attach + send after this element (comet composer-actions.tsx
        // arrangement).
        let left = div()
            .flex()
            .flex_row()
            .items_center()
            .min_w_0()
            .gap(px(4.0));
        // Model chip: brand icon + model name only. Traits (reasoning +
        // options) are properties of the selected model, so they get their
        // OWN chip + dropdown to the right (comet's separate TraitsPicker).
        let model_chip = self.trigger_chip(
            PickerKind::HarnessModel,
            model_label,
            true,
            Some(harness_icon),
            None,
            &theme,
            cx,
        );
        // The traits chip is hidden entirely when the selected model
        // advertises neither a ladder nor options — a dead trigger reads as
        // broken (comet hides it for Hermes). The trigger shows the
        // non-default summary ("High · 1M · Fast"), falling back to "Traits".
        let traits_available = self.traits_available(cx);
        let traits_chip = traits_available.then(|| {
            self.trigger_chip(
                PickerKind::Traits,
                traits_label,
                traits_set.is_some(),
                None,
                None,
                &theme,
                cx,
            )
        });
        let permission_chip = self.trigger_chip(
            PickerKind::Permission,
            permission_label,
            true,
            None,
            None,
            &theme,
            cx,
        );

        let right = div()
            .flex()
            .flex_row()
            .items_center()
            .flex_none()
            .gap(px(4.0))
            .child(attach_overlay_end(
                permission_chip,
                &mut overlay,
                PickerKind::Permission,
                "permission-popover",
            ))
            .when_some(traits_chip, |el, traits_chip| {
                el.child(attach_overlay_end(
                    traits_chip,
                    &mut overlay,
                    PickerKind::Traits,
                    "traits-popover",
                ))
            })
            // End-anchored: the menu's right edge sits flush with the chip's
            // right edge (user request), same as the footer's ref popover.
            .child(attach_overlay_end(
                model_chip,
                &mut overlay,
                PickerKind::HarnessModel,
                "model-popover",
            ));
        div()
            .w_full()
            .min_w_0()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(Theme::SPACE_SM))
            .child(left)
            .child(right)
    }
}

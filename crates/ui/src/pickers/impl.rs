//! `impl Pickers` part 1: constructor, state observers, open/close, toggle.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use gpui::{App, AppContext, Context, Entity, Focusable as _, Window};

use comet_proto::{HarnessId, Model, PermissionMode, ReasoningLevel, SteeringMode};

use crate::composer::{ComposerInput, ComposerInputEvent};
use crate::popover::Loadable;
use crate::settings::composer::ComposerDefaults;
use crate::state::{AppState, EngineHandle};

use super::config::{CheckoutKind, DraftConfig, ResolvedRunConfig};
use super::logic::{clamp_reasoning, default_model, visible_harnesses};
use super::{PickerKind, Pickers};

impl Pickers {
    pub fn new(state: Entity<AppState>, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| ComposerInput::new("Search…", cx));
        let search_events = cx.subscribe(&search, |this: &mut Self, _, event, cx| match event {
            ComposerInputEvent::Edited => {
                this.active = 0;
                cx.notify();
            }
            ComposerInputEvent::Submitted => this.on_search_submit(cx),
            // Pasted images/files don't apply to a search box.
            ComposerInputEvent::PastedImages(_)
            | ComposerInputEvent::PastedPaths(_)
            | ComposerInputEvent::CursorMoved
            | ComposerInputEvent::ViewportChanged
            | ComposerInputEvent::MentionNavigate(_)
            | ComposerInputEvent::MentionAccept
            | ComposerInputEvent::MentionDismiss => {}
        });
        // Chat selection / config changes must re-render the chips (child views
        // only re-render on their own notify). A selection change also drops
        // the draft picks — they belonged to the previous chat/new-chat canvas.
        let state_observe = cx.observe(&state, |this: &mut Self, state, cx| {
            let selected = state.read(cx).selected_chat.clone();
            if selected != this.draft_owner {
                this.draft_owner = selected;
                this.config.harness = None;
                this.config.model = None;
                this.config.reasoning = None;
                this.config.model_options.clear();
                this.switch_error = None;
            }
            // A space switch invalidates the branch draft + cache — the folder
            // (and possibly the device) changed under them.
            let space = state.read(cx).selected_space.clone();
            if space != this.space_owner {
                this.space_owner = space;
                this.config.branch = None;
                this.config.checkout = CheckoutKind::default();
                this.refs = Loadable::Idle;
                this.refs_space = None;
                // Catalogs are per-DEVICE (fetched from the space's host):
                // a space switch may land on another device, so refetch.
                this.harnesses = Loadable::Idle;
                this.models.clear();
            }
            cx.notify();
        });
        // Dev/testing knob: `COMET_OPEN_PICKER=model|traits|repo|branch` boots
        // with that popover open — synthetic input can't reach the app on
        // headless compositors, so captures need a data-side path.
        let open = match std::env::var("COMET_OPEN_PICKER").ok().as_deref() {
            Some("model") => Some(PickerKind::HarnessModel),
            Some("traits") => Some(PickerKind::Traits),
            Some("branch") => Some(PickerKind::Branch),
            Some("checkout") => Some(PickerKind::Checkout),
            _ => None,
        };
        // Sticky last-used picks: loaded synchronously so the very first frame
        // shows the remembered harness/model/reasoning, never a placeholder.
        let data_dir = state.read(cx).data_dir.clone();
        let defaults = data_dir
            .as_deref()
            .map(ComposerDefaults::load)
            .unwrap_or_default();
        let draft_owner = state.read(cx).selected_chat.clone();
        let space_owner = state.read(cx).selected_space.clone();
        let permission_mode = defaults.permission_mode.unwrap_or_default();
        Self {
            state,
            space_owner,
            config: DraftConfig {
                permission_mode,
                ..DraftConfig::default()
            },
            defaults,
            data_dir,
            draft_owner,
            open,
            harnesses: Loadable::Idle,
            models: HashMap::new(),
            refs: Loadable::Idle,
            refs_space: None,
            active: 0,
            model_scroll: gpui::ScrollHandle::new(),
            search,
            focus: cx.focus_handle(),
            suppressed: None,
            boot_focus_pending: open.is_some(),
            load_task: None,
            refs_task: None,
            switching: None,
            switch_task: None,
            switch_error: None,
            mutate_task: None,
            _search_events: search_events,
            _state_observe: state_observe,
        }
    }

    /// Persist the sticky defaults (best-effort; picks are rare and tiny).
    pub(super) fn save_defaults(&self) {
        if let Some(dir) = self.data_dir.as_deref()
            && let Err(err) = self.defaults.save(dir)
        {
            tracing::warn!(error = %err, "composer-defaults save failed");
        }
    }

    pub fn draft(&self) -> &DraftConfig {
        &self.config
    }

    /// Drop device-local model catalogs after provider settings change. The
    /// next render/open reloads through `ListModels`, which discovers from the
    /// newly selected provider.
    pub fn invalidate_model_catalogs(&mut self, cx: &mut Context<Self>) {
        self.models.clear();
        self.config.model = None;
        self.config.reasoning = None;
        self.config.model_options.clear();
        // Never send a remembered built-in model while the replacement
        // provider catalog is still loading.
        self.defaults.model_by_harness.clear();
        self.save_defaults();
        cx.notify();
    }

    /// Harness is locked once the chat exists (feature-inventory §1.7).
    pub(super) fn harness_locked(&self, cx: &App) -> bool {
        self.state.read(cx).selected_chat.is_some()
    }

    pub(super) fn engine(&self, cx: &App) -> Option<EngineHandle> {
        self.state.read(cx).engine().cloned()
    }

    /// The selected space's device when it differs from the connected
    /// engine's own — harness/model catalogs come from the device that RUNS
    /// the agents (the CLIs live there; the viewer may have neither claude
    /// nor codex installed — user report: "can't load codex models/traits
    /// anywhere" from a Mac without codex).
    pub(super) fn space_target(&self, cx: &App) -> Option<String> {
        let state = self.state.read(cx);
        let device = state.selected_space_row()?.device_id.clone();
        (state.local_device_id.as_deref() != Some(device.as_str())).then_some(device)
    }

    /// Effective harness: picked, or the chat's config, or the first listed.
    pub(super) fn effective_harness(&self, cx: &App) -> Option<HarnessId> {
        if let Some(harness) = self.config.harness {
            return Some(harness);
        }
        if let Some(config) = self
            .state
            .read(cx)
            .selected_chat_row()
            .and_then(|c| c.config.as_ref())
        {
            return Some(config.harness);
        }
        // New-chat canvas: the remembered last-used harness (sticky defaults),
        // when the loaded catalog still offers it.
        if let Some(harness) = self.defaults.harness {
            let offered = match self.harnesses.ready() {
                Some(list) => visible_harnesses(list).iter().any(|d| d.id == harness),
                None => true, // catalog not loaded yet — trust the memory
            };
            if offered {
                return Some(harness);
            }
        }
        // Fall back to the first VISIBLE harness: the registry lists the mock
        // harness first, and resolving chips against it would boot the
        // new-chat canvas onto "Mock" instead of Claude Code + its default
        // model (it stays available under `COMET_HARNESS=mock`).
        self.harnesses
            .ready()
            .and_then(|list| visible_harnesses(list).first().map(|d| d.id))
    }

    /// Resolved steering mode for the effective harness: the draft pick (or
    /// the selected chat's harness) looked up in the loaded descriptor list.
    /// Returns `None` when the catalog hasn't loaded yet.
    pub(crate) fn resolved_steering_mode(&self, cx: &App) -> Option<SteeringMode> {
        let harness = self.effective_harness(cx)?;
        self.harnesses.ready().and_then(|list| {
            list.iter()
                .find(|d| d.id == harness)
                .map(|d| d.steering_mode)
        })
    }

    /// Effective ACP agent id: the draft pick, or the selected chat's config.
    /// Only meaningful when [`effective_harness`] is [`HarnessId::Acp`].
    pub(super) fn effective_acp_agent_id(&self, cx: &App) -> Option<String> {
        if let Some(id) = self.config.acp_agent_id.clone() {
            return Some(id);
        }
        self.state
            .read(cx)
            .selected_chat_row()
            .and_then(|c| c.config.as_ref())
            .and_then(|c| c.acp_agent_id.clone())
    }

    /// Effective model id: the draft pick, the selected chat's config, or (on
    /// the new-chat canvas) the remembered last-used model for the harness.
    pub(super) fn effective_model_id<'a>(&'a self, cx: &'a App) -> Option<&'a str> {
        if let Some(id) = self.config.model.as_deref() {
            return Some(id);
        }
        if let Some(chat) = self.state.read(cx).selected_chat_row() {
            return chat.config.as_ref().and_then(|c| c.model.as_deref());
        }
        let harness = self.effective_harness(cx)?;
        self.defaults.model_for(harness).map(|m| m.id.as_str())
    }

    /// Effective reasoning — always concrete once the model is known: the
    /// draft pick / chat config / remembered default, clamped to the selected
    /// model's ladder, falling back to the model's default level.
    pub(super) fn effective_reasoning(&self, cx: &App) -> Option<ReasoningLevel> {
        let explicit = self.config.reasoning.or_else(|| {
            match self.state.read(cx).selected_chat_row() {
                Some(chat) => chat.config.as_ref().and_then(|c| c.reasoning),
                // New chat: the remembered last-used level.
                None => self.defaults.reasoning,
            }
        });
        if self.selected_model(cx).is_none() {
            // Catalog not loaded yet: show the explicit value as-is (nothing
            // to clamp against); it resolves to a concrete level on load.
            return explicit;
        }
        clamp_reasoning(explicit, &self.trait_ladder(cx))
    }

    /// The selected model — concrete from the moment the list loads: the
    /// effective id when the list still offers it, else the harness default
    /// (first row). Never `None` with a non-empty catalog.
    pub(super) fn selected_model<'a>(&'a self, cx: &'a App) -> Option<&'a Model> {
        let harness = self.effective_harness(cx)?;
        let acp_agent_id = self.effective_acp_agent_id(cx);
        let models = self.models.get(&(harness, acp_agent_id))?.ready()?;
        match self.effective_model_id(cx) {
            Some(id) => {
                let found = models.iter().find(|m| m.id == id);
                found.or_else(|| default_model(models))
            }
            None => default_model(models),
        }
    }

    /// Index of the selected model row in the filtered list, so the keyboard-
    /// nav highlight lands ON the pick instead of row 0 (which shares the
    /// selected row's background, reading as a second selection).
    pub(super) fn selected_model_index(&self, cx: &App) -> usize {
        let rows = self.filtered_model_rows(cx);
        let Some(id) = self.selected_model(cx).map(|m| m.id.as_str()) else {
            return 0;
        };
        rows.iter().position(|m| m.id == id).unwrap_or(0)
    }

    /// The explicit (non-default) option picks: the chat's persisted
    /// selections for existing chats, the draft's for the new-chat canvas.
    pub(super) fn explicit_options(&self, cx: &App) -> serde_json::Map<String, serde_json::Value> {
        match self
            .state
            .read(cx)
            .selected_chat_row()
            .and_then(|c| c.config.as_ref())
        {
            Some(config) => config.model_options.clone(),
            None => self.config.model_options.clone(),
        }
    }

    pub(super) fn effective_permission_mode(&self, cx: &App) -> PermissionMode {
        self.state
            .read(cx)
            .selected_chat_row()
            .and_then(|chat| chat.config.as_ref())
            .map(|config| config.permission_mode)
            .unwrap_or(self.config.permission_mode)
    }

    /// The fully-resolved config the composer threads into the Run request and
    /// `Mutate createChat`: concrete model + reasoning whenever the catalog is
    /// loaded (no "engine picks a default" passthrough).
    pub fn resolved(&self, cx: &App) -> ResolvedRunConfig {
        ResolvedRunConfig {
            harness: self.effective_harness(cx),
            model: self
                .selected_model(cx)
                .map(|m| m.id.clone())
                // Catalog not loaded (offline): still send the id we know.
                .or_else(|| self.effective_model_id(cx).map(str::to_string)),
            reasoning: self.effective_reasoning(cx),
            model_options: self.explicit_options(cx),
            permission_mode: self.effective_permission_mode(cx),
            acp_agent_id: self.config.acp_agent_id.clone(),
        }
    }

    // ---- open/close ----

    pub(super) fn close(&mut self, cx: &mut Context<Self>) {
        if let Some(kind) = self.open.take() {
            self.suppressed = Some((kind, Instant::now()));
        }
        cx.notify();
    }

    /// Capture knob (`COMET_OPEN_DIALOG=model`): open the combined
    /// harness/model menu programmatically.
    pub fn open_model_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.open != Some(PickerKind::HarnessModel) {
            self.toggle(PickerKind::HarnessModel, window, cx);
        }
    }

    pub(super) fn toggle(&mut self, kind: PickerKind, window: &mut Window, cx: &mut Context<Self>) {
        if self.open == Some(kind) {
            self.open = None;
            cx.notify();
            return;
        }
        // A just-dismissed popover's trigger click must not instantly reopen.
        if let Some((suppressed, at)) = self.suppressed.take()
            && suppressed == kind
            && at.elapsed() < Duration::from_millis(400)
        {
            cx.notify();
            return;
        }
        self.open = Some(kind);
        self.search.update(cx, |input, cx| {
            input.set_placeholder("Search…", cx);
            input.set_text("", cx);
        });
        // The keyboard-nav highlight starts ON the selected row — row 0
        // otherwise reads as a second active row (user report).
        self.active = match kind {
            PickerKind::Checkout => match self.config.checkout {
                CheckoutKind::Local => 0,
                CheckoutKind::NewWorktree => 1,
            },
            PickerKind::Permission => self.effective_permission_mode(cx) as usize,
            PickerKind::Branch => self.selected_ref_index(cx),
            PickerKind::HarnessModel => self.selected_model_index(cx),
            _ => 0,
        };
        if kind == PickerKind::HarnessModel {
            // Scroll the selected row into view so the highlight is visible
            // without manual scrolling (deferred one frame because the list
            // view may not have laid out the new items yet).
            let target = self.active;
            let weak = cx.weak_entity();
            cx.defer(move |cx| {
                weak.update(cx, |this, cx| {
                    if this.open == Some(PickerKind::HarnessModel) {
                        this.model_scroll.scroll_to_item(target);
                        cx.notify();
                    }
                })
                .ok();
            });
        }
        // Searchable pickers focus the filter input (it sits inside the frame,
        // so the frame's key handler still sees arrows/Enter); the rest focus
        // the frame itself for pure keyboard nav.
        match kind {
            PickerKind::Branch => {
                self.switch_error = None; // stale mid-session failures don't linger
                let handle = self.search.read(cx).focus_handle(cx);
                self.search.update(cx, |input, cx| {
                    input.set_placeholder("Search refs…", cx);
                });
                window.focus(&handle, cx);
            }
            PickerKind::HarnessModel => {
                let handle = self.search.read(cx).focus_handle(cx);
                self.search.update(cx, |input, cx| {
                    input.set_placeholder("Search models…", cx);
                });
                window.focus(&handle, cx);
            }
            _ => window.focus(&self.focus, cx),
        }
        match kind {
            // Force: the checkout state moves under us (a send mints a
            // worktree+branch, terminals switch refs) — every open
            // revalidates, keeping stale rows visible until fresh ones land.
            PickerKind::Branch | PickerKind::Checkout => self.ensure_refs(true, cx),
            PickerKind::HarnessModel | PickerKind::Traits => {
                self.ensure_harnesses(cx);
                if let Some(harness) = self.effective_harness(cx) {
                    let acp_agent_id = self.effective_acp_agent_id(cx);
                    // Provider selection is device-local settings outside this
                    // entity. Refresh on every picker open so switching to a
                    // custom provider immediately replaces a previously
                    // cached built-in catalog.
                    self.models.remove(&(harness, acp_agent_id.clone()));
                    self.ensure_models(harness, acp_agent_id, cx);
                }
            }
            PickerKind::Permission => {}
        }
        cx.notify();
    }
}


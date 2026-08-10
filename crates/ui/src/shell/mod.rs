//! Shell: the top-level window chrome (titlebar, sidebar, main area,
//! overlays, status bar).
//!
//! The app shell (comet `__root.tsx`): sidebar column + main panel + optional
//! right "Changes" pane, plus the boot splash and the connection gate.

mod layout;
mod nav;
pub mod spaces;
pub mod tabs;
mod shell_core;
mod shell_render_chrome;
mod shell_render_sidebar;
mod shell_render_activity;
mod shell_render_main;
mod shell_render_gate;
mod shell_render_inspector;
mod render_fns;
pub(crate) use render_fns::header_icon_button;
#[cfg(test)]
mod tests;

pub(crate) use layout::{
    titlebar_cluster_start, Route, SessionPanels,
};
pub(crate) use nav::{
    NavHistory, WidthTween, SplashPhase, UpdateFlow,
    OrgGateUi, SidebarResize,
    CHAT_ROW_HEIGHT,
    RenameChatDialog,
};

use std::path::PathBuf;

actions!(shell, [ToggleSidebar, ToggleChanges, AddSpacePalette, ToggleInspector]);

use chrono::Utc;
use gpui::{
    AnyElement, App, Context, Empty, Entity, Focusable as _, IntoElement,
    MouseButton, MouseDownEvent, Pixels, Point, Render, SharedString, Subscription,
    Task, Window, actions, div, prelude::*, px,
};

use comet_rpc::methods;

use crate::changes::Changes;
use crate::composer::{Composer, ComposerInput, ComposerInputEvent};
use crate::dev_inspector::{self, InspectClickExt as _, InspectExt as _};
use crate::icons::{self, icon};
use crate::loaders;
use crate::motion::{self, AnimationExt as _};
use crate::popover::{self, Loadable};
use crate::rail;
use crate::settings::accounts::AccountsPage;
use crate::settings::acp_agents::AcpAgentsPage;
use crate::settings::appearance::AppearancePage;
use crate::settings::archived::ArchivedPage;
use crate::settings::context_engine::ContextEnginePage;
use crate::settings::devices::DevicesPage;
use crate::settings::notifications::NotificationsPage;
use crate::settings::providers::ProvidersPage;
use crate::settings::shortcuts::ShortcutsPage;
use crate::settings::workflows::WorkflowsPage;
use crate::settings::{
    SIDEBAR_DEFAULT, UiSettings,
};
use crate::state::{
    AppState, EngineBootConfig, GatePhase, Indicator, format_time_ago,
};
use crate::terminal::panel::{TerminalPanel, ToggleTerminal};
use crate::theme::Theme;
use crate::transcript::{self, Transcript};

use spaces::{AddSpaceFlow, RenameSpaceDialog};

// ---------------------------------------------------------------------------
// Traffic-light-aware titlebar layout (feature-inventory §1.1)
// ---------------------------------------------------------------------------

/// Where the top-left window-control cluster starts, in px from the window's
/// left edge (comet window-controls.tsx: `left: fullscreen ? 12 : 88`). The
/// frameless hiddenInset chrome puts the macOS traffic lights at {14,15};
/// fullscreen hides them and the cluster reclaims the inset.

pub struct Shell {
    pub(crate) state: Entity<AppState>,
    pub(crate) transcript: Entity<Transcript>,
    pub(crate) composer: Entity<Composer>,
    /// External file drag hovering the conversation column — shows the
    /// "Drop images to attach" veil over the whole chat area; a drop stages
    /// the files in the composer.
    pub(crate) file_drag_active: bool,
    /// Lazy panes: no entity (and no RPC) until first opened.
    pub(crate) terminal: Option<Entity<TerminalPanel>>,
    pub(crate) changes: Option<Entity<Changes>>,
    /// Chat outlet vs settings pages.
    pub(crate) route: Route,
    /// Sidebar surface: the normal Spaces/Sessions view or the flat Activity
    /// feed.
    pub(crate) activity_open: bool,
    pub(crate) activity_done_open: bool,
    /// Route history behind the titlebar back/forward buttons (§ nav history).
    pub(crate) nav: NavHistory,
    pub(crate) devices_page: Option<Entity<DevicesPage>>,
    pub(crate) archived_page: Option<Entity<ArchivedPage>>,
    pub(crate) workflows_page: Option<Entity<WorkflowsPage>>,
    pub(crate) appearance_page: Option<Entity<AppearancePage>>,
    pub(crate) shortcuts_page: Option<Entity<ShortcutsPage>>,
    pub(crate) accounts_page: Option<Entity<AccountsPage>>,
    pub(crate) providers_page: Option<Entity<ProvidersPage>>,
    pub(crate) providers_sub: Option<Subscription>,
    pub(crate) acp_agents_page: Option<Entity<AcpAgentsPage>>,
    pub(crate) context_engine_page: Option<Entity<ContextEnginePage>>,
    pub(crate) notifications_page: Option<Entity<NotificationsPage>>,
    pub(crate) notifications_sub: Option<Subscription>,
    pub(crate) shortcuts_sub: Option<Subscription>,
    pub(crate) shortcuts_sync_loaded: bool,
    pub(crate) workflows_sub: Option<Subscription>,
    /// Session-row context menu: (chat id, window position).
    pub(crate) chat_menu: Option<(String, Point<Pixels>)>,
    pub(crate) rename_dialog: Option<RenameChatDialog>,
    /// Chat id awaiting delete confirmation.
    pub(crate) delete_confirm: Option<String>,
    /// Space-row context menu: (space id, window position).
    pub(crate) space_menu: Option<(String, Point<Pixels>)>,
    pub(crate) rename_space_dialog: Option<RenameSpaceDialog>,
    /// Per-project agent setup for a space's folder.
    pub(crate) project_harness: Option<spaces::ProjectHarnessFlow>,
    /// Space id awaiting delete confirmation (hard delete + session cascade).
    pub(crate) delete_space_confirm: Option<String>,
    /// The add-space palette (⌘K-style; device tabs + folder search), `Some`
    /// while open.
    pub(crate) add_space: Option<AddSpaceFlow>,
    /// Last selected chat per space (in-memory, like [`SessionPanels`]) — a
    /// space switch lands back on the tab you left.
    pub(crate) space_last_chat: std::collections::HashMap<String, String>,
    /// Session tab currently hovered (close button appears on hover).
    pub(crate) tab_hover: Option<String>,
    /// Space-row drag-reorder in flight (see `spaces::SpaceDragState`).
    pub(crate) space_drag: Option<spaces::SpaceDragState>,
    /// Scroll position of the session tab region (drives the edge fades and
    /// the drop-index math under horizontal overflow).
    pub(crate) tabs_scroll: gpui::ScrollHandle,
    /// Chat id last auto-scrolled into view — scroll-to-selected fires once per
    /// selection change, not every frame (which would fight manual scrolling).
    pub(crate) tabs_scrolled_to: Option<String>,
    /// Scroll position of the sidebar lists region (drives its edge fades).
    pub(crate) sidebar_scroll: gpui::ScrollHandle,
    /// Virtualized scroll handle for the sidebar Sessions list. Only the
    /// visible chat rows render each frame — without this `overflow_y_scroll`
    /// built and laid out every row on every scroll tick, dropping FPS and
    /// pinning CPU once the list grew past a few dozen sessions.
    pub(crate) sidebar_chat_scroll: gpui::UniformListScrollHandle,
    /// Pre-computed row data for the sidebar Sessions list, refreshed at the
    /// top of each sidebar render pass. The virtualized `uniform_list` closure
    /// reads from this to build elements only for the visible range.
    pub(crate) sidebar_row_data: Vec<spaces::ActiveRowData>,
    /// `settings.last_space_id` applied once after the first spaces frame.
    pub(crate) space_boot_applied: bool,
    /// Last seen session status per chat — the chime trigger compares against
    /// it (a row's FIRST appearance never chimes, so boot stays silent).
    pub(crate) sound_prev: std::collections::HashMap<String, comet_proto::SessionStatus>,
    pub(crate) user_menu_open: bool,
    /// Outside-click dismissal instant — suppresses the trigger click that
    /// follows the same mouse-down from instantly reopening the menu.
    pub(crate) user_menu_dismissed_at: Option<std::time::Instant>,
    /// Inline sidebar error strip (mutation failures); click dismisses.
    pub(crate) sidebar_notice: Option<SharedString>,
    /// Local lifecycle of an in-app update (macOS bundle swap) — the engine's
    /// UpdateStatus stream says WHETHER one exists; this says how far the
    /// download/stage of it has come in this process.
    pub(crate) update_flow: UpdateFlow,
    pub(crate) update_task: Option<Task<()>>,
    /// Version whose update strip the user dismissed (advisory installs only —
    /// a newer release shows the strip again).
    pub(crate) update_dismissed: Option<String>,
    /// How this binary was installed — decides the strip's click behavior.
    /// Cached: `detect_install` stats `current_exe` and this renders per frame.
    pub(crate) install: comet_update::InstallKind,
    pub(crate) org: Option<OrgGateUi>,
    pub(crate) mutate_task: Option<Task<()>>,
    pub(crate) auth_task: Option<Task<()>>,
    /// Kept for the failed-gate "Retry" action.
    pub(crate) boot: EngineBootConfig,
    pub(crate) data_dir: PathBuf,
    pub(crate) settings: UiSettings,
    /// Session-scoped panel open flags (terminal / changes per chat; §1.10-1.11
    /// parity — heights stay in [`UiSettings`]).
    pub(crate) panels: SessionPanels,
    /// The panel key of the chat currently shown ("" = new-chat canvas).
    pub(crate) active_chat: String,
    /// Last rendered sidebar order (key + estimated height) — the FLIP baseline
    /// for the §1.6 resort glide.
    pub(crate) sidebar_prev_order: Vec<(String, f32)>,
    /// Per-key paint offsets of the resort in flight, keyed elements restart on
    /// `resort_epoch` bumps.
    pub(crate) sidebar_resort: std::collections::HashMap<String, f32>,
    /// Keys that just appeared in a live list (fade in, no glide).
    pub(crate) sidebar_new_keys: std::collections::HashSet<String>,
    pub(crate) resort_epoch: usize,
    /// Dev/testing knobs (`COMET_OPEN_DIALOG`, `COMET_FORCE_GATE`) — see
    /// [`Shell::new`].
    pub(crate) debug_dialog: Option<String>,
    pub(crate) debug_gate: Option<GatePhase>,
    pub(crate) sidebar_tween: Option<WidthTween>,
    pub(crate) right_tween: Option<WidthTween>,
    pub(crate) terminal_tween: Option<WidthTween>,
    /// Last observed `window.is_fullscreen()` (`None` before first paint) —
    /// flips key the traffic-light inset tween.
    pub(crate) fullscreen: Option<bool>,
    /// 200ms ease-out tween of the cluster start on fullscreen toggles.
    pub(crate) titlebar_tween: Option<WidthTween>,
    /// Armed by mouse-down on a titlebar strip; the next mouse-move hands the
    /// drag to the compositor (zed's platform-titlebar pattern).
    pub(crate) titlebar_should_move: bool,
    /// Clears the height tween once it completes (so a closed panel unmounts).
    pub(crate) terminal_tween_task: Option<Task<()>>,
    /// Height-drag anchor: (pointer y, height) at mouse-down on the handle.
    pub(crate) terminal_drag_anchor: Option<(f32, f32)>,
    /// `motion::reduced_motion` snapshot, refreshed at the top of each render
    /// pass so [`Shell::eval_tween`] (called from `&self` render helpers) can
    /// snap without a `cx`.
    pub(crate) reduced_motion: bool,
    /// Set by [`Shell::eval_tween`] when any tween is mid-flight this frame;
    /// render schedules the next animation frame off it.
    pub(crate) motion_active: std::cell::Cell<bool>,
    pub(crate) splash: SplashPhase,
    pub(crate) splash_task: Option<Task<()>>,
    pub(crate) save_task: Option<Task<()>>,
    /// Focus fallback (registered on first paint — [`Shell::new`] has no
    /// window): keyboard shortcuts dispatch through the window focus chain, so
    /// with nothing focused they go dead. Initial focus lands on the composer
    /// and focus lost with no successor routes back there.
    pub(crate) focus_sub: Option<Subscription>,
    /// 1s heartbeat re-rendering the working indicator (elapsed + flavour word).
    pub(crate) _ticker: Task<()>,
    pub(crate) _state_observation: Subscription,
    pub(crate) _composer_events: Subscription,
    pub(crate) _transcript_events: Subscription,
}


impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(cx);
        // The shell tone (comet `.frost`): the surface the sidebar sits on and
        // the main panel floats over as an inset rounded card. On macOS the
        // window background is the blurred desktop (lib.rs `Blurred`), so the
        // frost paints translucent — the sidebar and card margins read as
        // glass while the opaque card keeps text off it.
        let (frost, text, font) = (theme.glass(), theme.text, theme.font_sans.clone());
        let gate = self
            .debug_gate
            .clone()
            .unwrap_or_else(|| self.state.read(cx).gate());

        // Fullscreen hides the macOS traffic lights — reflow the control
        // cluster with a 200ms ease-out tween (§1.1). A fullscreen transition
        // resizes the window, which re-renders us, so polling here is exact.
        let fullscreen = window.is_fullscreen();
        if self.fullscreen != Some(fullscreen) {
            if self.fullscreen.is_some() && cfg!(target_os = "macos") {
                self.titlebar_tween = Some(WidthTween::new(
                    titlebar_cluster_start(!fullscreen),
                    titlebar_cluster_start(fullscreen),
                ));
            }
            self.fullscreen = Some(fullscreen);
        }
        // Manual tween drive bookkeeping for this pass (see [`WidthTween`]).
        self.reduced_motion = motion::reduced_motion(cx);
        self.motion_active.set(false);

        // Keyboard shortcuts (mod-s/b/j) dispatch through the window focus
        // chain — with nothing focused they go dead. Land initial focus on the
        // composer, and whenever focus is lost with no successor (e.g. the
        // focused element unmounted), route it back there.
        if self.focus_sub.is_none() {
            self.focus_sub = Some(cx.on_focus_lost(window, |this: &mut Shell, window, cx| {
                match this.route {
                    Route::Chat => window.focus(&this.composer.focus_handle(cx), cx),
                    // No composer here — clear the stale handle so `focused()`
                    // reads None (the render hook below re-lands focus when the
                    // route returns to Chat; a lingering unmounted handle would
                    // otherwise dead-end keyboard dispatch for good).
                    Route::Settings(_) => window.blur(),
                }
            }));
        }
        if matches!(gate, GatePhase::Ready)
            && matches!(self.route, Route::Chat)
            && window.focused(cx).is_none()
        {
            window.focus(&self.composer.focus_handle(cx), cx);
        }

        let root = div()
            .id("shell-root")
            .relative()
            .flex()
            .flex_row()
            .size_full()
            .bg(frost)
            .text_color(text)
            .font_family(font)
            .text_size(px(14.0))
            .on_drag_move(cx.listener(Self::on_sidebar_drag))
            .on_drag_move(cx.listener(Self::on_right_pane_drag))
            .on_drag_move(cx.listener(Self::on_terminal_drag))
            // The panel shortcuts are chat-scoped chrome: in Settings they are
            // no-ops (comet __root.tsx gates the hotkey on `!isSettings`, and
            // the terminal panel is only mounted on session routes). The
            // sidebar toggle stays live everywhere, as in the original.
            .on_action(cx.listener(|this, _: &ToggleTerminal, window, cx| {
                if matches!(this.route, Route::Chat) {
                    this.toggle_terminal(window, cx)
                }
            }))
            .on_action(cx.listener(|this, _: &ToggleSidebar, _, cx| this.toggle_sidebar(cx)))
            .on_action(cx.listener(|this, _: &ToggleChanges, _, cx| {
                if matches!(this.route, Route::Chat) {
                    this.toggle_right_pane(cx)
                }
            }))
            .on_action(cx.listener(|this, _: &AddSpacePalette, _, cx| {
                if this.add_space.is_some() {
                    this.add_space = None;
                    cx.notify();
                } else {
                    this.open_add_space(cx);
                }
            }))
            .on_action(cx.listener(|_, _: &ToggleInspector, _, cx| {
                if crate::dev_inspector::InspectorState::feature_enabled() {
                    let state = crate::dev_inspector::global_state(cx);
                    state.toggle_picking();
                    state.clear_selection();
                    cx.notify();
                }
            }));

        let root = match &gate {
            GatePhase::Ready => {
                // A run finishing while you're LOOKING at the session must not
                // badge "completed" until you leave and return — mark it seen
                // live while the window is active (idempotent guard inside;
                // one extra frame settles it).
                if window.is_window_active() {
                    let unseen_selected = {
                        let s = self.state.read(cx);
                        s.selected_chat_row()
                            .filter(|c| c.unseen())
                            .map(|c| c.id.clone())
                    };
                    if let Some(chat_id) = unseen_selected {
                        self.state
                            .update(cx, |s, cx| s.mark_chat_seen(&chat_id, cx));
                    }
                }
                // Capture knob: `COMET_OPEN_DIALOG=model` pops the combined
                // harness/model menu (needs `window`, so it fires here rather
                // than in `on_state_changed`).
                if self.debug_dialog.as_deref() == Some("model") {
                    self.debug_dialog = None;
                    self.composer
                        .update(cx, |c, cx| c.debug_open_model_menu(window, cx));
                }
                // MessageRail width gate: hide below 48rem of main-panel width.
                let viewport = f32::from(window.viewport_size().width);
                let main_width = viewport - self.sidebar_target() - self.right_target(cx) - 10.0;
                self.transcript.update(cx, |t, cx| {
                    t.set_rail_enabled(rail::rail_visible(main_width), cx)
                });

                let sidebar = self.render_sidebar(cx);
                let sidebar_handle = self.resize_handle(
                    "sidebar-resize",
                    || SidebarResize,
                    |shell, _| shell.settings.sidebar_width = SIDEBAR_DEFAULT,
                    cx,
                );
                let main = self.render_main(cx);
                // The Changes pane is chat-scoped chrome: the Settings route
                // never renders it (comet __root.tsx `!isSettings && activeChat`
                // around the diff column) — the per-session open flags stay
                // intact for the return trip.
                let on_chat = matches!(self.route, Route::Chat);
                let right: AnyElement = if on_chat {
                    self.render_right_pane(cx)
                } else {
                    Empty.into_any_element()
                };
                let overlays = self.render_overlays(window.viewport_size(), window, cx);
                // The signature frame: the conversation card and — when the
                // changes pane is open — a SECOND inset card beside it, both
                // rounded hairline-bordered floats on the frost shell (the
                // changes card is built inside `render_right_pane`).
                let theme = Theme::of(cx);
                // Margins, radius, and border-color MELT over the same 200ms
                // ease-out as the sidebar width (comet __root.tsx `<main>`
                // `transition-[margin,border-radius,border-color]`; collapsed
                // is `m-0 rounded-none border-transparent` — the border WIDTH
                // stays, only its color fades, so layout never jumps by the
                // hairline).
                let border_color = theme.border;
                let card = div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_row()
                    .overflow_hidden()
                    .bg(theme.bg)
                    .border_1()
                    .child(main);
                // Manual drive on the SAME clock as the sidebar width tween.
                // Crucially there is no `with_animation` wrapper here: the
                // wrapper's epoch-keyed id used to change every card
                // descendant's global element-id path on each toggle, which
                // reset gpui's per-element animation state and REPLAYED any
                // stale pane/terminal tween from t=0 (the changes pane slid
                // ~100px under the clip mid-toggle — round-6 §2/§3).
                //
                // The inset card persists in EVERY state (user request): top
                // gutter under the unified titlebar, constant left/right/
                // bottom gutters, constant radius + hairline — the 8px left
                // gap holds whether it borders the sidebar or the window edge.
                // No top margin: the titlebar's own internal air (44px bar,
                // 28px tabs) is the gap — an extra gutter read as a hole
                // between the header and the app (user report).
                // The right margin is the window gutter when the changes
                // pane is closed, but the SEAM between the two inset cards
                // when it's open — a full gutter there read double-wide next
                // to the two borders it separates (user report).
                let right_gap = if on_chat && self.right_pane_open(cx) {
                    4.0
                } else {
                    8.0
                };
                let card: AnyElement = card
                    .mb(px(8.0))
                    .mr(px(right_gap))
                    .ml(px(8.0))
                    .rounded(px(12.0))
                    .border_color(border_color)
                    .into_any_element();
                // The whole app page is one keyed `animate-in` entrance (comet
                // App.tsx `<div key={phase} className="animate-in h-full">`):
                // arriving from the splash or any gate fades the page in; the
                // splash-out crossfades over it on boot.
                // The sidebar resize handle FLOATS over the sidebar/card seam
                // (zero layout width, same idiom as the changes-pane grabber)
                // so the sidebar's right gutter stays exactly as wide as its
                // left one — a 5px flex child here read as lopsided spacing.
                let sidebar_seam = div()
                    .w(px(0.0))
                    .h_full()
                    .flex_none()
                    .relative()
                    .child(sidebar_handle.absolute().top_0().bottom_0().left(px(-2.0)));
                let title_bar = self.render_title_bar(cx);
                // Sidebar tone: a slightly lighter column behind the sidebar,
                // spanning the FULL window height (under the traffic lights,
                // through the titlebar, down to the bottom edge). Its width
                // rides the same tween as the sidebar, so the tone melts away
                // with the collapse instead of vanishing in a frame.
                let sidebar_now = self.eval_tween(self.sidebar_tween, self.sidebar_target());
                // Hairline on its right edge — full height like the tone,
                // so the sidebar column reads as its own surface.
                let sidebar_tone = div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left_0()
                    .w(px(sidebar_now))
                    .bg(crate::theme::wash(0.05))
                    .border_r_1()
                    .border_color(border_color);
                let page = div()
                    .size_full()
                    .flex()
                    .flex_col()
                    .child(title_bar)
                    .child(
                        div()
                            .flex_1()
                            .min_h_0()
                            .flex()
                            .flex_row()
                            .child(sidebar)
                            .child(sidebar_seam)
                            .child(card)
                            .child(right),
                    )
                    .child(self.render_titlebar_cluster(cx))
                    .children(overlays);
                root.child(sidebar_tone)
                    .child(motion::fade_in("phase-app", page))
            }
            GatePhase::Loading => root, // splash overlay covers boot
            GatePhase::OrgGate => {
                let card = self.render_org_gate(cx);
                root.child(card)
            }
            phase @ (GatePhase::Failed(_) | GatePhase::SignIn) => {
                let card = self.render_gate_card(phase, cx);
                root.child(card)
            }
        };

        // A manually-driven tween is mid-flight: keep frames coming (the same
        // scheduling `with_animation` would have requested). Hover color fades
        // ride the same clock; their once-per-frame tick lives here (this is
        // the window's root render — it runs exactly once per frame).
        if self.motion_active.get() | motion::hover_fades_active() {
            window.request_animation_frame();
        }

        // Agent debug inspector overlay (fixed bottom-right icon + pick mode).
        // Zero-cost in release builds without COMET_INSPECTOR (renders empty div).
        let root = if crate::dev_inspector::InspectorState::feature_enabled() {
            root.child(self.render_inspector_overlay(window, cx))
        } else {
            root
        };

        // Boot splash overlay: visible → crossfades out on Ready → removed.
        match self.splash {
            SplashPhase::Visible => {
                let theme = Theme::of(cx).clone();
                let view = cx.entity_id();
                root.child(loaders::splash_overlay(&theme, false, view, cx))
            }
            SplashPhase::FadingOut => {
                let theme = Theme::of(cx).clone();
                let view = cx.entity_id();
                root.child(loaders::splash_overlay(&theme, true, view, cx))
            }
            SplashPhase::Gone => root,
        }
    }
}



use gpui::{
    AnyElement, Context, Empty, IntoElement,
    MouseButton, WindowControlArea, div, prelude::*, px,
};

use comet_rpc::methods;

use crate::composer::{ComposerInput, ComposerInputEvent};
use crate::icons::{self};
use crate::motion::{self, RESIZE};
use crate::popover::Loadable;
use crate::settings::accounts::AccountsPage;
use crate::settings::acp_agents::AcpAgentsPage;
use crate::settings::appearance::AppearancePage;
use crate::settings::archived::ArchivedPage;
use crate::settings::context_engine::ContextEnginePage;
use crate::settings::devices::DevicesPage;
use crate::settings::notifications::{NotificationsEvent, NotificationsPage};
use crate::settings::providers::{ProvidersEvent, ProvidersPage};
use crate::settings::shortcuts::{ShortcutsEvent, ShortcutsPage};
use crate::settings::workflows::{WorkflowsEvent, WorkflowsPage};
use crate::state::{
    org_name_valid, parse_orgs, sort_memberships,
};
use crate::theme::Theme;

use super::layout::{
    titlebar_cluster_start, cluster_buttons_start,
    apply_keymap, Route, SettingsSection, CLUSTER_BUTTONS_WIDTH,
};
use super::nav::{
    NavEntry, RenameChatDialog, WidthTween, OrgGateUi,
};
use super::render_fns::{nav_history_button, window_control_button};
use super::Shell;

impl Shell {
    pub(super) fn open_settings(&mut self, section: SettingsSection, cx: &mut Context<Self>) {
        self.route = Route::Settings(section);
        self.nav.push(NavEntry::Settings(section));
        self.user_menu_open = false;
        self.chat_menu = None;
        cx.notify();
    }

    pub(super) fn close_settings(&mut self, cx: &mut Context<Self>) {
        self.route = Route::Chat;
        self.nav.push(NavEntry::Chat(self.active_chat.clone()));
        cx.notify();
    }

    // ---- back/forward (route history) ----

    pub(super) fn navigate_back(&mut self, cx: &mut Context<Self>) {
        if let Some(entry) = self.nav.back() {
            self.apply_nav(entry, cx);
        }
    }

    pub(super) fn navigate_forward(&mut self, cx: &mut Context<Self>) {
        if let Some(entry) = self.nav.forward() {
            self.apply_nav(entry, cx);
        }
    }

    /// Land on a history entry WITHOUT recording a new one: the stack already
    /// points at `entry` (back/forward moved the index); the selection change
    /// this triggers dedups against `current()` in [`Self::on_state_changed`].
    pub(super) fn apply_nav(&mut self, entry: NavEntry, cx: &mut Context<Self>) {
        match entry {
            NavEntry::Chat(chat_id) => {
                self.route = Route::Chat;
                let target = (!chat_id.is_empty()).then_some(chat_id);
                if self.state.read(cx).selected_chat != target {
                    self.state.update(cx, |s, cx| s.select_chat(target, cx));
                }
            }
            NavEntry::Settings(section) => {
                self.route = Route::Settings(section);
            }
        }
        self.user_menu_open = false;
        self.chat_menu = None;
        cx.notify();
    }

    /// Lazily create the entity for a settings section and return it renderable.
    pub(super) fn settings_outlet(&mut self, section: SettingsSection, cx: &mut Context<Self>) -> AnyElement {
        match section {
            SettingsSection::Devices => {
                if self.devices_page.is_none() {
                    let state = self.state.clone();
                    self.devices_page = Some(cx.new(|cx| DevicesPage::new(state, cx)));
                }
                match &self.devices_page {
                    Some(page) => page.clone().into_any_element(),
                    None => Empty.into_any_element(),
                }
            }
            SettingsSection::Agents => {
                if self.accounts_page.is_none() {
                    let state = self.state.clone();
                    self.accounts_page = Some(cx.new(|cx| AccountsPage::new(state, cx)));
                }
                match &self.accounts_page {
                    Some(page) => page.clone().into_any_element(),
                    None => Empty.into_any_element(),
                }
            }
            SettingsSection::Providers => {
                if self.providers_page.is_none() {
                    let state = self.state.clone();
                    let page = cx.new(|cx| ProvidersPage::new(state, cx));
                    self.providers_sub = Some(cx.subscribe(
                        &page,
                        |this: &mut Shell, _, event: &ProvidersEvent, cx| {
                            if matches!(event, ProvidersEvent::Changed) {
                                this.composer.update(cx, |composer, cx| {
                                    composer.invalidate_model_catalogs(cx);
                                });
                                cx.notify();
                            }
                        },
                    ));
                    self.providers_page = Some(page);
                }
                match &self.providers_page {
                    Some(page) => page.clone().into_any_element(),
                    None => Empty.into_any_element(),
                }
            }
            SettingsSection::AcpAgents => {
                if self.acp_agents_page.is_none() {
                    let state = self.state.clone();
                    self.acp_agents_page = Some(cx.new(|cx| AcpAgentsPage::new(state, cx)));
                }
                match &self.acp_agents_page {
                    Some(page) => page.clone().into_any_element(),
                    None => Empty.into_any_element(),
                }
            }
            SettingsSection::ContextEngine => {
                if self.context_engine_page.is_none() {
                    let data_dir = self.data_dir.clone();
                    self.context_engine_page = Some(cx.new(|_| ContextEnginePage::new(data_dir)));
                }
                match &self.context_engine_page {
                    Some(page) => page.clone().into_any_element(),
                    None => Empty.into_any_element(),
                }
            }
            SettingsSection::Notifications => {
                if self.notifications_page.is_none() {
                    let data_dir = self.data_dir.clone();
                    let settings = self.settings.clone();
                    let page = cx.new(|_cx| NotificationsPage::new(data_dir, settings));
                    let sub = cx.subscribe(&page, |this, _, event: &NotificationsEvent, cx| {
                        let NotificationsEvent::Changed {
                            notifications_enabled,
                            sound_enabled,
                        } = event;
                        this.settings.notifications_enabled = *notifications_enabled;
                        this.settings.sound_enabled = *sound_enabled;
                        this.schedule_save(cx);
                        cx.notify();
                    });
                    self.notifications_page = Some(page);
                    self.notifications_sub = Some(sub);
                }
                match &self.notifications_page {
                    Some(page) => page.clone().into_any_element(),
                    None => Empty.into_any_element(),
                }
            }
            SettingsSection::Appearance => {
                if self.appearance_page.is_none() {
                    self.appearance_page = Some(cx.new(AppearancePage::new));
                }
                match &self.appearance_page {
                    Some(page) => page.clone().into_any_element(),
                    None => Empty.into_any_element(),
                }
            }
            SettingsSection::Shortcuts => {
                if self.shortcuts_page.is_none() {
                    let state = self.state.clone();
                    let keymap = self.settings.keymap.clone();
                    let ai_shortcuts = self.settings.ai_shortcuts.clone();
                    let page = cx.new(|cx| ShortcutsPage::new(state, keymap, ai_shortcuts, cx));
                    // Persist + re-apply the keymap whenever the page changes it.
                    self.shortcuts_sub = Some(cx.subscribe(
                        &page,
                        |this: &mut Shell, _, event: &ShortcutsEvent, cx| {
                            let ShortcutsEvent::Changed {
                                keymap,
                                ai_shortcuts,
                            } = event;
                            this.settings.keymap = keymap.clone();
                            this.settings.ai_shortcuts = ai_shortcuts.clone();
                            apply_keymap(cx, keymap);
                            if let Some(runtime) = cx
                                .try_global::<crate::global_shortcuts::GlobalShortcutRuntimeHandle>(
                                )
                                .map(|runtime| runtime.0.clone())
                            {
                                runtime.update(cx, |runtime, cx| {
                                    runtime.configure(ai_shortcuts.clone(), cx)
                                });
                            }
                            this.schedule_save(cx);
                            this.sync_shortcuts(cx);
                            cx.notify();
                        },
                    ));
                    self.shortcuts_page = Some(page);
                }
                match &self.shortcuts_page {
                    Some(page) => page.clone().into_any_element(),
                    None => Empty.into_any_element(),
                }
            }
            SettingsSection::Workflows => {
                if self.workflows_page.is_none() {
                    let state = self.state.clone();
                    let workflows = self.settings.workflows.clone();
                    let page = cx.new(|cx| WorkflowsPage::new(workflows, state, cx));
                    self.workflows_sub = Some(cx.subscribe(
                        &page,
                        |this: &mut Shell, _, event: &WorkflowsEvent, cx| {
                            let WorkflowsEvent::GlobalChanged(workflows) = event;
                            this.settings.workflows = workflows.clone();
                            this.schedule_save(cx);
                            cx.notify();
                        },
                    ));
                    self.workflows_page = Some(page);
                }
                match &self.workflows_page {
                    Some(page) => page.clone().into_any_element(),
                    None => Empty.into_any_element(),
                }
            }
            SettingsSection::Archived => {
                if self.archived_page.is_none() {
                    let state = self.state.clone();
                    self.archived_page = Some(cx.new(|cx| ArchivedPage::new(state, cx)));
                }
                match &self.archived_page {
                    Some(page) => page.clone().into_any_element(),
                    None => Empty.into_any_element(),
                }
            }
        }
    }

    // ---- sidebar mutations ----

    /// Fire a Mutate op; failures surface in the sidebar notice strip.
    pub(super) fn mutate(&mut self, params: serde_json::Value, cx: &mut Context<Self>) {
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            self.sidebar_notice = Some("Engine not connected".into());
            cx.notify();
            return;
        };
        self.mutate_task = Some(cx.spawn(async move |this, cx| {
            if let Err(err) = engine.client().call(methods::MUTATE, params).await {
                this.update(cx, |shell, cx| {
                    shell.sidebar_notice = Some(format!("{err}").into());
                    cx.notify();
                })
                .ok();
            }
        }));
    }

    pub(super) fn open_rename_chat(&mut self, chat_id: String, cx: &mut Context<Self>) {
        self.chat_menu = None;
        let current = self
            .state
            .read(cx)
            .chats
            .iter()
            .find(|c| c.id == chat_id)
            .and_then(|c| c.title.clone())
            .unwrap_or_default();
        let input = cx.new(|cx| ComposerInput::new("Session title", cx));
        input.update(cx, |input, cx| input.set_text(current, cx));
        let events = cx.subscribe(&input, |this: &mut Shell, _, event, cx| {
            if matches!(event, ComposerInputEvent::Submitted) {
                this.submit_rename_chat(cx);
            }
        });
        self.rename_dialog = Some(RenameChatDialog {
            chat_id,
            input,
            focus_pending: true,
            _events: events,
        });
        cx.notify();
    }

    pub(super) fn submit_rename_chat(&mut self, cx: &mut Context<Self>) {
        let Some(dialog) = self.rename_dialog.take() else {
            return;
        };
        let title = dialog.input.read(cx).text().trim().to_string();
        if !title.is_empty() {
            self.mutate(
                serde_json::json!({ "op": "renameChat", "chatId": dialog.chat_id, "title": title }),
                cx,
            );
        }
        cx.notify();
    }

    pub(super) fn archive_chat(&mut self, chat_id: String, cx: &mut Context<Self>) {
        self.chat_menu = None;
        self.mutate(
            serde_json::json!({ "op": "setChatArchived", "chatId": chat_id, "archived": true }),
            cx,
        );
        cx.notify();
    }

    pub(super) fn set_chat_settled(&mut self, chat_id: String, settled: bool, cx: &mut Context<Self>) {
        self.chat_menu = None;
        self.state.update(cx, |state, cx| {
            state.set_chat_settled(&chat_id, settled, cx)
        });
        cx.notify();
    }

    pub(super) fn delete_chat(&mut self, chat_id: String, cx: &mut Context<Self>) {
        self.delete_confirm = None;
        if self.state.read(cx).selected_chat.as_deref() == Some(chat_id.as_str()) {
            self.state.update(cx, |s, cx| s.select_chat(None, cx));
        }
        self.composer
            .update(cx, |composer, _| composer.purge_chat(&chat_id));
        self.mutate(
            serde_json::json!({ "op": "deleteChat", "chatId": chat_id }),
            cx,
        );
        cx.notify();
    }

    pub(super) fn sign_out(&mut self, cx: &mut Context<Self>) {
        self.user_menu_open = false;
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        self.auth_task = Some(cx.spawn(async move |this, cx| {
            if let Err(err) = engine
                .client()
                .call(methods::SIGN_OUT, serde_json::json!({}))
                .await
            {
                this.update(cx, |shell, cx| {
                    shell.sidebar_notice = Some(format!("Sign out failed: {err}").into());
                    cx.notify();
                })
                .ok();
            }
        }));
        cx.notify();
    }

    pub(super) fn start_sign_in(&mut self, cx: &mut Context<Self>) {
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        self.auth_task = Some(cx.spawn(async move |this, cx| {
            let result = engine
                .client()
                .call(methods::SIGN_IN, serde_json::json!({}))
                .await;
            this.update(cx, |shell, cx| match result {
                Ok(value) => {
                    if let Some(url) = value.get("url").and_then(|u| u.as_str()) {
                        cx.open_url(url);
                    }
                }
                Err(err) => {
                    shell.sidebar_notice = Some(format!("Sign in failed: {err}").into());
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    // ---- org gate ----

    pub(super) fn ensure_org_ui(&mut self, cx: &mut Context<Self>) {
        if self.org.is_some() {
            return;
        }
        let name_input = cx.new(|cx| ComposerInput::new("Workspace name", cx));
        let events = cx.subscribe(&name_input, |this: &mut Shell, _, event, cx| {
            if matches!(event, ComposerInputEvent::Submitted) {
                this.create_org(cx);
            }
        });
        self.org = Some(OrgGateUi {
            name_input,
            orgs: Loadable::Idle,
            submitting: false,
            error: None,
            task: None,
            _events: events,
        });
        self.load_orgs(cx);
    }

    pub(super) fn load_orgs(&mut self, cx: &mut Context<Self>) {
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        let Some(org) = self.org.as_mut() else { return };
        org.orgs = Loadable::Loading;
        org.task = Some(cx.spawn(async move |this, cx| {
            let result = engine
                .client()
                .call(methods::LIST_ORGS, serde_json::json!({}))
                .await;
            this.update(cx, |shell, cx| {
                if let Some(org) = shell.org.as_mut() {
                    org.orgs = match result {
                        Ok(value) => Loadable::Ready(sort_memberships(parse_orgs(&value))),
                        Err(err) => Loadable::Error(err.to_string()),
                    };
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    pub(super) fn create_org(&mut self, cx: &mut Context<Self>) {
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        let Some(org) = self.org.as_mut() else { return };
        if org.submitting {
            return;
        }
        let name = org.name_input.read(cx).text().trim().to_string();
        if !org_name_valid(&name) {
            org.error = Some("Enter a workspace name".into());
            cx.notify();
            return;
        }
        org.submitting = true;
        org.error = None;
        org.task = Some(cx.spawn(async move |this, cx| {
            let result = engine
                .client()
                .call(methods::CREATE_ORG, serde_json::json!({ "name": name }))
                .await;
            this.update(cx, |shell, cx| {
                if let Some(org) = shell.org.as_mut() {
                    org.submitting = false;
                    if let Err(err) = result {
                        org.error = Some(format!("{err}").into());
                    }
                    // Success: the AuthStatus stream flips to SignedIn and the
                    // gate falls away on its own.
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    pub(super) fn select_org(&mut self, organization_id: String, cx: &mut Context<Self>) {
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        let Some(org) = self.org.as_mut() else { return };
        org.submitting = true;
        org.error = None;
        org.task = Some(cx.spawn(async move |this, cx| {
            let result = engine
                .client()
                .call(
                    methods::SELECT_ORG,
                    serde_json::json!({ "organizationId": organization_id }),
                )
                .await;
            this.update(cx, |shell, cx| {
                if let Some(org) = shell.org.as_mut() {
                    org.submitting = false;
                    if let Err(err) = result {
                        org.error = Some(format!("{err}").into());
                    }
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    // ---- render pieces ----

    /// Evaluate a width tween at "now" (manual drive — see [`WidthTween`]).
    /// Mid-flight: eased 200ms lerp, and `motion_active` is flagged so render
    /// schedules the next animation frame. Finished, stale, absent, or under
    /// reduced motion: exactly `target`. Honors `COMET_MOTION_SCALE`.
    pub(super) fn eval_tween(&self, tween: Option<WidthTween>, target: f32) -> f32 {
        let Some(WidthTween { from, to, started }) = tween else {
            return target;
        };
        if self.reduced_motion {
            return target;
        }
        let total = RESIZE.total().mul_f32(motion::speed_scale());
        let raw = started.elapsed().as_secs_f32() / total.as_secs_f32();
        if raw >= 1.0 {
            return target;
        }
        self.motion_active.set(true);
        motion::lerp(from, to, RESIZE.progress(raw))
    }

    /// Animated width container: tweens 200ms ease-out on collapse/expand, and
    /// clips a fixed-width inner so content never reflows mid-transition.
    pub(super) fn pane_container(
        &self,
        tween: Option<WidthTween>,
        target: f32,
        inner: AnyElement,
    ) -> AnyElement {
        div()
            .h_full()
            .flex_none()
            .overflow_hidden()
            .w(px(self.eval_tween(tween, target)))
            .child(inner)
            .into_any_element()
    }

    /// The animated spacer clearing the macOS traffic lights ahead of a
    /// titlebar control cluster. Fullscreen toggles tween the cluster start
    /// over 200ms ease-out ([`RESIZE`]; reduced motion snaps).
    /// `None` off macOS — no phantom flex child.
    pub(super) fn titlebar_spacer(&self, container_pad: f32) -> Option<AnyElement> {
        if !cfg!(target_os = "macos") {
            return None;
        }
        let fullscreen = self.fullscreen.unwrap_or(false);
        // The tween runs in cluster-start coordinates; the spacer is that
        // minus the container's own padding.
        let start = self.eval_tween(self.titlebar_tween, titlebar_cluster_start(fullscreen));
        let width = (start - container_pad).max(0.0);
        Some(div().flex_none().h_full().w(px(width)).into_any_element())
    }

    /// The header's content row with the animated left inset — the native port
    /// of comet __root.tsx `transition-[padding-left] duration-200 ease-out` +
    /// `style={{ paddingLeft: headerInset }}`: on sidebar toggles (and macOS
    /// fullscreen flips) the SAME element's padding tweens, so the title
    /// glides to its new x-position. Route changes SNAP: the tween is killed
    /// by every route transition (comet remounts the keyed header variants —
    /// instant swap, zero horizontal motion).
    /// Where unified-titlebar content (tabs / the settings label) starts: past
    /// the traffic lights + control cluster, riding the fullscreen inset tween.
    pub(super) fn title_bar_content_start(&self) -> f32 {
        let fullscreen = self.fullscreen.unwrap_or(false);
        let is_macos = cfg!(target_os = "macos");
        let cluster = self.eval_tween(
            self.titlebar_tween,
            cluster_buttons_start(is_macos, fullscreen),
        );
        cluster + CLUSTER_BUTTONS_WIDTH + 10.0
    }

    /// The unified window titlebar: chat → the session tab strip; settings →
    /// the section label. Full-width on the glass shell; the traffic lights
    /// and control cluster overlay its left end.
    pub(super) fn render_title_bar(&mut self, cx: &mut Context<Self>) -> AnyElement {
        match self.route {
            Route::Chat => self.render_session_tab_strip(cx),
            Route::Settings(_) => {
                let inner = div()
                    .size_full()
                    .flex()
                    .items_center()
                    .pt(px(Theme::TITLEBAR_TOP_PAD))
                    .pl(px(self.title_bar_content_start()))
                    .pr(px(Theme::SPACE_LG));
                let bar = div().h(px(Theme::TITLEBAR_HEIGHT)).flex_none().child(inner);
                self.titlebar_drag_region("settings-header-titlebar", bar, cx)
                    .into_any_element()
            }
        }
    }

    /// Make a titlebar strip drag the window — zed's platform-titlebar
    /// pattern (comet's `.drag` region): mark it a [`WindowControlArea::Drag`]
    /// (macOS app-owned titlebar), hand the drag to the compositor once the
    /// pointer moves with the button down, and double-click zooms.
    pub(super) fn titlebar_drag_region(
        &self,
        id: &'static str,
        el: gpui::Div,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        el.id(id)
            .window_control_area(WindowControlArea::Drag)
            .on_mouse_down_out(cx.listener(|this, _, _, _| this.titlebar_should_move = false))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _, _| this.titlebar_should_move = false),
            )
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, _| this.titlebar_should_move = true),
            )
            // Hand the drag to the compositor only while the button is
            // actually held (`pressed_button` guard): on macOS
            // `start_window_move` runs AppKit's NATIVE drag session
            // (`performWindowDragWithEvent:`), and AppKit resolves a quick
            // second click inside that session as a titlebar double-click —
            // system zoom — natively, beyond gpui's reach. Without the guard a
            // stale `titlebar_should_move` (armed by a down whose bubble was
            // later stopped) would start that session from a mere hover move
            // between the two clicks of a double-click.
            .on_mouse_move(
                cx.listener(|this, event: &gpui::MouseMoveEvent, window, _| {
                    if this.titlebar_should_move && event.pressed_button == Some(MouseButton::Left)
                    {
                        this.titlebar_should_move = false;
                        window.start_window_move();
                    }
                }),
            )
            .on_click(|event, window, _| {
                if event.click_count() == 2 {
                    if cfg!(target_os = "macos") {
                        // Native titlebar double-click action (zoom/minimize
                        // per system preference).
                        window.titlebar_double_click();
                    } else {
                        window.zoom_window();
                    }
                }
            })
    }

    /// The ONE top-left window-control cluster (sidebar toggle + back/forward —
    /// comet window-controls.tsx): rendered once, in a paint-only overlay layer
    /// pinned at the window's top-left, ABOVE the sidebar and headers. The
    /// sidebar width animates *beneath* it, so the buttons keep their element
    /// identity and never move or remount on collapse/expand; only the
    /// fullscreen traffic-light inset tweens (the animated spacer). The
    /// container has no id/listeners — everything between the buttons falls
    /// through to the titlebar drag strips below.
    pub(super) fn render_titlebar_cluster(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(cx).clone();
        let can_back = self.nav.can_back();
        let can_forward = self.nav.can_forward();
        div()
            .absolute()
            .top_0()
            .left_0()
            .h(px(Theme::TITLEBAR_HEIGHT))
            .flex()
            .flex_row()
            .items_center()
            .pt(px(Theme::TITLEBAR_TOP_PAD))
            .gap(px(2.0))
            .px(px(10.0))
            .children(self.titlebar_spacer(12.0))
            .child(window_control_button(
                "toggle-sidebar",
                icons::SIDEBAR_MINIMALISTIC_LEFT,
                &theme,
                cx.listener(|this, _, _, cx| this.toggle_sidebar(cx)),
            ))
            .child(nav_history_button(
                "nav-back",
                icons::ARROW_LEFT,
                can_back,
                &theme,
                cx.listener(|this, _, _, cx| this.navigate_back(cx)),
            ))
            .child(nav_history_button(
                "nav-forward",
                icons::ARROW_RIGHT,
                can_forward,
                &theme,
                cx.listener(|this, _, _, cx| this.navigate_forward(cx)),
            ))
            .into_any_element()
    }

    pub(super) fn render_sidebar(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(cx).clone();
        let inner: AnyElement = match self.route {
            Route::Settings(section) => self.render_settings_nav(section, &theme, cx),
            Route::Chat => self.render_chat_sidebar(&theme, cx),
        };
        let target = self.sidebar_target();
        // Transparent — the sidebar sits directly on the frost shell; the main
        // card's own border provides the separation.
        self.pane_container(
            self.sidebar_tween,
            target,
            div().h_full().child(inner).into_any_element(),
        )
    }

}

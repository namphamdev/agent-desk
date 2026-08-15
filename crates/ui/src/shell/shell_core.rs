use std::time::Duration;

use chrono::Utc;
use gpui::{
    App, Context, Entity, Focusable as _, Window, prelude::*,
};


use crate::changes::Changes;
use crate::composer::{Composer, ComposerEvent};
use crate::motion::{self, RESIZE, SPLASH_OUT};
use crate::settings::{
    RIGHT_PANE_MAX, RIGHT_PANE_MIN, SAVE_DEBOUNCE_MS, SIDEBAR_MAX, SIDEBAR_MIN, UiSettings,
};
use crate::state::{
    AppState, ConnectionStatus, EngineBootConfig, GatePhase, Indicator,
};
use crate::terminal::panel::{TerminalPanel, clamp_terminal_height};
use crate::transcript::{Transcript, TranscriptEvent};

use super::layout::{
    apply_keymap, Route, SessionPanels, SettingsSection,
};
use super::nav::{
    NavEntry, NavHistory, WidthTween, SplashPhase, UpdateFlow,
    SyncedShortcuts, SidebarResize, RightPaneResize, TerminalResize,
};
use super::Shell;

impl Shell {
    pub fn new(state: Entity<AppState>, boot: EngineBootConfig, cx: &mut Context<Self>) -> Self {
        // Initialize the agent debug inspector global (zero-cost unless
        // feature_enabled: debug builds or COMET_INSPECTOR=1).
        crate::dev_inspector::init(cx);

        let observation = cx.observe(&state, |this: &mut Shell, state, cx| {
            this.on_state_changed(&state, cx);
            cx.notify();
        });
        let transcript = cx.new(|cx| Transcript::new(state.clone(), cx));
        let composer = cx.new(|cx| Composer::new(state.clone(), cx));
        // Own-send re-engages the stick-to-bottom pin with a smooth scroll.
        let composer_events = cx.subscribe(&composer, {
            let transcript = transcript.clone();
            move |_this: &mut Shell, _, event: &ComposerEvent, cx| match event {
                ComposerEvent::Sent { .. } => {
                    transcript.update(cx, |t, cx| t.on_own_send(cx));
                }
            }
        });
        let transcript_events = cx.subscribe(
            &transcript,
            |this: &mut Shell, _, event: &TranscriptEvent, cx| match event {
                TranscriptEvent::NewThread { text, role } => {
                    this.start_message_thread(text.clone(), *role, cx);
                }
            },
        );
        // Working-indicator heartbeat: notify once a second while a session is
        // live so elapsed time and the flavour word stay fresh.
        let ticker = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                let alive = this.update(cx, |shell: &mut Shell, cx| {
                    let live = {
                        let s = shell.state.read(cx);
                        s.selected_chat
                            .as_deref()
                            .is_some_and(|id| s.indicator_for(id, Utc::now()) != Indicator::None)
                    };
                    if live {
                        cx.notify();
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        });
        let data_dir = boot.data_dir.clone();
        let settings = UiSettings::load(&data_dir);
        // Bind the customizable shortcuts from the persisted keymap.
        apply_keymap(cx, &settings.keymap);
        // Dev/testing knob: `COMET_OPEN_ROUTE=settings[/<section>]` boots
        // straight into a settings section — these pages have no deep link and
        // synthetic input can't reach them on headless compositors.
        let route = match std::env::var("COMET_OPEN_ROUTE").ok().as_deref() {
            Some("settings") | Some("settings/devices") => {
                Route::Settings(SettingsSection::Devices)
            }
            Some("settings/agents") => Route::Settings(SettingsSection::Agents),
            Some("settings/providers") => Route::Settings(SettingsSection::Providers),
            Some("settings/acp") => Route::Settings(SettingsSection::AcpAgents),
            Some("settings/context") => Route::Settings(SettingsSection::ContextEngine),
            Some("settings/notifications") => Route::Settings(SettingsSection::Notifications),
            Some("settings/appearance") => Route::Settings(SettingsSection::Appearance),
            Some("settings/shortcuts") => Route::Settings(SettingsSection::Shortcuts),
            Some("settings/workflows") => Route::Settings(SettingsSection::Workflows),
            Some("settings/archived") => Route::Settings(SettingsSection::Archived),
            // `new` pins the new-chat canvas (suppresses boot auto-select).
            Some("new") => {
                state.update(cx, |s, _| s.auto_selected = true);
                Route::Chat
            }
            _ => Route::Chat,
        };
        // More capture knobs of the same kind: `COMET_OPEN_DIALOG=rename|delete`
        // opens that dialog for the first chat once chats land; `=model` pops
        // the combined harness/model menu once the shell is Ready;
        // `COMET_FORCE_GATE=signin|org|failed` renders that gate regardless of
        // real auth state (display-only — for styling passes).
        let debug_dialog = std::env::var("COMET_OPEN_DIALOG").ok();
        let debug_gate = match std::env::var("COMET_FORCE_GATE").ok().as_deref() {
            Some("signin") => Some(GatePhase::SignIn),
            Some("org") => Some(GatePhase::OrgGate),
            Some("failed") => Some(GatePhase::Failed(
                "Could not reach the comet engine on port 27901".into(),
            )),
            _ => None,
        };
        let nav = NavHistory::new(match route {
            Route::Chat => NavEntry::Chat(String::new()),
            Route::Settings(section) => NavEntry::Settings(section),
        });
        Self {
            state,
            transcript,
            composer,
            file_drag_active: false,
            terminal: None,
            changes: None,
            route,
            activity_open: false,
            activity_done_open: false,
            nav,
            devices_page: None,
            archived_page: None,
            workflows_page: None,
            appearance_page: None,
            shortcuts_page: None,
            accounts_page: None,
            providers_page: None,
            providers_sub: None,
            acp_agents_page: None,
            context_engine_page: None,
            notifications_page: None,
            notifications_sub: None,
            shortcuts_sub: None,
            shortcuts_sync_loaded: false,
            workflows_sub: None,
            chat_menu: None,
            rename_dialog: None,
            delete_confirm: None,
            space_menu: None,
            rename_space_dialog: None,
            project_harness: None,
            delete_space_confirm: None,
            add_space: None,
            space_last_chat: std::collections::HashMap::new(),
            tab_hover: None,
            space_drag: None,
            tabs_scroll: gpui::ScrollHandle::new(),
            tabs_scrolled_to: None,
            sidebar_scroll: gpui::ScrollHandle::new(),
            sidebar_chat_scroll: gpui::UniformListScrollHandle::new(),
            sidebar_row_data: Vec::new(),
            sidebar_chat_map: std::collections::HashMap::new(),
            sidebar_tree: Vec::new(),
            sidebar_expanded_spaces: std::collections::HashSet::new(),
            sidebar_space_show_all: std::collections::HashSet::new(),
            sidebar_space_scroll: std::collections::HashMap::new(),
            sidebar_tree_scrolled_to: None,
            space_boot_applied: false,
            sound_prev: std::collections::HashMap::new(),
            user_menu_open: false,
            user_menu_dismissed_at: None,
            sidebar_notice: None,
            update_flow: UpdateFlow::Idle,
            update_task: None,
            update_dismissed: None,
            install: comet_update::detect_install(),
            org: None,
            mutate_task: None,
            auth_task: None,
            boot,
            data_dir,
            settings,
            panels: SessionPanels::default(),
            active_chat: String::new(),
            sidebar_prev_order: Vec::new(),
            sidebar_resort: std::collections::HashMap::new(),
            sidebar_new_keys: std::collections::HashSet::new(),
            resort_epoch: 0,
            debug_dialog,
            debug_gate,
            sidebar_tween: None,
            right_tween: None,
            terminal_tween: None,
            fullscreen: None,
            titlebar_tween: None,
            titlebar_should_move: false,
            terminal_tween_task: None,
            terminal_drag_anchor: None,
            reduced_motion: false,
            motion_active: std::cell::Cell::new(false),
            splash: SplashPhase::Visible,
            splash_task: None,
            save_task: None,
            focus_sub: None,
            _ticker: ticker,
            _state_observation: observation,
            _composer_events: composer_events,
            _transcript_events: transcript_events,
        }
    }

    pub(super) fn start_message_thread(
        &mut self,
        text: String,
        role: comet_doc::MessageRole,
        cx: &mut Context<Self>,
    ) {
        let Some(source) = self.state.read(cx).selected_chat_row().cloned() else {
            return;
        };
        let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
        let title: String = one_line.chars().take(60).collect();
        self.composer.update(cx, |composer, cx| {
            composer.start_thread(source, text, role, "continue", title, None, cx);
        });
    }

    pub(super) fn start_review_thread(&mut self, cx: &mut Context<Self>) {
        let (source, entries, project) = {
            let state = self.state.read(cx);
            let Some(source) = state.selected_chat_row().cloned() else {
                return;
            };
            let project = state
                .space_for_chat(&source)
                .map(|space| space.display_name().to_string());
            (source, state.transcript.clone(), project)
        };
        let summary = comet_engine::session_summary::summarize_session_changes(
            &entries,
            source.title.as_deref(),
            project.as_deref(),
        );
        if !summary.has_reviewable_content {
            return;
        }
        let title =
            comet_engine::session_summary::review_session_title(source.title.as_deref(), 56);
        self.composer.update(cx, |composer, cx| {
            composer.start_thread(
                source,
                summary.text,
                comet_doc::MessageRole::Assistant,
                "review",
                title,
                Some(comet_engine::session_summary::DEFAULT_REVIEW_PROMPT.to_string()),
                cx,
            );
        });
    }

    // ---- splash ----

    pub(super) fn on_state_changed(&mut self, state: &Entity<AppState>, cx: &mut Context<Self>) {
        if !self.shortcuts_sync_loaded
            && let Some(engine) = state.read(cx).engine().cloned()
        {
            self.shortcuts_sync_loaded = true;
            self.load_synced_shortcuts(
                engine,
                SyncedShortcuts {
                    keymap: self.settings.keymap.clone(),
                    ai_shortcuts: self.settings.ai_shortcuts.clone(),
                },
                cx,
            );
        }
        // Capture knob: the add-space palette needs only the device registry.
        if self.debug_dialog.as_deref() == Some("add-space") && !state.read(cx).devices.is_empty() {
            self.debug_dialog = None;
            self.open_add_space(cx);
        }
        // Capture knob: pop the requested dialog once chats have landed.
        if let Some(which) = self.debug_dialog.clone()
            && let Some(first) = state.read(cx).chats.first().map(|c| c.id.clone())
        {
            self.debug_dialog = None;
            match which.as_str() {
                "rename" => self.open_rename_chat(first, cx),
                "delete" => {
                    self.delete_confirm = Some(first);
                }
                _ => {}
            }
        }
        // Session chimes (herdr semantics, `sound::sound_for_transition`): a
        // question rings whenever a session flips to AwaitingInput, a
        // completion rings on the Working→Idle edge — for ANY session on any
        // device. A row's first appearance only seeds the baseline, so boot
        // (restored rows) and fresh sends stay silent.
        //
        // STALENESS-GATED like the dot (`effective_indicator`), for the same
        // reason: raw row statuses include the past. A dead turn's Working row
        // (host killed mid-run, Idle write lost to a wedged room) seeded
        // prev=Working here, and the moment the old Idle finally synced in —
        // typically piggybacked on the round-trip of a fresh send — the chime
        // heard a phantom Working→Idle and rang "done" on send (user report
        // 2026-07-31). The dot never showed that ghost; the chime must judge
        // by the identical clock.
        {
            let now = Utc::now();
            let sessions: Vec<(String, comet_proto::SessionStatus)> = state
                .read(cx)
                .sessions
                .iter()
                .map(|s| {
                    use comet_proto::view::Indicator;
                    let status = match comet_proto::view::effective_indicator(Some(s), now) {
                        Indicator::Working => comet_proto::SessionStatus::Working,
                        Indicator::AwaitingInput => comet_proto::SessionStatus::AwaitingInput,
                        Indicator::Errored => comet_proto::SessionStatus::Errored,
                        Indicator::None => comet_proto::SessionStatus::Idle,
                    };
                    (s.chat_id.clone(), status)
                })
                .collect();
            for (chat_id, status) in sessions {
                let prev = self.sound_prev.insert(chat_id.clone(), status);
                if let Some(prev) = prev
                    && let Some(sound) = crate::sound::sound_for_transition(prev, status)
                {
                    // Notification chime (done / awaiting-input).
                    if self.settings.sound_enabled {
                        crate::sound::play(sound);
                    }
                    // OS desktop notification on the same transitions. The
                    // chat id rides along so a click can deep-link back to the
                    // exact session that finished / asked for input.
                    if self.settings.notifications_enabled {
                        let kind = match sound {
                            crate::sound::Sound::Done => crate::notify::NotificationKind::Done,
                            crate::sound::Sound::Request => {
                                crate::notify::NotificationKind::Request
                            }
                        };
                        crate::notify::show(cx, kind, &chat_id);
                    }
                }
            }
        }
        // Boot: restore the last selected space once the first spaces frame
        // lands (a still-existing row wins over the auto-selected first one;
        // the boot-auto-selected chat's own space wins over both — selecting a
        // chat implies its space, which `select_chat` already applied).
        if !self.space_boot_applied && !state.read(cx).spaces.is_empty() {
            self.space_boot_applied = true;
            if state.read(cx).selected_chat.is_none()
                && let Some(last) = self.settings.last_space_id.clone()
                && state.read(cx).space_row(&last).is_some()
            {
                state.update(cx, |s, cx| s.select_space(Some(last), cx));
            }
        }
        // Track the per-space last chat + persist the selected space.
        {
            let (selected_space, selected_chat, chat_space) = {
                let s = state.read(cx);
                let chat_space = s.selected_chat_row().and_then(|c| c.space_id.clone());
                (
                    s.selected_space.clone(),
                    s.selected_chat.clone(),
                    chat_space,
                )
            };
            if let (Some(space), Some(chat)) = (chat_space, selected_chat) {
                self.space_last_chat.insert(space, chat);
            }
            if selected_space != self.settings.last_space_id && selected_space.is_some() {
                self.settings.last_space_id = selected_space;
                self.schedule_save(cx);
            }
        }
        // Sidebar tree: the active space is always expanded — selecting a
        // space (or a chat, which implies its space) auto-expands it so the
        // user always sees the sessions of the space they're working in.
        // Idempotent + no notify: this rides the state change's own frame.
        self.ensure_active_space_expanded(cx);
        // Chat switch: restore THAT chat's panel state (per-session open flags;
        // snap, no tween — the panels belong to the destination chat).
        let selected = state.read(cx).selected_chat.clone().unwrap_or_default();
        if selected != self.active_chat {
            self.active_chat = selected;
            // Route history: a chat switch is a navigation. The very first
            // selection off the untouched boot canvas REPLACES that entry —
            // comet's `/` route redirected into the last-used chat, leaving no
            // dead Back target. Walking history lands here too, but the
            // destination already equals `current()`, so the push dedups.
            if matches!(self.route, Route::Chat) {
                let entry = NavEntry::Chat(self.active_chat.clone());
                if self.nav.len() == 1 && *self.nav.current() == NavEntry::Chat(String::new()) {
                    self.nav.replace(entry);
                } else {
                    self.nav.push(entry);
                }
            }
            self.right_tween = None;
            self.terminal_tween = None;
            let panels = self.panels.get(&self.panel_key(cx));
            if let Some(panel) = self.terminal.clone() {
                panel.update(cx, |panel, cx| panel.set_open(panels.terminal_open, cx));
            }
            if panels.changes_open {
                let changes = self.changes_pane(cx);
                changes.update(cx, |changes, cx| changes.ensure_watch(cx));
            }
        }
        match state.read(cx).connection {
            ConnectionStatus::Ready => {
                if self.splash == SplashPhase::Visible {
                    self.splash = SplashPhase::FadingOut;
                    self.splash_task = Some(cx.spawn(async move |this, cx| {
                        cx.background_executor()
                            .timer(SPLASH_OUT.total() + Duration::from_millis(30))
                            .await;
                        this.update(cx, |shell, cx| {
                            shell.splash = SplashPhase::Gone;
                            cx.notify();
                        })
                        .ok();
                    }));
                }
            }
            // Reveal the gate card immediately; the splash never returns mid-session.
            ConnectionStatus::Failed(_) => self.splash = SplashPhase::Gone,
            ConnectionStatus::Connecting => {}
        }
    }

    pub(super) fn load_synced_shortcuts(
        &mut self,
        engine: crate::state::EngineHandle,
        local: SyncedShortcuts,
        cx: &mut Context<Self>,
    ) {
        self.mutate_task = Some(cx.spawn(async move |this, cx| {
            let Ok(value) = engine
                .client()
                .call(
                    comet_rpc::methods::GET_SYNCED_SHORTCUTS,
                    serde_json::json!({}),
                )
                .await
            else {
                return;
            };
            if value.is_null() {
                if let Err(error) = engine
                    .client()
                    .call(
                        comet_rpc::methods::SET_SYNCED_SHORTCUTS,
                        serde_json::json!({ "shortcuts": local }),
                    )
                    .await
                {
                    tracing::warn!(%error, "failed to initialize synced shortcut settings");
                }
                return;
            }
            let Ok(settings) = serde_json::from_value::<SyncedShortcuts>(value) else {
                tracing::warn!("invalid synced shortcut settings");
                return;
            };
            let _ = this.update(cx, |shell, cx| {
                shell.settings.keymap = settings.keymap;
                shell.settings.ai_shortcuts = settings.ai_shortcuts;
                apply_keymap(cx, &shell.settings.keymap);
                if let Some(runtime) = cx
                    .try_global::<crate::global_shortcuts::GlobalShortcutRuntimeHandle>()
                    .map(|runtime| runtime.0.clone())
                {
                    let shortcuts = shell.settings.ai_shortcuts.clone();
                    runtime.update(cx, |runtime, cx| runtime.configure(shortcuts, cx));
                }
                shell.schedule_save(cx);
                cx.notify();
            });
        }));
    }

    pub(super) fn sync_shortcuts(&mut self, cx: &mut Context<Self>) {
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        let shortcuts = SyncedShortcuts {
            keymap: self.settings.keymap.clone(),
            ai_shortcuts: self.settings.ai_shortcuts.clone(),
        };
        self.mutate_task = Some(cx.spawn(async move |_this, _cx| {
            if let Err(error) = engine
                .client()
                .call(
                    comet_rpc::methods::SET_SYNCED_SHORTCUTS,
                    serde_json::json!({ "shortcuts": shortcuts }),
                )
                .await
            {
                tracing::warn!(%error, "failed to sync shortcut settings");
            }
        }));
    }

    // ---- layout state ----

    pub(super) fn sidebar_target(&self) -> f32 {
        if self.settings.sidebar_collapsed {
            0.0
        } else {
            self.settings.sidebar_width
        }
    }

    /// Does the selected space's folder have git? Owner-stamped and synced —
    /// gates the Changes pane, its toggle, and Cmd-B with zero RPCs.
    pub(super) fn space_git_detected(&self, cx: &App) -> bool {
        self.state.read(cx).selected_space_git()
    }

    /// The current chat's changes-pane flag (per-session, in-memory), gated on
    /// the space having git at all: a stale per-chat open flag must not reopen
    /// the pane after switching into a non-git space.
    /// The per-session panel key. The new-chat canvas (no selection) keys per
    /// SPACE — one shared "" key made a canvas toggle read as global state
    /// (user report).
    pub(super) fn panel_key(&self, cx: &App) -> String {
        if self.active_chat.is_empty() {
            let space = self
                .state
                .read(cx)
                .selected_space
                .clone()
                .unwrap_or_default();
            format!("space-canvas:{space}")
        } else {
            self.active_chat.clone()
        }
    }

    pub(super) fn right_pane_open(&self, cx: &App) -> bool {
        self.panels.get(&self.panel_key(cx)).changes_open && self.space_git_detected(cx)
    }

    /// The current chat's terminal flag (per-session, in-memory).
    pub(super) fn terminal_open(&self, cx: &App) -> bool {
        self.panels.get(&self.panel_key(cx)).terminal_open
    }

    pub(super) fn right_target(&self, cx: &App) -> f32 {
        if self.right_pane_open(cx) {
            self.settings.right_pane_width
        } else {
            0.0
        }
    }

    pub(super) fn toggle_sidebar(&mut self, cx: &mut Context<Self>) {
        let from = self.sidebar_target();
        self.settings.sidebar_collapsed = !self.settings.sidebar_collapsed;
        self.sidebar_tween = Some(WidthTween::new(from, self.sidebar_target()));
        self.schedule_save(cx);
        cx.notify();
    }

    pub(super) fn toggle_right_pane(&mut self, cx: &mut Context<Self>) {
        // No git in this space → no diff pane, Cmd-B goes dead.
        if !self.space_git_detected(cx) {
            return;
        }
        let from = self.right_target(cx);
        let key = self.panel_key(cx);
        let open = self.panels.toggle_changes(&key);
        self.right_tween = Some(WidthTween::new(from, self.right_target(cx)));
        if open {
            // Lazy: the Changes entity (and its WatchCheckoutDiffs) exists only
            // once the pane has been opened.
            let changes = self.changes_pane(cx);
            changes.update(cx, |changes, cx| changes.ensure_watch(cx));
        }
        cx.notify();
    }

    pub(super) fn changes_pane(&mut self, cx: &mut Context<Self>) -> Entity<Changes> {
        if let Some(changes) = &self.changes {
            return changes.clone();
        }
        let changes = cx.new(|cx| Changes::new(self.state.clone(), cx));
        self.changes = Some(changes.clone());
        changes
    }

    pub(super) fn terminal_panel(&mut self, cx: &mut Context<Self>) -> Entity<TerminalPanel> {
        if let Some(terminal) = &self.terminal {
            return terminal.clone();
        }
        let terminal = cx.new(|cx| TerminalPanel::new(self.state.clone(), cx));
        self.terminal = Some(terminal.clone());
        terminal
    }

    pub(super) fn terminal_target(&self, cx: &App) -> f32 {
        if self.terminal_open(cx) {
            self.settings.terminal_height
        } else {
            0.0
        }
    }

    /// Cmd/Ctrl+J and the header button (feature-inventory §1.10). Height
    /// animates 200 ms; closing detaches (PTYs stay alive), opening restores.
    /// The flag is per chat (comet `sessionPanels`).
    pub(super) fn toggle_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let from = self.terminal_target(cx);
        let key = self.panel_key(cx);
        let open = self.panels.toggle_terminal(&key);
        self.terminal_tween = Some(WidthTween::new(from, self.terminal_target(cx)));
        let panel = self.terminal_panel(cx);
        panel.update(cx, |panel, cx| panel.set_open(open, cx));
        if open {
            // Opening lands keyboard focus IN the shell — typing goes straight
            // to the prompt, no click needed (comet terminal-panel.tsx: the
            // visible+active effect calls `terminal.focus()` on every open).
            // The handle is focusable before the panel's first paint; once the
            // terminal body mounts with `track_focus` it receives the keys.
            window.focus(&panel.read(cx).focus_handle(), cx);
        } else {
            // Hiding the panel removes the (likely focused) terminal view;
            // with nothing focused, window key bindings stop dispatching, so
            // hand focus to the composer. (Cmd+J is a pure toggle — a second
            // press closes even while the terminal is focused, as in comet's
            // `useHotkey(toggleShortcut, ... setOpenScoped(!open))`.)
            window.focus(&self.composer.focus_handle(cx), cx);
        }
        self.terminal_tween_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(RESIZE.total().mul_f32(motion::speed_scale()) + Duration::from_millis(30))
                .await;
            this.update(cx, |shell, cx| {
                shell.terminal_tween = None;
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    pub(super) fn on_terminal_drag(
        &mut self,
        event: &gpui::DragMoveEvent<TerminalResize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((anchor_y, anchor_h)) = self.terminal_drag_anchor else {
            return;
        };
        let dy = anchor_y - f32::from(event.event.position.y);
        let viewport_h = f32::from(window.viewport_size().height);
        self.settings.terminal_height = clamp_terminal_height(anchor_h + dy, viewport_h);
        self.terminal_tween = None; // live drag tracks the pointer
        self.schedule_save(cx);
        cx.notify();
    }

    pub(super) fn on_sidebar_drag(
        &mut self,
        event: &gpui::DragMoveEvent<SidebarResize>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let x = f32::from(event.event.position.x);
        self.settings.sidebar_width = x.clamp(SIDEBAR_MIN, SIDEBAR_MAX);
        self.settings.sidebar_collapsed = false;
        self.sidebar_tween = None; // live drag tracks the pointer directly
        self.schedule_save(cx);
        cx.notify();
    }

    pub(super) fn on_right_pane_drag(
        &mut self,
        event: &gpui::DragMoveEvent<RightPaneResize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let viewport = f32::from(window.viewport_size().width);
        let width = viewport - f32::from(event.event.position.x);
        // comet caps the pane at 52% of the window on top of the absolute range.
        let max = RIGHT_PANE_MAX.min(viewport * 0.52);
        self.settings.right_pane_width = width.clamp(RIGHT_PANE_MIN, max.max(RIGHT_PANE_MIN));
        self.right_tween = None;
        self.schedule_save(cx);
        cx.notify();
    }

    /// Debounced settings write: waits [`SAVE_DEBOUNCE_MS`], then persists the
    /// latest snapshot on the background executor. Re-scheduling drops (cancels)
    /// the previous timer.
    pub(super) fn schedule_save(&mut self, cx: &mut Context<Self>) {
        let dir = self.data_dir.clone();
        self.save_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(SAVE_DEBOUNCE_MS))
                .await;
            // Re-stamp the appearance from the global before writing. The View
            // menu changes it through `appearance::set_mode`, which never touches
            // this shell's in-memory copy — without this, the next pane resize
            // would quietly write the boot-time appearance back over the user's
            // choice.
            let Ok(snapshot) = this.update(cx, |shell, cx| {
                shell.settings.appearance = crate::appearance::mode(cx);
                shell.settings.clone()
            }) else {
                return;
            };
            cx.background_executor()
                .spawn(async move {
                    if let Err(err) = snapshot.save(&dir) {
                        tracing::warn!(error = %err, "failed to persist ui settings");
                    }
                })
                .await;
        }));
    }

    pub(super) fn retry_engine(&mut self, cx: &mut Context<Self>) {
        AppState::bootstrap(self.state.clone(), self.boot.clone(), cx);
    }

    // ---- routes / settings ----


}

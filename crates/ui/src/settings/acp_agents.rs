use comet_proto::{
    AcpAgentsSnapshot, AcpRegistryAgent, AuthState, HarnessHealth, HarnessId, InstalledAcpAgent,
};
use comet_rpc::methods;
use gpui::{
    AnyElement, Context, Entity, SharedString, Subscription, Task, Window, div, prelude::*, px,
};

use crate::composer::{ComposerInput, ComposerInputEvent};
use crate::popover::{self, Loadable};
use crate::settings::widgets;
use crate::state::AppState;
use crate::theme::{Theme, white_alpha};

pub struct AcpAgentsPage {
    state: Entity<AppState>,
    snapshot: Loadable<AcpAgentsSnapshot>,
    harness_health: Loadable<Vec<HarnessHealth>>,
    busy_agent: Option<String>,
    installing_harness: Option<HarnessId>,
    error: Option<SharedString>,
    editor: Option<CustomAgentEditor>,
    /// Whether we were signed in the last time we rendered. Used to detect the
    /// sign-out → sign-in transition so we can reload after re-auth.
    was_signed_in: bool,
    load_task: Option<Task<()>>,
    action_task: Option<Task<()>>,
    _observe: Subscription,
}

struct CustomAgentEditor {
    /// `None` when adding a new agent; `Some(id)` when editing an existing
    /// custom agent in place (the id is preserved on save).
    agent_id: Option<String>,
    name: Entity<ComposerInput>,
    command: Entity<ComposerInput>,
    logo: Entity<ComposerInput>,
    _inputs: Vec<Subscription>,
}

impl AcpAgentsPage {
    pub fn new(state: Entity<AppState>, cx: &mut Context<Self>) -> Self {
        let observe = cx.observe(&state, |_, _, cx| cx.notify());
        let was_signed_in = matches!(
            state.read(cx).auth.as_ref(),
            Some(AuthState::SignedIn { .. })
        );
        let mut page = Self {
            state,
            snapshot: Loadable::Idle,
            harness_health: Loadable::Idle,
            busy_agent: None,
            installing_harness: None,
            error: None,
            editor: None,
            was_signed_in,
            load_task: None,
            action_task: None,
            _observe: observe,
        };
        page.load(cx);
        page
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            self.snapshot = Loadable::Error("Engine not connected".into());
            self.harness_health = Loadable::Error("Engine not connected".into());
            return;
        };
        self.snapshot = Loadable::Loading;
        self.harness_health = Loadable::Loading;
        self.load_task = Some(cx.spawn(async move |this, cx| {
            let (acp_result, health_result) = futures::future::join(
                engine
                    .client()
                    .call(methods::LIST_ACP_AGENTS, serde_json::json!({})),
                engine
                    .client()
                    .call(methods::CHECK_HARNESS_HEALTH, serde_json::json!({})),
            )
            .await;
            this.update(cx, |page, cx| {
                page.snapshot = decode_snapshot(acp_result);
                page.harness_health = decode_health(health_result);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn action(&mut self, method: &'static str, agent_id: String, cx: &mut Context<Self>) {
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        self.busy_agent = Some(agent_id.clone());
        self.error = None;
        self.action_task = Some(cx.spawn(async move |this, cx| {
            let result = engine
                .client()
                .call(method, serde_json::json!({ "agentId": agent_id }))
                .await;
            this.update(cx, |page, cx| {
                page.busy_agent = None;
                match result {
                    Ok(value) => match serde_json::from_value::<AcpAgentsSnapshot>(value) {
                        Ok(snapshot) => page.snapshot = Loadable::Ready(snapshot),
                        Err(error) => page.error = Some(error.to_string().into()),
                    },
                    Err(error) => page.error = Some(error.to_string().into()),
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn install_harness(&mut self, id: HarnessId, cx: &mut Context<Self>) {
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        self.installing_harness = Some(id);
        self.error = None;
        self.action_task = Some(cx.spawn(async move |this, cx| {
            let result = engine
                .client()
                .call(
                    methods::INSTALL_HARNESS,
                    serde_json::json!({ "harness": id }),
                )
                .await;
            this.update(cx, |page, cx| {
                page.installing_harness = None;
                match result {
                    Ok(value) => {
                        if let Ok(install_result) =
                            serde_json::from_value::<comet_proto::HarnessInstallResult>(value)
                        {
                            if let Some(err) = install_result.error {
                                page.error = Some(err.into());
                            }
                        }
                        // Reload health regardless — even on error the state may have changed.
                        let engine = page.state.read(cx).engine().cloned();
                        if let Some(engine) = engine {
                            page.harness_health = Loadable::Loading;
                            page.load_task = Some(cx.spawn(async move |this, cx| {
                                let health_result = engine
                                    .client()
                                    .call(methods::CHECK_HARNESS_HEALTH, serde_json::json!({}))
                                    .await;
                                this.update(cx, |page, cx| {
                                    page.harness_health = decode_health(health_result);
                                    cx.notify();
                                })
                                .ok();
                            }));
                        }
                    }
                    Err(error) => page.error = Some(error.to_string().into()),
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Open the custom-agent editor. `agent = None` adds a new agent;
    /// `Some(agent)` edits an existing custom agent, pre-filling its fields.
    fn open_editor_for(
        &mut self,
        agent: Option<&InstalledAcpAgent>,
        cx: &mut Context<Self>,
    ) {
        let (agent_id, name, command, logo) = match agent {
            Some(agent) => (
                Some(agent.id.clone()),
                agent.name.clone(),
                agent.command.clone(),
                agent.icon.clone().unwrap_or_default(),
            ),
            None => (
                None,
                String::new(),
                String::new(),
                String::new(),
            ),
        };
        let name_input = cx.new(|cx| ComposerInput::new("My agent", cx));
        name_input.update(cx, |input, cx| {
            if !name.is_empty() {
                input.set_text(&name, cx);
            }
        });
        let command_input = cx.new(|cx| {
            ComposerInput::new("e.g. npx -y @my-org/my-agent or /usr/local/bin/agent", cx)
        });
        command_input.update(cx, |input, cx| {
            if !command.is_empty() {
                input.set_text(&command, cx);
            }
        });
        let logo_input = cx.new(|cx| ComposerInput::new("https://example.com/icon.svg (optional)", cx));
        logo_input.update(cx, |input, cx| {
            if !logo.is_empty() {
                input.set_text(&logo, cx);
            }
        });
        let _inputs = [&name_input, &command_input, &logo_input]
            .into_iter()
            .map(|input| {
                cx.subscribe(input, |_, _, event: &ComposerInputEvent, cx| {
                    if matches!(event, ComposerInputEvent::Edited) {
                        cx.notify();
                    }
                })
            })
            .collect();
        self.editor = Some(CustomAgentEditor {
            agent_id,
            name: name_input,
            command: command_input,
            logo: logo_input,
            _inputs,
        });
        self.error = None;
        cx.notify();
    }


    fn cancel_editor(&mut self, cx: &mut Context<Self>) {
        self.editor = None;
        self.error = None;
        cx.notify();
    }

    fn save_custom(&mut self, cx: &mut Context<Self>) {
        let Some(editor) = self.editor.as_ref() else {
            return;
        };
        let agent_id = editor.agent_id.clone();
        let name = editor.name.read(cx).text().trim().to_string();
        let command = editor.command.read(cx).text().trim().to_string();
        let logo = editor.logo.read(cx).text().trim().to_string();
        if name.is_empty() {
            self.error = Some("Agent name is required.".into());
            cx.notify();
            return;
        }
        if command.is_empty() {
            self.error = Some("Agent command is required.".into());
            cx.notify();
            return;
        }
        let icon = if logo.is_empty() {
            None
        } else {
            Some(logo.clone())
        };
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            return;
        };
        self.busy_agent = Some("__custom__".into());
        self.error = None;
        let editing = agent_id.clone();
        self.action_task = Some(cx.spawn(async move |this, cx| {
            let result = if let Some(agent_id) = editing {
                engine
                    .client()
                    .call(
                        methods::UPDATE_CUSTOM_ACP_AGENT,
                        serde_json::json!({
                            "agentId": agent_id,
                            "name": name,
                            "command": command,
                            "icon": icon
                        }),
                    )
                    .await
            } else {
                engine
                    .client()
                    .call(
                        methods::ADD_CUSTOM_ACP_AGENT,
                        serde_json::json!({ "name": name, "command": command, "icon": icon }),
                    )
                    .await
            };
            this.update(cx, |page, cx| {
                page.busy_agent = None;
                match result {
                    Ok(value) => match serde_json::from_value::<AcpAgentsSnapshot>(value) {
                        Ok(snapshot) => {
                            page.snapshot = Loadable::Ready(snapshot);
                            page.editor = None;
                        }
                        Err(error) => page.error = Some(error.to_string().into()),
                    },
                    Err(error) => page.error = Some(error.to_string().into()),
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }


    fn editor_panel(&self, theme: &Theme, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let Some(editor) = self.editor.as_ref() else {
            return Vec::new();
        };
        let name_valid = !editor.name.read(cx).text().trim().is_empty();
        let command_valid = !editor.command.read(cx).text().trim().is_empty();
        let valid = name_valid && command_valid;
        let saving = self.busy_agent.as_deref() == Some("__custom__");
        let editing = editor.agent_id.is_some();
        vec![
            div()
                .mt(px(16.0))
                .rounded(px(12.0))
                .border_1()
                .border_color(theme.border)
                .bg(theme.surface)
                .p(px(20.0))
                .child(
                    widgets::row_title(
                        theme,
                        if editing {
                            "Edit custom ACP agent"
                        } else {
                            "Add custom ACP agent"
                        },
                    ),
                )
                .child(
                    div()
                        .mt(px(6.0))
                        .text_size(px(11.5))
                        .text_color(theme.text_muted.opacity(0.65))
                        .child(
                            "Register any ACP-compatible agent. The command is the same string the \
                         ACP SDK accepts: a bare executable, a shell pipeline, or JSON like \
                         {\"command\":\"...\",\"args\":[...],\"env\":{...}}.",
                        ),
                )
                .child(editor_field(theme, "Name", editor.name.clone()))
                .child(editor_field(theme, "Command", editor.command.clone()))
                .child(editor_field(theme, "Logo URL", editor.logo.clone()))
                .child(
                    div()
                        .mt(px(18.0))
                        .flex()
                        .gap(px(8.0))
                        .child(
                            popover::btn_primary(theme, "Save")
                                .id("save-custom-acp-agent")
                                .when(!valid || saving, |button| button.opacity(0.45))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if valid && !saving {
                                        this.save_custom(cx);
                                    }
                                })),
                        )
                        .child(
                            widgets::ghost_action(theme)
                                .id("cancel-custom-acp-agent")
                                .when(saving, |button| button.opacity(0.45))
                                .hover(|s| widgets::ghost_hover(theme, s))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if !saving {
                                        this.cancel_editor(cx);
                                    }
                                }))
                                .child("Cancel"),
                        ),
                )
                .into_any_element(),
        ]
    }

    fn installed_row(
        &self,
        agent: &InstalledAcpAgent,
        active: bool,
        first: bool,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = agent.id.clone();
        let busy = self.busy_agent.as_deref() == Some(agent.id.as_str());
        let activate_id = id.clone();
        let remove_id = id.clone();
        widgets::card_row(theme, first)
            .child(acp_tile(
                agent.icon.as_deref(),
                crate::icons::WIDGET,
                theme,
                cx,
            ))
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .child(widgets::row_title(theme, agent.name.clone()))
                    .child(widgets::meta_line(
                        theme,
                        vec![
                            div()
                                .child(SharedString::from(format!("v{}", agent.version)))
                                .into_any_element(),
                            div()
                                .child(SharedString::from(agent.distribution.clone()))
                                .into_any_element(),
                        ],
                    )),
            )
            .when(active, |row| {
                row.child(widgets::badge_active(&theme, "Default"))
            })
            .when(!active, |row| {
                row.child(
                    widgets::ghost_action(theme)
                        .id(SharedString::from(format!("activate-acp-{id}")))
                        .when(busy, |button| button.opacity(0.5))
                        .hover(|s| widgets::ghost_hover(&theme, s))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if this.busy_agent.is_none() {
                                this.action(methods::ACTIVATE_ACP_AGENT, activate_id.clone(), cx);
                            }
                        }))
                        .child("Set default"),
                )
            })
            .when(agent.distribution == "custom", |row| {
                row.child(
                    widgets::ghost_action(theme)
                        .id(SharedString::from(format!("edit-acp-{id}")))
                        .when(busy, |button| button.opacity(0.5))
                        .hover(|s| widgets::ghost_hover(&theme, s))
                        .on_click({
                            let agent = agent.clone();
                            cx.listener(move |this, _, _, cx| {
                                if this.busy_agent.is_none() && this.action_task.is_none() {
                                    this.open_editor_for(Some(&agent), cx);
                                }
                            })
                        })
                        .child("Edit"),
                )
            })
            .child(
                widgets::ghost_action(theme)
                    .id(SharedString::from(format!("remove-acp-{id}")))
                    .when(busy, |button| button.opacity(0.5))
                    .hover(|s| widgets::ghost_hover(&theme, s))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if this.busy_agent.is_none() {
                            this.action(methods::REMOVE_ACP_AGENT, remove_id.clone(), cx);
                        }
                    }))
                    .child(if busy { "Working…" } else { "Remove" }),
            )
            .into_any_element()
    }

    fn harness_health_row(
        &self,
        health: &HarnessHealth,
        first: bool,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = health.id;
        let installing = self.installing_harness == Some(id);
        let can_install = health.install_package.is_some() && !health.installed;

        let status_icon = if health.installed {
            crate::icons::icon(crate::icons::CHECK)
                .size(px(16.0))
                .text_color(theme.success)
        } else if health.available {
            crate::icons::icon(crate::icons::DANGER_TRIANGLE)
                .size(px(16.0))
                .text_color(theme.warning)
        } else {
            crate::icons::icon(crate::icons::DANGER_TRIANGLE)
                .size(px(16.0))
                .text_color(theme.danger)
        };

        let status_label = if health.installed {
            "Installed"
        } else if health.available {
            "Available via npx"
        } else {
            "Not installed"
        };

        let status_color = if health.installed {
            theme.success_muted
        } else if health.available {
            theme.warning_muted
        } else {
            theme.danger_muted
        };

        widgets::card_row(theme, first)
            .child(
                div()
                    .flex_none()
                    .size(px(36.0))
                    .rounded(px(10.0))
                    .border_1()
                    .border_color(theme.border)
                    .bg(white_alpha(0.03))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(status_icon),
            )
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .child(widgets::row_title(theme, health.name.clone()))
                    .child(
                        div()
                            .mt(px(4.0))
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap_x(px(8.0))
                            .text_size(px(11.5))
                            .child(
                                div()
                                    .text_color(status_color.opacity(0.9))
                                    .child(SharedString::from(status_label)),
                            )
                            .child(
                                div()
                                    .text_color(theme.text_muted.opacity(0.3))
                                    .child(SharedString::from("·")),
                            )
                            .child(
                                div()
                                    .text_color(theme.text_muted.opacity(0.65))
                                    .child(SharedString::from(health.message.clone())),
                            ),
                    ),
            )
            .when(health.installed, |row| {
                row.child(widgets::badge_active(theme, "Ready"))
            })
            .when(can_install, |row| {
                row.child(
                    popover::btn_primary(
                        theme,
                        if installing {
                            "Installing…"
                        } else {
                            "Install"
                        },
                    )
                    .id(SharedString::from(format!("install-harness-{id:?}")))
                    .when(installing, |button| button.opacity(0.5))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if this.installing_harness.is_none() {
                            this.install_harness(id, cx);
                        }
                    })),
                )
            })
            .into_any_element()
    }

    fn registry_row(
        &self,
        agent: &AcpRegistryAgent,
        installed: bool,
        first: bool,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = agent.id.clone();
        let busy = self.busy_agent.as_deref() == Some(agent.id.as_str());
        let supported = agent.supported;
        widgets::card_row(theme, first)
            .child(acp_tile(
                agent.icon.as_deref(),
                crate::icons::ADD_CIRCLE,
                theme,
                cx,
            ))
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .child(widgets::row_title(theme, agent.name.clone()))
                    .child(
                        div()
                            .mt(px(4.0))
                            .text_size(px(11.5))
                            .line_height(px(17.0))
                            .text_color(theme.text_muted.opacity(0.65))
                            .child(SharedString::from(agent.description.clone())),
                    )
                    .child(widgets::meta_line(
                        theme,
                        vec![
                            div()
                                .child(SharedString::from(format!("v{}", agent.version)))
                                .into_any_element(),
                            div()
                                .child(SharedString::from(
                                    agent
                                        .distribution
                                        .clone()
                                        .unwrap_or_else(|| "Unavailable on this device".into()),
                                ))
                                .into_any_element(),
                        ],
                    )),
            )
            .when(installed, |row| row.child(widgets::badge(theme, "Added")))
            .when(!installed, |row| {
                row.child(
                    widgets::ghost_action(theme)
                        .id(SharedString::from(format!("install-acp-{id}")))
                        .when(!supported || busy, |button| button.opacity(0.45))
                        .hover(|s| widgets::ghost_hover(&theme, s))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if supported && this.busy_agent.is_none() {
                                this.action(methods::INSTALL_ACP_AGENT, id.clone(), cx);
                            }
                        }))
                        .child(if busy { "Adding…" } else { "Add" }),
                )
            })
            .into_any_element()
    }
}

fn editor_field(theme: &Theme, label: &'static str, input: Entity<ComposerInput>) -> gpui::Div {
    div()
        .mt(px(12.0))
        .child(
            div()
                .mb(px(5.0))
                .text_size(px(11.5))
                .text_color(theme.text_muted)
                .child(label),
        )
        .child(
            div()
                .h(px(38.0))
                .flex()
                .items_center()
                .overflow_hidden()
                .rounded(px(8.0))
                .border_1()
                .border_color(theme.border)
                .bg(white_alpha(0.02))
                .px(px(9.0))
                .child(input),
        )
}

/// The identity tile for an ACP agent row: the agent's logo (fetched + decoded
/// from its icon URL) when available, otherwise a static fallback icon. Falls
/// back to the glyph while the logo is still loading or if the fetch failed.
fn acp_tile(
    icon_url: Option<&str>,
    fallback_icon: &'static str,
    theme: &Theme,
    cx: &mut Context<AcpAgentsPage>,
) -> gpui::Div {
    let glyph: gpui::AnyElement = match icon_url.filter(|u| !u.is_empty()) {
        Some(url) => match crate::acp_logo::logo(url, cx) {
            crate::acp_logo::Logo::Ready(image) => gpui::img(image)
                .size(px(20.0))
                .flex_none()
                .into_any_element()
                .into_any_element(),
            crate::acp_logo::Logo::Pending(_) | crate::acp_logo::Logo::None => {
                crate::icons::icon(fallback_icon)
                    .size(px(16.0))
                    .text_color(theme.text_muted)
                    .into_any_element()
            }
        },
        None => crate::icons::icon(fallback_icon)
            .size(px(16.0))
            .text_color(theme.text_muted)
            .into_any_element(),
    };
    widgets::row_tile_child(theme, glyph)
}

fn decode_snapshot(
    result: Result<serde_json::Value, comet_rpc::RpcError>,
) -> Loadable<AcpAgentsSnapshot> {
    match result {
        Ok(value) => serde_json::from_value(value)
            .map(Loadable::Ready)
            .unwrap_or_else(|error| Loadable::Error(error.to_string())),
        Err(error) => Loadable::Error(error.to_string()),
    }
}

fn decode_health(
    result: Result<serde_json::Value, comet_rpc::RpcError>,
) -> Loadable<Vec<HarnessHealth>> {
    match result {
        Ok(value) => serde_json::from_value(value)
            .map(Loadable::Ready)
            .unwrap_or_else(|error| Loadable::Error(error.to_string())),
        Err(error) => Loadable::Error(error.to_string()),
    }
}

impl gpui::Render for AcpAgentsPage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(cx).clone();

        // Detect sign-out → sign-in transition and reload. Without this, the
        // page's one-shot load (in `new`) is the only fetch; after re-auth the
        // snapshot can be stale or empty even though the engine still has the
        // data on disk.
        let now_signed_in = matches!(
            self.state.read(cx).auth.as_ref(),
            Some(AuthState::SignedIn { .. })
        );
        if now_signed_in && !self.was_signed_in {
            self.load(cx);
        }
        self.was_signed_in = now_signed_in;

        let snapshot = self.snapshot.ready().cloned();
        let refreshing = self.snapshot.is_loading();
        let count = snapshot
            .as_ref()
            .map(|snapshot| snapshot.installed.len())
            .filter(|count| *count > 0);

        let health_rows = self.harness_health.ready().cloned();

        let mut content: Vec<AnyElement> = match snapshot {
            Some(snapshot) => {
                // Refresh the global agent-id -> icon-URL table so the rail,
                // tabs, and harness-tab picker can resolve logos. Covers both
                // installed (which may be custom with user-supplied icons) and
                // registry agents (deterministic CDN icon URLs).
                crate::acp_logo::set_agent_icons(
                    &snapshot
                        .installed
                        .iter()
                        .map(|a| (a.id.as_str(), a.icon.as_deref()))
                        .chain(
                            snapshot
                                .registry
                                .iter()
                                .map(|a| (a.id.as_str(), a.icon.as_deref())),
                        )
                        .collect::<Vec<_>>(),
                );
                let installed_rows = snapshot
                    .installed
                    .iter()
                    .enumerate()
                    .map(|(index, agent)| {
                        self.installed_row(
                            agent,
                            snapshot.active_agent_id.as_deref() == Some(agent.id.as_str()),
                            index == 0,
                            &theme,
                            cx,
                        )
                    })
                    .collect::<Vec<_>>();
                let registry_rows = snapshot
                    .registry
                    .iter()
                    .enumerate()
                    .map(|(index, agent)| {
                        self.registry_row(
                            agent,
                            snapshot
                                .installed
                                .iter()
                                .any(|installed| installed.id == agent.id),
                            index == 0,
                            &theme,
                            cx,
                        )
                    })
                    .collect::<Vec<_>>();
                vec![
                    div()
                        .mt(px(24.0))
                        .child(widgets::row_title(&theme, "Added on this device"))
                        .child(
                            widgets::section_card(&theme)
                                .mt(px(8.0))
                                .when(installed_rows.is_empty(), |card| {
                                    card.child(
                                        div()
                                            .px(px(20.0))
                                            .py(px(28.0))
                                            .text_size(px(13.0))
                                            .text_color(theme.text_muted)
                                            .child("No ACP agents added yet."),
                                    )
                                })
                                .children(installed_rows),
                        )
                        .into_any_element(),
                    div()
                        .mt(px(24.0))
                        .child(widgets::row_title(&theme, "Official ACP registry"))
                        .when_some(snapshot.registry_error, |section, error| {
                            section.child(widgets::warning_strip(
                                &theme,
                                format!("Could not refresh the registry: {error}"),
                            ))
                        })
                        .child(
                            widgets::section_card(&theme)
                                .mt(px(8.0))
                                .children(registry_rows),
                        )
                        .into_any_element(),
                ]
            }
            None if refreshing => vec![
                widgets::section_card(&theme)
                    .child(
                        div()
                            .px(px(20.0))
                            .py(px(28.0))
                            .text_size(px(13.0))
                            .text_color(theme.text_muted)
                            .child("Loading the ACP registry…"),
                    )
                    .into_any_element(),
            ],
            None => vec![],
        };

        // Prepend the built-in harness health section so it appears first.
        if let Some(healths) = health_rows {
            let harness_rows: Vec<AnyElement> = healths
                .iter()
                .enumerate()
                .map(|(index, health)| self.harness_health_row(health, index == 0, &theme, cx))
                .collect();
            content.insert(
                0,
                div()
                    .mt(px(24.0))
                    .child(widgets::row_title(&theme, "Built-in harnesses"))
                    .child(
                        div()
                            .mt(px(4.0))
                            .text_size(px(12.5))
                            .text_color(theme.text_muted)
                            .child(
                                "Check and install the CLI binaries for Claude Code, Codex, \
                                 and Cursor. Each harness needs its adapter installed to run \
                                 sessions.",
                            ),
                    )
                    .child(
                        widgets::section_card(&theme)
                            .mt(px(8.0))
                            .children(harness_rows),
                    )
                    .into_any_element(),
            );
        }

        div()
            .id("acp-agents-page")
            .size_full()
            .overflow_y_scroll()
            .child(
                widgets::page_column()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .child(widgets::page_header(&theme, "ACP agents", count))
                            .child(div().flex_1())
                            .child(
                                widgets::ghost_action(&theme)
                                    .id("add-custom-acp-agent")
                                    .when(self.editor.is_some() || self.busy_agent.is_some(), |button| {
                                        button.opacity(0.45)
                                    })
                                    .hover(|s| widgets::ghost_hover(&theme, s))
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        if this.editor.is_none() && this.busy_agent.is_none() {
                                            this.open_editor_for(None, cx);
                                        }
                                    }))
                                    .child(
                                        crate::icons::icon(crate::icons::ADD_CIRCLE)
                                            .size(px(14.0))
                                            .text_color(theme.text_muted),
                                    )
                                    .child("Add custom"),
                            )
                            .child(
                                widgets::ghost_action(&theme)
                                    .id("refresh-acp-registry")
                                    .when(refreshing, |button| button.opacity(0.5))
                                    .hover(|s| widgets::ghost_hover(&theme, s))
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        if !this.snapshot.is_loading() {
                                            this.load(cx);
                                        }
                                    }))
                                    .child(crate::icons::icon(crate::icons::REFRESH).size(px(14.0)))
                                    .child("Refresh"),
                            ),
                    )
                    .child(widgets::page_subtitle(
                        &theme,
                        "Add ACP-compatible coding agents. Any installed agent can be selected when starting a session; one is the default.",
                    ))
                    .when_some(self.snapshot.error().map(str::to_string), |page, error| {
                        page.child(
                            widgets::error_strip(&theme, error)
                                .id("acp-load-error")
                                .cursor_pointer()
                                .on_click(cx.listener(|this, _, _, cx| this.load(cx))),
                        )
                    })
                    .when_some(self.error.clone(), |page, error| {
                        page.child(
                            widgets::error_strip(&theme, error)
                                .id("acp-action-error")
                                .cursor_pointer()
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.error = None;
                                    cx.notify();
                                })),
                        )
                    })
                    .children(self.editor_panel(&theme, cx))
                    .children(content),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_snapshot_rejects_invalid_payload() {
        assert!(matches!(
            decode_snapshot(Ok(serde_json::json!({"installed": "bad"}))),
            Loadable::Error(_)
        ));
    }
}

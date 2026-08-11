use comet_proto::{
    AcpAgentsSnapshot, AcpRegistryAgent, AuthState, HarnessHealth, HarnessId, InstalledAcpAgent,
};
use comet_rpc::methods;
use gpui::{
    AnyElement, Context, Entity, SharedString, Subscription, Task, Window, div, prelude::*, px,
};
use std::time::Duration;

use crate::composer::{ComposerInput, ComposerInputEvent};
use crate::dev_inspector::InspectExt as _;
use crate::popover::{self, Loadable};
use crate::settings::widgets;
use crate::state::AppState;
use crate::theme::{Theme, white_alpha};

pub struct AcpAgentsPage {
    state: Entity<AppState>,
    /// Which device's agents are shown; `None` = this device (no passthrough).
    /// Retargeted by the page-header device switcher — ACP agent RPCs are
    /// relay-forwardable, and agents are per-device (the executables must
    /// exist on the device that runs the sessions).
    target_device: Option<String>,
    device_menu_open: bool,
    /// Outside-click dismissal instant — suppresses the trigger click that
    /// follows the same mouse-down from instantly reopening the menu.
    device_menu_dismissed_at: Option<std::time::Instant>,
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
            target_device: None,
            device_menu_open: false,
            device_menu_dismissed_at: None,
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

    /// Retarget the page at another device's agents: every ACP agent RPC is
    /// relay-forwardable, so the whole page follows the passthrough.
    fn set_target_device(&mut self, target: Option<String>, cx: &mut Context<Self>) {
        self.device_menu_open = false;
        if self.target_device == target {
            cx.notify();
            return;
        }
        self.target_device = target;
        self.busy_agent = None;
        self.error = None;
        self.editor = None;
        self.load(cx);
    }

    /// Params with the `targetDeviceId` passthrough merged in.
    fn params(&self, value: serde_json::Value) -> serde_json::Value {
        let mut value = value;
        if let (Some(target), Some(object)) = (&self.target_device, value.as_object_mut()) {
            object.insert("targetDeviceId".into(), serde_json::json!(target));
        }
        value
    }

    /// The page-header device switcher: a quiet trigger — platform glyph ·
    /// name · presence dot · sort glyph — opening a dropdown of every
    /// registered device. Selecting one retargets the page at that device's
    /// ACP agents.
    fn render_device_switcher(&mut self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        use crate::icons::{self, icon};
        let (mut devices, local_id) = {
            let s = self.state.read(cx);
            (s.devices.clone(), s.local_device_id.clone())
        };
        devices = crate::settings::devices::devices_for_display(devices, local_id.as_deref());
        devices.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        let effective = self.target_device.clone().or_else(|| local_id.clone());
        let selected = devices
            .iter()
            .find(|d| Some(d.id.as_str()) == effective.as_deref())
            .cloned();
        let platform_glyph = |platform: &str| match platform {
            "macos" | "darwin" => icons::LAPTOP,
            "ios" | "android" => icons::SMARTPHONE,
            _ => icons::MONITOR,
        };
        let trigger_glyph = platform_glyph(
            selected
                .as_ref()
                .map(|d| d.platform.as_str())
                .unwrap_or("macos"),
        );
        let trigger_label: SharedString = selected
            .as_ref()
            .map(|d| d.name.clone().into())
            .unwrap_or_else(|| SharedString::from("This device"));
        let emerald = theme.success;
        let open = self.device_menu_open;

        let mut trigger =
            div()
                .id("acp-device-switcher")
                .flex_none()
                .h(px(28.0))
                .px(px(8.0))
                .rounded(px(6.0))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .cursor_pointer()
                .bg(if open {
                    crate::theme::ink(0.06)
                } else {
                    gpui::transparent_black()
                })
                .when(!open, |el| el.hover(|s| s.bg(crate::theme::ink(0.04))))
                .on_click(cx.listener(|this, _, _, cx| {
                    let just_dismissed = this
                        .device_menu_dismissed_at
                        .is_some_and(|at| at.elapsed() < Duration::from_millis(400));
                    this.device_menu_open = !this.device_menu_open && !just_dismissed;
                    this.device_menu_dismissed_at = None;
                    cx.notify();
                }))
                .child(
                    icon(trigger_glyph)
                        .size(px(16.0))
                        .flex_none()
                        .text_color(theme.text_muted),
                )
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_size(px(12.5))
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .text_color(theme.text)
                        .child(trigger_label),
                )
                .child(div().size(px(6.0)).rounded_full().flex_none().bg(
                    if effective == local_id {
                        emerald
                    } else {
                        crate::theme::ink(0.2)
                    },
                ))
                .child(
                    icon(icons::SORT_VERTICAL)
                        .size(px(14.0))
                        .flex_none()
                        .text_color(theme.text_muted.opacity(if open { 0.9 } else { 0.4 })),
                );

        if open {
            let menu = popover::popover_card(theme)
                .w(px(220.0))
                .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                    this.device_menu_open = false;
                    this.device_menu_dismissed_at = Some(std::time::Instant::now());
                    cx.notify();
                }))
                .flex()
                .flex_col()
                .gap(px(2.0))
                .child(popover::menu_heading(theme, "Devices"))
                .children(devices.into_iter().enumerate().map(|(ix, d)| {
                    let is_active = Some(d.id.as_str()) == effective.as_deref();
                    let is_local = local_id.as_deref() == Some(d.id.as_str());
                    let glyph = platform_glyph(&d.platform);
                    let name: SharedString = d.name.clone().into();
                    let pick_local = is_local;
                    let pick_id = d.id.clone();
                    popover::menu_row(theme, is_active, format!("acp-device-row-{ix}"))
                        .id(("acp-device-row", ix))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let target = (!pick_local).then(|| pick_id.clone());
                            this.set_target_device(target, cx);
                        }))
                        .child(
                            icon(glyph)
                                .size(px(16.0))
                                .flex_none()
                                .text_color(theme.text_muted),
                        )
                        .child(div().flex_1().min_w_0().truncate().child(name))
                        .when(is_local, |el| {
                            el.child(
                                div()
                                    .flex_none()
                                    .text_size(px(10.5))
                                    .text_color(theme.text_muted.opacity(0.35))
                                    .child(SharedString::from("You")),
                            )
                        })
                        .when(is_active, |el| el.child(popover::menu_check(theme)))
                        .child(
                            div()
                                .size(px(6.0))
                                .rounded_full()
                                .flex_none()
                                .bg(if is_local {
                                    emerald
                                } else {
                                    crate::theme::ink(0.2)
                                }),
                        )
                }))
                .into_any_element();
            trigger = trigger.child(popover::anchored_menu("acp-device-menu", menu));
        }
        trigger.into_any_element()
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        let Some(engine) = self.state.read(cx).engine().cloned() else {
            self.snapshot = Loadable::Error("Engine not connected".into());
            self.harness_health = Loadable::Error("Engine not connected".into());
            return;
        };
        self.snapshot = Loadable::Loading;
        self.harness_health = Loadable::Loading;
        let acp_params = self.params(serde_json::json!({}));
        let health_params = self.params(serde_json::json!({}));
        self.load_task = Some(cx.spawn(async move |this, cx| {
            let (acp_result, health_result) = futures::future::join(
                engine
                    .client()
                    .call(methods::LIST_ACP_AGENTS, acp_params),
                engine
                    .client()
                    .call(methods::CHECK_HARNESS_HEALTH, health_params),
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
        let params = self.params(serde_json::json!({ "agentId": agent_id }));
        self.action_task = Some(cx.spawn(async move |this, cx| {
            let result = engine
                .client()
                .call(method, params)
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
        let params = self.params(serde_json::json!({ "harness": id }));
        self.action_task = Some(cx.spawn(async move |this, cx| {
            let result = engine
                .client()
                .call(methods::INSTALL_HARNESS, params)
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
                            let health_params = page.params(serde_json::json!({}));
                            page.load_task = Some(cx.spawn(async move |this, cx| {
                                let health_result = engine
                                    .client()
                                    .call(methods::CHECK_HARNESS_HEALTH, health_params)
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
        let target_device = self.target_device.clone();
        self.action_task = Some(cx.spawn(async move |this, cx| {
            let merge_target = |mut value: serde_json::Value| {
                if let (Some(target), Some(obj)) = (&target_device, value.as_object_mut()) {
                    obj.insert("targetDeviceId".into(), serde_json::json!(target));
                }
                value
            };
            let result = if let Some(agent_id) = editing {
                engine
                    .client()
                    .call(
                        methods::UPDATE_CUSTOM_ACP_AGENT,
                        merge_target(serde_json::json!({
                            "agentId": agent_id,
                            "name": name,
                            "command": command,
                            "icon": icon
                        })),
                    )
                    .await
            } else {
                engine
                    .client()
                    .call(
                        methods::ADD_CUSTOM_ACP_AGENT,
                        merge_target(serde_json::json!({ "name": name, "command": command, "icon": icon })),
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
                                .inspect_tag("save-custom-acp-agent")
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
                                .inspect_tag("cancel-custom-acp-agent")
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
                        .inspect_tag("activate-acp")
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
                        .inspect_tag("edit-acp")
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
                    .inspect_tag("remove-acp")
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
                    .inspect_tag("install-harness")
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
                        .inspect_tag("install-acp")
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
                let device_label = if self.target_device.is_some() {
                    "Added on selected device"
                } else {
                    "Added on this device"
                };
                vec![
                    div()
                        .mt(px(24.0))
                        .child(widgets::row_title(&theme, device_label))
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
            .inspect_tag("acp-agents-page")
            .size_full()
            .overflow_y_scroll()
            .child(
                widgets::page_column()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .child(widgets::page_header(&theme, "ACP agents", count))
                            .child(self.render_device_switcher(&theme, cx))
                            .child(div().flex_1())
                            .child(
                                widgets::ghost_action(&theme)
                                    .id("add-custom-acp-agent")
                                    .inspect_tag("add-custom-acp-agent")
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
                                    .inspect_tag("refresh-acp-registry")
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
                        if self.target_device.is_some() {
                            "ACP agents are installed per-device. Use the switcher above to manage \
                             agents on a different device. Agents must be installed on the device \
                             that hosts the space."
                        } else {
                            "Add ACP-compatible coding agents. Any installed agent can be selected \
                             when starting a session; one is the default."
                        },
                    ))
                    .when_some(self.snapshot.error().map(str::to_string), |page, error| {
                        page.child(
                            widgets::error_strip(&theme, error)
                                .id("acp-load-error")
                                .inspect_tag("acp-load-error")
                                .cursor_pointer()
                                .on_click(cx.listener(|this, _, _, cx| this.load(cx))),
                        )
                    })
                    .when_some(self.error.clone(), |page, error| {
                        page.child(
                            widgets::error_strip(&theme, error)
                                .id("acp-action-error")
                                .inspect_tag("acp-action-error")
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

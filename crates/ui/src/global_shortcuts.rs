//! Global AI shortcut listener and the compact input/result window.

use std::collections::HashMap;
use std::time::Duration;

use comet_rpc::methods;
use global_hotkey::hotkey::HotKey;
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
use gpui::{
    App, AppContext as _, Bounds, Context, Entity, Focusable as _, SharedString, Subscription,
    Task, Window, WindowBounds, WindowKind, WindowOptions, div, prelude::*, px, size,
};

use crate::composer::{ComposerInput, ComposerInputEvent};
use crate::settings::{AiShortcut, platform_combo};
use crate::state::{AppState, EngineHandle};
use crate::theme::{Theme, white_alpha};

pub struct GlobalShortcutRuntimeHandle(pub Entity<GlobalShortcutRuntime>);
impl gpui::Global for GlobalShortcutRuntimeHandle {}

pub struct GlobalShortcutRuntime {
    state: Entity<AppState>,
    manager: Option<GlobalHotKeyManager>,
    registered: Vec<HotKey>,
    shortcuts: HashMap<u32, AiShortcut>,
    pub registration_errors: Vec<String>,
    _poll: Task<()>,
}

impl GlobalShortcutRuntime {
    pub fn new(
        state: Entity<AppState>,
        shortcuts: Vec<AiShortcut>,
        cx: &mut Context<Self>,
    ) -> Self {
        let manager = GlobalHotKeyManager::new()
            .map_err(|error| tracing::warn!(%error, "global shortcuts unavailable"))
            .ok();
        let poll = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(40))
                    .await;
                let events = std::iter::from_fn(|| GlobalHotKeyEvent::receiver().try_recv().ok())
                    .filter(|event| event.state == HotKeyState::Pressed)
                    .collect::<Vec<_>>();
                for event in events {
                    let _ = this.update(cx, |runtime, cx| runtime.trigger(event.id, cx));
                }
            }
        });
        let mut runtime = Self {
            state,
            manager,
            registered: Vec::new(),
            shortcuts: HashMap::new(),
            registration_errors: Vec::new(),
            _poll: poll,
        };
        runtime.configure(shortcuts, cx);
        runtime
    }

    pub fn configure(&mut self, shortcuts: Vec<AiShortcut>, cx: &mut Context<Self>) {
        self.registration_errors.clear();
        self.shortcuts.clear();
        let Some(manager) = &self.manager else {
            self.registration_errors
                .push("Global shortcut service is unavailable on this platform.".into());
            cx.notify();
            return;
        };
        if let Err(error) = manager.unregister_all(&self.registered) {
            tracing::warn!(%error, "failed to unregister old global shortcuts");
        }
        self.registered.clear();

        for shortcut in shortcuts
            .into_iter()
            .filter(|shortcut| shortcut.enabled && shortcut.is_valid())
        {
            let global_combo = platform_combo(&shortcut.combo).replace('-', "+");
            match global_combo.parse::<HotKey>() {
                Ok(hotkey) => match manager.register(hotkey) {
                    Ok(()) => {
                        self.registered.push(hotkey);
                        self.shortcuts.insert(hotkey.id(), shortcut);
                    }
                    Err(error) => self.registration_errors.push(format!(
                        "{}: {}",
                        shortcut.name,
                        friendly_hotkey_error(&error.to_string())
                    )),
                },
                Err(error) => self
                    .registration_errors
                    .push(format!("{}: {error}", shortcut.name)),
            }
        }
        cx.notify();
    }

    fn trigger(&mut self, hotkey_id: u32, cx: &mut Context<Self>) {
        let Some(shortcut) = self.shortcuts.get(&hotkey_id).cloned() else {
            return;
        };
        let engine = self.state.read(cx).engine().cloned();
        open_shortcut_window(shortcut, engine, cx);
    }
}

fn friendly_hotkey_error(error: &str) -> String {
    if error.to_lowercase().contains("already") {
        "this key combination is already registered".into()
    } else {
        error.to_string()
    }
}

fn open_shortcut_window(shortcut: AiShortcut, engine: Option<EngineHandle>, cx: &mut App) {
    let bounds = Bounds::centered(None, size(px(620.0), px(430.0)), cx);
    let start_input = if shortcut.use_clipboard {
        capture_selected_text_or_clipboard()
    } else {
        None
    };
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        window_min_size: Some(size(px(420.0), px(260.0))),
        titlebar: None,
        kind: WindowKind::PopUp,
        focus: true,
        app_id: Some("comet-shortcut".into()),
        ..Default::default()
    };
    let handle = match cx.open_window(options, move |window, cx| {
        cx.new(|cx| ShortcutWindow::new(shortcut, engine, start_input, window, cx))
    }) {
        Ok(handle) => handle,
        Err(error) => {
            tracing::warn!(%error, "failed to open shortcut result window");
            return;
        }
    };
    // macOS: the shortcut panel is an NSPanel (non-activating); `open_window`
    // already made it key, so don't call `activate_window` — doing so yanks
    // focus away from the user's current app, and the main comet window comes
    // along with it.
    //
    // Windows/Linux: the popup window is created as a WS_EX_TOOLWINDOW. Without
    // an explicit activate the OS keeps the previously focused app in the
    // foreground and the popup is hidden behind it. Activate the window so it
    // appears on top.
    #[cfg(not(target_os = "macos"))]
    {
        let _ = handle.update(cx, |_, window, _cx| window.activate_window());
    }
    let _ = handle;
}

#[derive(Clone)]
enum ShortcutPhase {
    Asking,
    Loading,
    Result(SharedString),
    Error(SharedString),
}

struct ShortcutWindow {
    shortcut: AiShortcut,
    engine: Option<EngineHandle>,
    input: Entity<ComposerInput>,
    phase: ShortcutPhase,
    task: Option<Task<()>>,
    _input_sub: Subscription,
}

impl ShortcutWindow {
    fn new(
        shortcut: AiShortcut,
        engine: Option<EngineHandle>,
        start_input: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let input = cx.new(|cx| ComposerInput::new("Type your input…", cx));
        let input_sub = cx.subscribe(&input, |this, _, event: &ComposerInputEvent, cx| {
            if matches!(event, ComposerInputEvent::Submitted) {
                this.run(cx);
            }
        });
        let phase = if start_input.is_some() {
            ShortcutPhase::Loading
        } else {
            ShortcutPhase::Asking
        };
        if start_input.is_none() {
            window.focus(&input.focus_handle(cx), cx);
        }
        let mut view = Self {
            shortcut,
            engine,
            input,
            phase,
            task: None,
            _input_sub: input_sub,
        };
        if let Some(input) = start_input {
            view.run_with_input(input, cx);
        }
        view
    }

    fn run(&mut self, cx: &mut Context<Self>) {
        let input = self.input.read(cx).text().trim().to_string();
        if !input.is_empty() {
            self.run_with_input(input, cx);
        }
    }

    fn run_with_input(&mut self, input: String, cx: &mut Context<Self>) {
        let Some(engine) = self.engine.clone() else {
            self.phase = ShortcutPhase::Error("Comet engine is not connected.".into());
            cx.notify();
            return;
        };
        let params = serde_json::json!({
            "providerId": self.shortcut.provider_id,
            "model": self.shortcut.model,
            "prompt": self.shortcut.prompt,
            "input": input,
        });
        self.phase = ShortcutPhase::Loading;
        self.task = Some(cx.spawn(async move |this, cx| {
            let result = engine.client().call(methods::RUN_AI_SHORTCUT, params).await;
            let _ = this.update(cx, |view, cx| {
                view.phase = match result {
                    Ok(value) => value
                        .get("content")
                        .and_then(serde_json::Value::as_str)
                        .map(|text| ShortcutPhase::Result(text.to_string().into()))
                        .unwrap_or_else(|| {
                            ShortcutPhase::Error("Provider returned no content.".into())
                        }),
                    Err(error) => ShortcutPhase::Error(error.to_string().into()),
                };
                cx.notify();
            });
        }));
        cx.notify();
    }
}

impl gpui::Render for ShortcutWindow {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(cx).clone();
        let phase = self.phase.clone();
        div()
            .size_full()
            .bg(theme.bg)
            .text_color(theme.text)
            .p(px(22.0))
            .flex()
            .flex_col()
            .child(
                div()
                    .flex()
                    .items_center()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .text_size(px(15.0))
                                    .font_weight(gpui::FontWeight::SEMIBOLD)
                                    .child(SharedString::from(self.shortcut.name.clone())),
                            )
                            .child(
                                div()
                                    .mt(px(3.0))
                                    .text_size(px(11.5))
                                    .text_color(theme.text_muted)
                                    .child(SharedString::from(format!(
                                        "{} · {}",
                                        self.shortcut.provider_id, self.shortcut.model
                                    ))),
                            ),
                    )
                    .child(
                        div()
                            .id("shortcut-close")
                            .px(px(10.0))
                            .py(px(6.0))
                            .rounded(px(7.0))
                            .cursor_pointer()
                            .hover(|style| style.bg(white_alpha(0.06)))
                            .on_click(|_, window, _| window.remove_window())
                            .child("Close"),
                    ),
            )
            .child(
                div()
                    .id("shortcut-content")
                    .mt(px(18.0))
                    .flex_1()
                    .min_h_0()
                    .rounded(px(11.0))
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.surface)
                    .p(px(16.0))
                    .overflow_scroll()
                    .child(match phase {
                        ShortcutPhase::Asking => div()
                            .child(
                                div()
                                    .mb(px(10.0))
                                    .text_size(px(12.0))
                                    .text_color(theme.text_muted)
                                    .child("Input"),
                            )
                            .child(
                                div()
                                    .min_h(px(120.0))
                                    .rounded(px(8.0))
                                    .border_1()
                                    .border_color(theme.border)
                                    .bg(white_alpha(0.02))
                                    .p(px(10.0))
                                    .child(self.input.clone()),
                            )
                            .into_any_element(),
                        ShortcutPhase::Loading => div()
                            .text_size(px(13.0))
                            .text_color(theme.text_muted)
                            .child("Generating…")
                            .into_any_element(),
                        ShortcutPhase::Result(text) => div()
                            .text_size(px(13.5))
                            .line_height(px(21.0))
                            .whitespace_normal()
                            .child(text)
                            .into_any_element(),
                        ShortcutPhase::Error(error) => div()
                            .text_size(px(13.0))
                            .text_color(theme.warning)
                            .child(error)
                            .into_any_element(),
                    }),
            )
            .child(
                div()
                    .mt(px(12.0))
                    .flex()
                    .justify_end()
                    .gap(px(8.0))
                    .when(matches!(self.phase, ShortcutPhase::Asking), |row| {
                        row.child(
                            div()
                                .id("shortcut-submit")
                                .px(px(14.0))
                                .py(px(7.0))
                                .rounded(px(8.0))
                                .bg(theme.text)
                                .text_color(theme.bg)
                                .cursor_pointer()
                                .on_click(cx.listener(|this, _, _, cx| this.run(cx)))
                                .child("Run"),
                        )
                    })
                    .when_some(
                        match &self.phase {
                            ShortcutPhase::Result(text) => Some(text.clone()),
                            _ => None,
                        },
                        |row, text| {
                            row.child(
                                div()
                                    .id("shortcut-copy")
                                    .px(px(14.0))
                                    .py(px(7.0))
                                    .rounded(px(8.0))
                                    .bg(theme.text)
                                    .text_color(theme.bg)
                                    .cursor_pointer()
                                    .on_click(move |_, window, cx| {
                                        cx.write_to_clipboard(gpui::ClipboardItem::new_string(
                                            text.to_string(),
                                        ));
                                        window.remove_window();
                                    })
                                    .child("Copy result"),
                            )
                        },
                    ),
            )
            .on_mouse_down(gpui::MouseButton::Left, |_, window, _| {
                #[cfg(target_os = "macos")]
                {
                    // Keep the panel non-activating. Activating it here would
                    // cause AppKit to activate Comet's main window on close.
                    let _ = window;
                }
                #[cfg(not(target_os = "macos"))]
                {
                    window.activate_window();
                }
            })
    }
}

fn capture_selected_text_or_clipboard() -> Option<String> {
    let previous = clipboard_text();
    #[cfg(target_os = "macos")]
    {
        copy_current_selection();
        std::thread::sleep(Duration::from_millis(90));
    }
    #[cfg(target_os = "windows")]
    {
        copy_current_selection();
        std::thread::sleep(Duration::from_millis(90));
    }
    clipboard_text()
        .filter(|text| !text.trim().is_empty())
        .or(previous)
        .or_else(|| Some(String::new()))
}

fn clipboard_text() -> Option<String> {
    arboard::Clipboard::new().ok()?.get_text().ok()
}

#[cfg(target_os = "macos")]
fn copy_current_selection() {
    use std::ffi::c_void;

    type CGEventRef = *mut c_void;
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn CGEventCreateKeyboardEvent(
            source: *const c_void,
            virtual_key: u16,
            key_down: bool,
        ) -> CGEventRef;
        fn CGEventSetFlags(event: CGEventRef, flags: u64);
        fn CGEventPost(tap: u32, event: CGEventRef);
        fn CFRelease(value: *const c_void);
    }

    // ANSI C key code, command flag, HID event tap.
    unsafe {
        let down = CGEventCreateKeyboardEvent(std::ptr::null(), 8, true);
        let up = CGEventCreateKeyboardEvent(std::ptr::null(), 8, false);
        if !down.is_null() && !up.is_null() {
            CGEventSetFlags(down, 0x0010_0000);
            CGEventSetFlags(up, 0x0010_0000);
            CGEventPost(0, down);
            CGEventPost(0, up);
        }
        if !down.is_null() {
            CFRelease(down);
        }
        if !up.is_null() {
            CFRelease(up);
        }
    }
}

#[cfg(target_os = "windows")]
fn copy_current_selection() {
    // Simulate Ctrl+C via SendInput to copy the active selection in the
    // previously focused window. The shortcut window hasn't been activated yet
    // (the capture runs before `open_shortcut_window`), so the keystroke is
    // delivered to whichever app the user was in when they pressed the global
    // hotkey.
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VK_C, VK_CONTROL,
    };

    let inputs = [
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_CONTROL,
                    ..Default::default()
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_C,
                    ..Default::default()
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_C,
                    dwFlags: KEYEVENTF_KEYUP,
                    ..Default::default()
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_CONTROL,
                    dwFlags: KEYEVENTF_KEYUP,
                    ..Default::default()
                },
            },
        },
    ];
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_combo_uses_global_hotkey_syntax() {
        let combo = platform_combo("mod-alt-shift-k").replace('-', "+");
        assert!(combo.parse::<HotKey>().is_ok());
    }
}

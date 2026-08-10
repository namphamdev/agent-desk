//! Agent debug inspector: a fixed bottom-right icon that toggles "pick mode".
//!
//! In pick mode the user hovers any tagged element to see its source location
//! (file, line, module, label). Clicking immediately copies the element's
//! agent-ready summary to the clipboard and freezes the selection in a panel
//! (which includes a "Copy for Agent" button to re-copy) — closing the loop
//! between "point at the screen" and "tell the agent which file to edit".
//!
//! ## How it works
//! GPUI has no built-in hit-test API (no `element_at_point`). Instead each
//! element that opts into inspection registers itself via [`register_hover`],
//! which attaches an `on_hover` + `on_mouse_down` callback to the element's
//! div. When the user hovers, the element's [`ElementMeta`] is published into
//! the shared [`InspectorState`] (a gpui Global); the Shell's overlay reads it
//! next frame and paints a highlight + info panel.
//!
//! ## Compile-time source paths
//! [`inspected`] is `#[track_caller]`, so `file!()` / `line!()` resolve to the
//! call site automatically — no hardcoding. The caller just passes a label.
//!
//! ## Activation
//! Active in debug builds (`cfg!(debug_assertions)`) or when the
//! `COMET_INSPECTOR` env var is set. Release builds without the env var see no
//! icon and pay zero cost (the `inspected` helper returns the div unchanged).

use std::cell::RefCell;
use std::rc::Rc;

use gpui::{App, ClipboardItem, Global, Hsla, IntoElement, SharedString, div, prelude::*, rgb};

// ---------------------------------------------------------------------------
// Element metadata
// ---------------------------------------------------------------------------

/// Source location + label for an inspectable UI element.
#[derive(Clone, Debug)]
pub struct ElementMeta {
    /// `file!()` at the `inspected()` call site — absolute or workspace-relative
    /// depending on the Rust edition / `--remap-path-prefix`.
    pub file: &'static str,
    /// `line!()` at the call site.
    pub line: u32,
    /// `module_path!()` at the call site (e.g. `comet_ui::transcript::impl_rows`).
    pub module: &'static str,
    /// Human-readable label the developer assigned (e.g. `"chat-bubble"`).
    pub label: &'static str,
}

impl ElementMeta {
    /// `crates/ui/src/transcript/impl_rows.rs:142` — the format an agent needs
    /// to jump straight to the code.
    pub fn file_line(&self) -> String {
        format!("{}:{}", self.file, self.line)
    }

    /// Full agent-ready summary string for the clipboard.
    pub fn agent_summary(&self) -> String {
        format!(
            "Element: {}\nFile:    {}\nModule:  {}",
            self.label,
            self.file_line(),
            self.module,
        )
    }
}

// ---------------------------------------------------------------------------
// Inspector state (gpui Global)
// ---------------------------------------------------------------------------

/// The element currently reported by the hovered inspected element, plus the
/// frozen selection from a click. Published by `on_hover` callbacks; read by
/// the Shell overlay.
#[derive(Clone, Debug, Default)]
pub struct InspectorSnapshot {
    /// Element the pointer is over right now (pick mode only).
    pub hovered: Option<ElementMeta>,
    /// Element the user clicked to freeze (pick mode only).
    pub selected: Option<ElementMeta>,
}

/// Shared mutable state published to by inspected elements. One per app,
/// stored as a gpui Global.
#[derive(Clone, Default)]
pub struct InspectorState {
    inner: Rc<RefCell<InspectorInner>>,
}

#[derive(Default)]
struct InspectorInner {
    /// Whether pick mode is active (icon clicked).
    pub picking: bool,
    /// Latest hover/selection snapshot.
    pub snapshot: InspectorSnapshot,
}

impl InspectorState {
    /// Publish a hover event (called from inspected elements' `on_hover`).
    pub fn set_hovered(&self, meta: Option<ElementMeta>) {
        self.inner.borrow_mut().snapshot.hovered = meta;
    }

    /// Publish a click-to-select event.
    pub fn select(&self, meta: ElementMeta) {
        self.inner.borrow_mut().snapshot.selected = Some(meta);
    }

    /// Clear the frozen selection.
    pub fn clear_selection(&self) {
        self.inner.borrow_mut().snapshot.selected = None;
    }

    /// Toggle pick mode on/off.
    pub fn toggle_picking(&self) -> bool {
        let mut inner = self.inner.borrow_mut();
        inner.picking = !inner.picking;
        // Clear stale hover when leaving pick mode.
        if !inner.picking {
            inner.snapshot.hovered = None;
        }
        inner.picking
    }

    /// Is pick mode currently active?
    pub fn is_picking(&self) -> bool {
        self.inner.borrow().picking
    }

    /// Current snapshot (hovered + selected).
    pub fn snapshot(&self) -> InspectorSnapshot {
        self.inner.borrow().snapshot.clone()
    }

    /// Is the inspector feature enabled at all in this build?
    pub fn feature_enabled() -> bool {
        cfg!(debug_assertions) || std::env::var("COMET_INSPECTOR").is_ok()
    }
}

impl Global for InspectorState {}

/// Initialize the global [`InspectorState`]. Call once at app startup
/// (e.g. in `Shell::new`). Safe to call multiple times — no-op after the first.
pub fn init(cx: &mut App) {
    if cx.try_global::<InspectorState>().is_none() {
        cx.set_global(InspectorState::default());
    }
}

/// Read the global [`InspectorState`]. Panics if [`init`] was not called first.
pub fn global_state(cx: &App) -> InspectorState {
    cx.try_global::<InspectorState>()
        .expect("dev_inspector::init must be called before global_state")
        .clone()
}

// ---------------------------------------------------------------------------
// Inspected element helpers
// ---------------------------------------------------------------------------

/// Source metadata for the call site — created by [`inspect_meta`] and passed
/// to [`report_hover`] / [`inspect_click_handler`].
#[derive(Clone)]
pub struct InspectTag {
    meta: ElementMeta,
}

/// Create an [`InspectTag`] at the current call site. Uses `#[track_caller]`
/// so `file!()` / `line!()` resolve to the caller automatically.
///
/// ```ignore
/// let tag = dev_inspector::inspect_meta("chat-bubble");
/// ```
#[track_caller]
pub fn inspect_meta(label: &'static str) -> InspectTag {
    let loc = std::panic::Location::caller();
    InspectTag {
        meta: ElementMeta {
            file: loc.file(),
            line: loc.line(),
            module: module_path!(),
            label,
        },
    }
}

/// Report a hover event to the inspector. Call this from inside an existing
/// `on_hover` closure. No-op when the feature is disabled or pick mode is off.
///
/// ```ignore
/// let tag = dev_inspector::inspect_meta("my-button");
/// div()
///     .id("my-button")
///     .on_hover(move |hovered, window, cx| {
///         motion::hover_listener("fade-key")(&hovered, window, cx);
///         dev_inspector::report_hover(&tag, *hovered, window, cx);
///     })
/// ```
pub fn report_hover(
    tag: &InspectTag,
    hovered: bool,
    window: &mut gpui::Window,
    cx: &mut App,
) {
    if !InspectorState::feature_enabled() {
        return;
    }
    if let Some(s) = cx.try_global::<InspectorState>() {
        if s.is_picking() {
            if hovered {
                s.set_hovered(Some(tag.meta.clone()));
            } else {
                // Only clear if this element is the current hover target.
                let snap = s.snapshot();
                if snap
                    .hovered
                    .as_ref()
                    .is_some_and(|h| h.line == tag.meta.line && h.file == tag.meta.file)
                {
                    s.set_hovered(None);
                }
            }
            window.refresh();
        }
    }
}

/// Create a `on_mouse_down` closure for click-to-select in pick mode. Attach
/// this with `.on_mouse_down(MouseButton::Left, dev_inspector::select_handler(tag))`.
/// No-op when the feature is disabled.
///
/// On select, the element's [`ElementMeta::agent_summary`] is immediately
/// written to the clipboard so the developer can paste it into an agent
/// prompt without an extra button click.
pub fn select_handler(
    tag: InspectTag,
) -> impl Fn(&gpui::MouseDownEvent, &mut gpui::Window, &mut App) + 'static {
    let meta = tag.meta;
    move |_event: &gpui::MouseDownEvent, window: &mut gpui::Window, cx: &mut App| {
        if !InspectorState::feature_enabled() {
            return;
        }
        if let Some(s) = cx.try_global::<InspectorState>() {
            if s.is_picking() {
                // Copy the element's agent-ready summary to the clipboard
                // immediately so the developer can paste it without needing
                // to click a separate "Copy" button.
                cx.write_to_clipboard(ClipboardItem::new_string(meta.agent_summary()));
                s.select(meta.clone());
                window.refresh();
            }
        }
    }
}

/// Attach inspector click-to-select to an already-interactive element. This
/// adds only `on_mouse_down` (NOT `on_hover` — GPUI panics on double on_hover).
/// Use [`report_hover`] inside the element's existing `on_hover` callback.
///
/// Usage:
/// ```ignore
/// let tag = dev_inspector::inspect_meta("my-button");
/// div()
///     .id("my-button")
///     .inspect_click(tag.clone())
///     .on_hover(move |hovered, window, cx| {
///         motion::hover_listener("fade")(&hovered, window, cx);
///         dev_inspector::report_hover(&tag, *hovered, window, cx);
///     })
/// ```
pub trait InspectClickExt {
    fn inspect_click(self, tag: InspectTag) -> Self;
}

impl InspectClickExt for gpui::Stateful<gpui::Div> {
    fn inspect_click(self, tag: InspectTag) -> Self {
        if !InspectorState::feature_enabled() {
            return self;
        }
        self.on_mouse_down(gpui::MouseButton::Left, select_handler(tag))
    }
}

/// Convenience for elements that do NOT already have an `on_hover` callback.
/// This adds both `on_hover` (hover reporting) and `on_mouse_down` (click to
/// select). Panics if the element already has `on_hover`.
///
/// Usage:
/// ```ignore
/// div()
///     .id("my-element")
///     .inspect_tag("my-element")
/// ```
pub trait InspectExt {
    fn inspect_tag(self, label: &'static str) -> Self;
}

impl InspectExt for gpui::Stateful<gpui::Div> {
    #[track_caller]
    fn inspect_tag(self, label: &'static str) -> Self {
        if !InspectorState::feature_enabled() {
            return self;
        }
        let tag = inspect_meta(label);
        let hover_tag = tag.clone();
        self.on_hover(move |hovered: &bool, window: &mut gpui::Window, cx: &mut App| {
            report_hover(&hover_tag, *hovered, window, cx);
        })
        .inspect_click(tag)
    }
}

/// Tag a `div` with source-location metadata and wire up hover/click reporting
/// to the inspector. Returns the div as-is if the inspector feature is disabled
/// (release builds without `COMET_INSPECTOR`); otherwise returns an interactive
/// element with hover/click listeners attached.
///
/// Usage:
/// ```ignore
/// let bubble = dev_inspector::inspected("chat-bubble", cx, |d| {
///     d.bg(theme.surface).rounded(px(12.0)).px(px(16.0))
/// });
/// ```
///
/// `#[track_caller]` makes `file!()` / `line!()` resolve to the **caller** of
/// this function, so the metadata points at the real component code.
#[track_caller]
pub fn inspected(
    label: &'static str,
    _cx: &App,
    build: impl FnOnce(&mut gpui::Div),
) -> gpui::AnyElement {
    let loc = std::panic::Location::caller();
    let meta = ElementMeta {
        file: loc.file(),
        line: loc.line(),
        module: module_path!(),
        label,
    };
    let mut d = div();
    build(&mut d);

    // Zero-cost when disabled: return the div as-is.
    if !InspectorState::feature_enabled() {
        return d.into_any_element();
    }

    let hover_meta = meta.clone();
    let click_meta = meta.clone();

    // Unique-ish element id so GPUI doesn't complain about duplicate ids.
    let id = SharedString::from(format!("inspect-{}-{}", meta.label, meta.line));

    d.id(id)
        .on_hover(move |hovered: &bool, window: &mut gpui::Window, _cx: &mut App| {
            // Only report in pick mode; otherwise the on_hover fires for
            // every element constantly and clutters state.
            if *hovered {
                if let Some(s) = _cx.try_global::<InspectorState>() {
                    if s.is_picking() {
                        s.set_hovered(Some(hover_meta.clone()));
                        window.refresh();
                    }
                }
            }
        })
        .on_mouse_down(
            gpui::MouseButton::Left,
            move |_event: &gpui::MouseDownEvent, window: &mut gpui::Window, _cx: &mut App| {
                if let Some(s) = _cx.try_global::<InspectorState>() {
                    if s.is_picking() {
                        _cx.write_to_clipboard(ClipboardItem::new_string(
                            click_meta.agent_summary(),
                        ));
                        s.select(click_meta.clone());
                        window.refresh();
                    }
                }
            },
        )
        .into_any_element()
}

/// Convenience: tag an already-built `Div` with source-location metadata.
/// The div must NOT already have an `.id(...)` — this function adds one
/// (derived from the label + line) before attaching hover/click listeners.
#[track_caller]
pub fn tag_existing(
    label: &'static str,
    _cx: &App,
    d: gpui::Div,
) -> gpui::AnyElement {
    let loc = std::panic::Location::caller();
    let meta = ElementMeta {
        file: loc.file(),
        line: loc.line(),
        module: module_path!(),
        label,
    };

    if !InspectorState::feature_enabled() {
        return d.into_any_element();
    }

    let hover_meta = meta.clone();
    let click_meta = meta.clone();
    let id = SharedString::from(format!("inspect-{}-{}", meta.label, meta.line));

    d.id(id)
        .on_hover(move |hovered: &bool, window: &mut gpui::Window, _cx: &mut App| {
            if *hovered {
                if let Some(s) = _cx.try_global::<InspectorState>() {
                    if s.is_picking() {
                        s.set_hovered(Some(hover_meta.clone()));
                        window.refresh();
                    }
                }
            }
        })
        .on_mouse_down(
            gpui::MouseButton::Left,
            move |_event: &gpui::MouseDownEvent, window: &mut gpui::Window, _cx: &mut App| {
                if let Some(s) = _cx.try_global::<InspectorState>() {
                    if s.is_picking() {
                        _cx.write_to_clipboard(ClipboardItem::new_string(
                            click_meta.agent_summary(),
                        ));
                        s.select(click_meta.clone());
                        window.refresh();
                    }
                }
            },
        )
        .into_any_element()
}

// ---------------------------------------------------------------------------
// Highlight color (used by the Shell overlay)
// ---------------------------------------------------------------------------

/// Outline color for the hovered-element highlight.
pub fn highlight_color() -> Hsla {
    rgb(0x6CB6FF).into()
}

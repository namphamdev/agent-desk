//! Mermaid diagram rendering: flowchart parser, SVG rendering cache, and
//! the inline/full-screen diagram cards.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use gpui::{
    AnyElement, Image, ImageFormat, MouseButton, ObjectFit, ScrollHandle, SharedString,
    StyledImage as _, div, img, point, prelude::*, px, relative,
};

use crate::theme::Theme;

use super::{MermaidUi, RenderOptions, CODE_LINE_HEIGHT, CODE_TEXT_SIZE};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MermaidDirection {
    TopDown,
    LeftRight,
}

#[derive(Debug, PartialEq, Eq)]
pub struct MermaidEdge {
    pub from: String,
    pub to: String,
    pub label: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct MermaidFlowchart {
    pub direction: MermaidDirection,
    pub nodes: Vec<(String, String)>,
    pub edges: Vec<MermaidEdge>,
}

/// Parse the useful, portable subset of Mermaid flowcharts. Mermaid's browser
/// runtime is not available in the native client, so diagrams are deliberately
/// parsed locally and rendered with GPUI elements. Unsupported diagram kinds
/// retain their source in the diagram card rather than being silently dropped.
pub fn parse_mermaid_flowchart(source: &str) -> Option<MermaidFlowchart> {
    let mut statements = source
        .lines()
        .flat_map(|line| line.split(';'))
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("%%"));
    let header = statements.next()?;
    let mut header_parts = header.split_whitespace();
    if !matches!(header_parts.next()?, "flowchart" | "graph") {
        return None;
    }
    let direction = match header_parts
        .next()
        .unwrap_or("TD")
        .to_ascii_uppercase()
        .as_str()
    {
        "LR" | "RL" => MermaidDirection::LeftRight,
        _ => MermaidDirection::TopDown,
    };
    let mut chart = MermaidFlowchart {
        direction,
        nodes: Vec::new(),
        edges: Vec::new(),
    };
    for statement in statements {
        let Some((left, rest)) = split_mermaid_edge(statement) else {
            continue;
        };
        let (edge_label, right) = if let Some(rest) = rest.strip_prefix('|') {
            let Some((label, right)) = rest.split_once('|') else {
                continue;
            };
            (
                Some(label.trim().to_string()).filter(|s| !s.is_empty()),
                right,
            )
        } else {
            (None, rest)
        };
        let (from_id, from_label) = mermaid_node(left);
        let (to_id, to_label) = mermaid_node(right);
        if from_id.is_empty() || to_id.is_empty() {
            continue;
        }
        add_mermaid_node(&mut chart.nodes, from_id.clone(), from_label);
        add_mermaid_node(&mut chart.nodes, to_id.clone(), to_label);
        chart.edges.push(MermaidEdge {
            from: from_id,
            to: to_id,
            label: edge_label,
        });
    }
    (!chart.nodes.is_empty()).then_some(chart)
}

pub fn split_mermaid_edge(statement: &str) -> Option<(&str, &str)> {
    // Check longer arrows first, so `-.->` does not get mistaken for `->`.
    ["-->", "==>", "-.->", "---"]
        .iter()
        .filter_map(|arrow| statement.find(arrow).map(|at| (at, arrow.len())))
        .min_by_key(|(at, _)| *at)
        .map(|(at, len)| (statement[..at].trim(), statement[at + len..].trim()))
}

pub fn mermaid_node(raw: &str) -> (String, String) {
    let raw = raw.trim();
    let id_end = raw
        .find(|c: char| matches!(c, '[' | '(' | '{' | '"' | ' '))
        .unwrap_or(raw.len());
    let id = raw[..id_end].trim().to_string();
    let label = raw[id_end..]
        .trim()
        .trim_matches(|c| matches!(c, '[' | ']' | '(' | ')' | '{' | '}' | '"'))
        .trim();
    (
        id.clone(),
        (!label.is_empty()).then(|| label.to_string()).unwrap_or(id),
    )
}

pub fn add_mermaid_node(nodes: &mut Vec<(String, String)>, id: String, label: String) {
    if let Some((_, existing_label)) = nodes.iter_mut().find(|(existing, _)| *existing == id) {
        if existing_label == &id && label != id {
            *existing_label = label;
        }
    } else {
        nodes.push((id, label));
    }
}

pub fn mermaid_images() -> &'static Mutex<HashMap<String, Arc<Image>>> {
    static IMAGES: OnceLock<Mutex<HashMap<String, Arc<Image>>>> = OnceLock::new();
    IMAGES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Per-key interactive viewer state (zoom + drag-pan), used only by the
/// full-screen modal. The inline transcript card auto-fits the diagram and
/// never captures the wheel/drag, so wheel scroll and click-drag inside a chat
/// message never pan its contents — scrolling the transcript stays natural.
#[derive(Default)]
pub struct MermaidViewer {
    zoom: f32,
    drag_anchor: Option<gpui::Point<gpui::Pixels>>,
    scroll: ScrollHandle,
}

thread_local! {
    static MERMAID_VIEWERS: RefCell<HashMap<String, MermaidViewer>> = RefCell::new(HashMap::new());
}

pub fn mermaid_viewer(key: &str) -> (f32, ScrollHandle) {
    MERMAID_VIEWERS.with(|viewers| {
        let mut viewers = viewers.borrow_mut();
        let viewer = viewers
            .entry(key.to_string())
            .or_insert_with(|| MermaidViewer {
                zoom: 1.0,
                ..Default::default()
            });
        (viewer.zoom, viewer.scroll.clone())
    })
}

pub fn set_mermaid_zoom(key: &str, change: f32) {
    MERMAID_VIEWERS.with(|viewers| {
        let mut viewers = viewers.borrow_mut();
        let viewer = viewers
            .entry(key.to_string())
            .or_insert_with(|| MermaidViewer {
                zoom: 1.0,
                ..Default::default()
            });
        viewer.zoom = (viewer.zoom + change).clamp(0.5, 3.0);
    });
}

/// Wheel and two-finger scroll deltas are inverted so scrolling up zooms in.
/// Pixel deltas come from touchpads; line deltas come from discrete wheels.
/// Used only inside the full-screen modal.
pub fn mermaid_wheel_zoom(delta: gpui::ScrollDelta) -> f32 {
    let y = match delta {
        gpui::ScrollDelta::Pixels(delta) => f32::from(delta.y) / 240.0,
        gpui::ScrollDelta::Lines(delta) => delta.y / 12.0,
    };
    (-y).clamp(-0.25, 0.25)
}

/// Render Mermaid source with `mermaid-rs-renderer` to a native SVG image.
/// The cache keeps streaming transcript frames from recomputing layout.
pub fn render_mermaid(
    source: &str,
    top_ix: usize,
    ix: usize,
    opts: &RenderOptions,
    theme: &Theme,
) -> AnyElement {
    let viewer_key = format!("{}-mermaid-{top_ix}-{ix}", opts.row_key);
    if let Some(image) = mermaid_images()
        .lock()
        .expect("Mermaid cache poisoned")
        .get(source)
        .cloned()
    {
        return mermaid_image_card(image, viewer_key, source, ix, opts.mermaid.clone(), false);
    }
    let mut render_options = mermaid_rs_renderer::RenderOptions::default();
    // The renderer's outer Y padding becomes a conspicuous empty band in a
    // transcript. The card has no vertical inset either, so a diagram starts
    // and ends at its actual SVG bounds.
    render_options.layout.requirement.render_padding_y = 0.0;
    let Ok(svg) = mermaid_rs_renderer::render_with_options(source, render_options) else {
        return render_mermaid_fallback(source, theme);
    };
    let image = Arc::new(Image::from_bytes(ImageFormat::Svg, svg.into_bytes()));
    mermaid_images()
        .lock()
        .expect("Mermaid cache poisoned")
        .insert(source.to_string(), image.clone());
    mermaid_image_card(image, viewer_key, source, ix, opts.mermaid.clone(), false)
}

/// The diagram card. `interactive` selects behavior:
///
/// - `false` (inline chat message): the diagram is auto-fit to the card with
///   [`ObjectFit::Contain`] under a `max-height` cap — it never scrolls, never
///   captures the wheel, and never pans on drag, so wheel/scroll inside the
///   transcript scrolls the transcript itself. Copy and Open-full-screen
///   affordances float as a top-right overlay chip on the diagram.
/// - `true` (full-screen modal): the diagram keeps the persistent zoom/pan
///   viewer (wheel zoom, pinch zoom, drag-pan) with zoom buttons, so the user
///   can inspect details.
pub fn mermaid_image_card(
    image: Arc<Image>,
    viewer_key: String,
    source: &str,
    ix: usize,
    ui: Option<MermaidUi>,
    interactive: bool,
) -> AnyElement {
    // Copy + Open-full-screen affordances. `None` (previews outside the
    // transcript) renders neither.
    let copy_button = ui.clone().map(|ui| {
        let copied = ui.copied_ix == Some(ix);
        let source_text: SharedString = source.to_string().into();
        let handler = ui.copy.clone();
        let fade_key = format!("{viewer_key}-copy");
        div()
            .id(SharedString::from(fade_key.clone()))
            .h(px(22.0))
            .w(px(22.0))
            .rounded(px(4.0))
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .bg(crate::motion::hover_blend(
                &fade_key,
                crate::theme::white_alpha(0.10),
                crate::theme::white_alpha(0.18),
            ))
            .on_hover(crate::motion::hover_listener(fade_key))
            .text_color(gpui::white())
            .on_click(move |_, window, cx| handler(ix, source_text.clone(), window, cx))
            .child(
                crate::icons::icon(if copied {
                    crate::icons::CHECK
                } else {
                    crate::icons::COPY
                })
                .size(px(13.0)),
            )
    });
    let expand_button = ui.map(|ui| {
        let handler = ui.fullscreen.clone();
        let fade_key = format!("{viewer_key}-expand");
        div()
            .id(SharedString::from(fade_key.clone()))
            .h(px(22.0))
            .w(px(22.0))
            .rounded(px(4.0))
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .bg(crate::motion::hover_blend(
                &fade_key,
                crate::theme::white_alpha(0.10),
                crate::theme::white_alpha(0.18),
            ))
            .on_hover(crate::motion::hover_listener(fade_key))
            .text_color(gpui::white())
            .on_click(move |_, window, cx| handler(ix, window, cx))
            .child(crate::icons::icon(crate::icons::EXPAND).size(px(13.0)))
    });

    // Top-right overlay row: Copy + Open-full-screen float over the diagram's
    // top-right corner (matches the code-block affordance placement). When
    // neither button is present (`None`) the overlay is dropped entirely and
    // the card is just the diagram. A translucent chip groups the buttons so
    // they read against any diagram background.
    let has_buttons = copy_button.is_some() || expand_button.is_some();
    let overlay = has_buttons.then(|| {
        div()
            .absolute()
            .top(px(8.0))
            .right(px(8.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.0))
            .px(px(4.0))
            .py(px(4.0))
            .rounded(px(6.0))
            .bg(crate::theme::white_alpha(0.08))
            .border_1()
            .border_color(crate::theme::white_alpha(0.12))
            .children(copy_button)
            .children(expand_button)
    });

    let body = if interactive {
        mermaid_interactive_body(image, &viewer_key)
    } else {
        // Auto-fit: contain the whole diagram within a capped height. It never
        // overflows the card, so there is nothing to scroll or pan — the wheel
        // and drag pass straight through to the transcript.
        div()
            .id(SharedString::from(format!("{viewer_key}-viewport")))
            .w_full()
            .flex()
            .items_center()
            .justify_center()
            .py(px(8.0))
            .child(
                img(image)
                    .max_w(relative(1.0))
                    .max_h(px(544.0))
                    .object_fit(ObjectFit::Contain),
            )
            .into_any_element()
    };

    div()
        .relative()
        .rounded(px(10.0))
        .border_1()
        .border_color(crate::theme::white_alpha(0.14))
        .bg(crate::theme::white_alpha(0.035))
        .overflow_hidden()
        .child(body)
        // Overlay LAST so it paints above the diagram.
        .children(overlay)
        .into_any_element()
}

/// Full-screen modal body: persistent zoom (clamped 0.5ז3×), drag-pan, wheel
/// and pinch zoom, with zoom buttons. Independent viewer key keeps its state
/// isolated from the inline card.
pub fn mermaid_interactive_body(image: Arc<Image>, viewer_key: &str) -> AnyElement {
    let (zoom, scroll) = mermaid_viewer(viewer_key);
    let zoom_button = |label: &'static str, change: f32| {
        let key = viewer_key.to_string();
        div()
            .id(SharedString::from(format!("{key}-zoom-{label}")))
            .h(px(22.0))
            .w(px(22.0))
            .rounded(px(4.0))
            .bg(crate::theme::white_alpha(0.10))
            .hover(|el| el.bg(crate::theme::white_alpha(0.18)))
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .text_size(px(15.0))
            .text_color(gpui::white())
            .on_click(move |_, window, _| {
                set_mermaid_zoom(&key, change);
                window.refresh();
            })
            .child(label)
    };
    let pan_key = viewer_key.to_string();
    let drag_key = viewer_key.to_string();
    let release_key = viewer_key.to_string();
    let wheel_key = viewer_key.to_string();
    let pinch_key = viewer_key.to_string();
    div()
        .relative()
        .child(
            div()
                .id(SharedString::from(format!("{viewer_key}-viewport")))
                .w_full()
                .max_h(px(560.0))
                .overflow_scroll()
                .track_scroll(&scroll)
                .on_scroll_wheel(move |event, window, _| {
                    let change = mermaid_wheel_zoom(event.delta);
                    if change != 0.0 {
                        set_mermaid_zoom(&wheel_key, change);
                        window.prevent_default();
                        window.refresh();
                    }
                })
                .on_pinch(move |event, window, _| {
                    if event.delta != 0.0 {
                        set_mermaid_zoom(&pinch_key, event.delta);
                        window.prevent_default();
                        window.refresh();
                    }
                })
                .on_mouse_down(MouseButton::Left, move |event, window, _| {
                    MERMAID_VIEWERS.with(|viewers| {
                        viewers
                            .borrow_mut()
                            .entry(drag_key.clone())
                            .or_default()
                            .drag_anchor = Some(event.position);
                    });
                    window.prevent_default();
                })
                .on_mouse_move(move |event, window, _| {
                    if event.pressed_button != Some(MouseButton::Left) {
                        return;
                    }
                    MERMAID_VIEWERS.with(|viewers| {
                        let mut viewers = viewers.borrow_mut();
                        let Some(viewer) = viewers.get_mut(&pan_key) else {
                            return;
                        };
                        let Some(anchor) = viewer.drag_anchor.replace(event.position) else {
                            return;
                        };
                        let offset = viewer.scroll.offset();
                        let max = viewer.scroll.max_offset();
                        viewer.scroll.set_offset(point(
                            (offset.x + event.position.x - anchor.x).clamp(-max.x, px(0.0)),
                            (offset.y + event.position.y - anchor.y).clamp(-max.y, px(0.0)),
                        ));
                    });
                    window.refresh();
                })
                .on_mouse_up(MouseButton::Left, move |_, _, _| {
                    MERMAID_VIEWERS.with(|viewers| {
                        if let Some(viewer) = viewers.borrow_mut().get_mut(&release_key) {
                            viewer.drag_anchor = None;
                        }
                    });
                })
                .child(
                    div()
                        .w(relative(zoom))
                        .flex_none()
                        .child(img(image).w_full()),
                ),
        )
        .child(
            div()
                .absolute()
                .top(px(6.0))
                .right(px(6.0))
                .flex()
                .gap(px(4.0))
                .child(zoom_button("out", -0.25))
                .child(zoom_button("in", 0.25)),
        )
        .into_any_element()
}

#[allow(dead_code)]
pub fn render_mermaid_fallback(source: &str, theme: &Theme) -> AnyElement {
    let chart = parse_mermaid_flowchart(source);
    let title = chart
        .as_ref()
        .map(|_| "Flowchart")
        .unwrap_or("Mermaid diagram");
    let mut body = div().flex().flex_col().gap(px(8.0)).p(px(12.0));
    if let Some(chart) = chart {
        let horizontal = chart.direction == MermaidDirection::LeftRight;
        let mut nodes = div().flex().gap(px(8.0));
        if horizontal {
            nodes = nodes.flex_row();
        } else {
            nodes = nodes.flex_col();
        }
        for (index, (_, label)) in chart.nodes.iter().enumerate() {
            if index > 0 {
                let arrow = if horizontal { "→" } else { "↓" };
                nodes = nodes.child(
                    div()
                        .flex_none()
                        .text_size(px(15.0))
                        .text_color(theme.accent.opacity(0.8))
                        .child(arrow),
                );
            }
            nodes = nodes.child(
                div()
                    .flex_none()
                    .rounded(px(6.0))
                    .border_1()
                    .border_color(theme.accent.opacity(0.5))
                    .bg(theme.accent.opacity(0.10))
                    .px(px(10.0))
                    .py(px(6.0))
                    .text_size(px(12.0))
                    .text_color(theme.text)
                    .child(SharedString::from(label.clone())),
            );
        }
        body = body.child(nodes);
        if chart.edges.len() > chart.nodes.len().saturating_sub(1) {
            body = body.child(
                div()
                    .text_size(px(11.0))
                    .text_color(theme.text_muted)
                    .child(SharedString::from(format!(
                        "{} connections",
                        chart.edges.len()
                    ))),
            );
        }
    } else {
        body = body.child(
            div()
                .font_family(theme.font_mono.clone())
                .text_size(px(CODE_TEXT_SIZE))
                .line_height(px(CODE_LINE_HEIGHT))
                .text_color(theme.text_muted)
                .child(SharedString::from(source.to_string())),
        );
    }
    div()
        .rounded(px(10.0))
        .border_1()
        .border_color(theme.border)
        .bg(crate::theme::white_alpha(0.035))
        .overflow_hidden()
        .child(
            div()
                .px(px(12.0))
                .py(px(5.0))
                .border_b_1()
                .border_color(theme.border)
                .text_size(px(11.0))
                .text_color(theme.text_muted)
                .child(title),
        )
        .child(body)
        .into_any_element()
}

// ---------------------------------------------------------------------------
// Rich visualization rendering
// ---------------------------------------------------------------------------

/// Full-screen mermaid modal: dim scrim + the diagram in a frosted card with
/// its own viewer key (`"mermaid-fullscreen"`), so zoom/scroll/pan state is
/// independent of the inline card. The scrim click closes (any click outside
/// the card dismisses, like the attachment lightbox).
pub fn mermaid_fullscreen(
    viewport: gpui::Size<gpui::Pixels>,
    source: &str,
    theme: &Theme,
    on_close: impl Fn(&mut gpui::Window, &mut gpui::App) + 'static,
) -> AnyElement {
    // Resolve the cached SVG image (renders + caches on first open).
    let image = mermaid_images()
        .lock()
        .expect("Mermaid cache poisoned")
        .get(source)
        .cloned()
        .or_else(|| {
            let mut render_options = mermaid_rs_renderer::RenderOptions::default();
            render_options.layout.requirement.render_padding_y = 0.0;
            mermaid_rs_renderer::render_with_options(source, render_options)
                .ok()
                .map(|svg| {
                    let image = Arc::new(Image::from_bytes(ImageFormat::Svg, svg.into_bytes()));
                    mermaid_images()
                        .lock()
                        .expect("Mermaid cache poisoned")
                        .insert(source.to_string(), image.clone());
                    image
                })
        });
    let Some(image) = image else {
        // Renderer failed — show the source fallback card centered.
        let card = render_mermaid_fallback(source, theme);
        return crate::popover::modal("mermaid-fullscreen", viewport, card);
    };
    // Independent viewer key so the modal's zoom/pan doesn't bleed back into
    // the inline card (and vice versa). `interactive: true` keeps the zoom/pan
    // viewer; no header bar (the scrim is the affordance to close).
    let viewer_key = "mermaid-fullscreen".to_string();
    let card = mermaid_image_card(image, viewer_key, source, 0, None, true);
    // Wrap in a sized container so the modal fills the viewport (the body's own
    // max-height is a transcript-only cap).
    let max_h = px(f32::from(viewport.height) * 0.86);
    let max_w = px(f32::from(viewport.width) * 0.92);
    let container = div().max_w(max_w).max_h(max_h).child(card);
    gpui::deferred(
        gpui::anchored()
            .position(gpui::point(px(0.0), px(0.0)))
            .child(
                div()
                    .id("mermaid-fullscreen-scrim")
                    .occlude()
                    .w(viewport.width)
                    .h(viewport.height)
                    .bg(crate::popover::scrim_alpha(0.7))
                    .flex()
                    .items_center()
                    .justify_center()
                    .on_click(move |_, window, cx| on_close(window, cx))
                    .child(container),
            ),
    )
    .priority(3)
    .into_any_element()
}

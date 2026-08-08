//! BlockTree → gpui elements.
//!
//! Numbers drive layout (font sizes, line heights, paddings — all constants
//! here); colors are paint. Code blocks render per-line so their height is
//! exactly `lines × line_height`, and syntax highlighting arrives later as
//! recolored `TextRun`s on the identical mono font — layout never changes
//! (mugen's "highlight is pure paint"). Streaming fade-in is a per-appended-
//! chunk opacity veil over the text runs (see [`super::veil`]) — opacity only,
//! zero translate, applied after layout-relevant properties are fixed.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use gpui::{
    AnyElement, BorderStyle, Bounds, FontStyle, FontWeight, Hsla, Image, ImageFormat,
    InteractiveText, MouseButton, ScrollHandle, SharedString, StyledText, TextRun, UnderlineStyle,
    Window, canvas, div, font, img, point, prelude::*, px, quad, relative, size,
};

use crate::theme::Theme;

use super::highlight::{Token, TokenClass};
use super::parser::{Block, BlockTree, InlineRun, TableAlign, VizDocument, VizElement};
use super::veil::{RowVeil, apply_veil, slice_spans};

/// Gap between markdown blocks inside one message (comet mdBlockGap).
pub const MD_BLOCK_GAP: f32 = 12.0;
/// Body text size / line height (comet: 14px / 22px).
pub const MD_TEXT_SIZE: f32 = 14.0;
pub const MD_LINE_HEIGHT: f32 = 22.0;
/// Code block metrics — height is `lines × CODE_LINE_HEIGHT + padding + header`.
pub const CODE_TEXT_SIZE: f32 = 12.5;
pub const CODE_LINE_HEIGHT: f32 = 18.0;
pub const CODE_PADDING_X: f32 = 12.0;
pub const CODE_PADDING_Y: f32 = 10.0;

// Table metrics — a port of mugen-markdown 0.6.2's `TableBlock` under comet's
// resolved md theme. The design is frameless ("flat hairline"): 1px horizontal
// rules under the header and between rows are the only chrome — no outer box,
// no header fill, no corner radius (theme: headerBackground transparent,
// radius 0). Cells use the body scale (14/22) with a uniform 12px padding;
// the header row is weight-700 per `table.headerWeight`.
/// Uniform cell padding in px (comet `table.cellPadding`).
pub const TABLE_CELL_PADDING: f32 = 12.0;
/// Hairline between rows in px (comet `table.gap`).
pub const TABLE_DIVIDER: f32 = 1.0;
/// Header row font weight (comet `table.headerWeight` = 700).
pub const TABLE_HEADER_WEIGHT: FontWeight = FontWeight::BOLD;
/// Floor for a column's max-content share, so a short column ("1k") beside a
/// prose column keeps a readable width (mugen `MIN_COLUMN_CONTENT`).
pub const TABLE_MIN_COLUMN_CONTENT: f32 = 48.0;
/// Minimum rendered column width in px, padding included (comet
/// `table.minColumnWidth`). Naturally narrower columns keep their content
/// width; wider ones wrap down to this floor, then the table scrolls.
pub const TABLE_MIN_COLUMN_WIDTH: f32 = 96.0;
/// Hairline tone (comet md theme `table.borderColor`: rgba(255,255,255,0.1)).
pub fn table_hairline() -> Hsla {
    crate::theme::hairline(0.10)
}

/// Options for one rendered tree (a transcript row or a whole live message).
pub struct RenderOptions {
    /// Stable row key — prefixes element ids (scroll state, animations).
    pub row_key: SharedString,
    /// Streaming veil state for a live row: newly appended text fades in via
    /// paint-only run opacity, keyed per (element, chunk offset) so each chunk
    /// fades exactly once. `None` renders without fades (completed rows).
    pub veil: Option<Rc<RefCell<RowVeil>>>,
    /// Flatten/shape input cache (see [`RenderCache`]): settled blocks reuse
    /// their flat text + runs across frames instead of rebuilding them — the
    /// per-frame cost of a fading live row stays O(tail block), flat in the
    /// total reply length. `None` rebuilds every pass.
    pub cache: Option<Rc<RefCell<RenderCache>>>,
    /// Frame timestamp driving veil opacities (one clock per render pass).
    pub now: Instant,
    /// Code-block copy-button plumbing (round 9): `None` renders no button
    /// (previews outside the transcript).
    pub copy: Option<CopyUi>,
    /// Mermaid-card Copy + Open-full-screen plumbing: `None` renders neither
    /// affordance (previews outside the transcript).
    pub mermaid: Option<MermaidUi>,
}

/// Copy-button wiring for one row's code blocks: the handler writes the code
/// to the clipboard and flips a transient per-row "Copied" state owned by the
/// transcript entity; `copied_ix` is the block currently showing feedback.
#[derive(Clone)]
pub struct CopyUi {
    pub handler: Rc<dyn Fn(usize, SharedString, &mut Window, &mut gpui::App)>,
    pub copied_ix: Option<usize>,
}

/// Mermaid-card affordances (Copy source + Open full screen). `None` renders
/// neither button (previews outside the transcript). `copied_ix` is the block
/// currently showing the "Copied" flash; `fullscreen_ix` is the block whose
/// open request is in flight (drives the modal in the transcript layer).
#[derive(Clone)]
pub struct MermaidUi {
    pub copy: Rc<dyn Fn(usize, SharedString, &mut Window, &mut gpui::App)>,
    pub fullscreen: Rc<dyn Fn(usize, &mut Window, &mut gpui::App)>,
    pub copied_ix: Option<usize>,
}

impl RenderOptions {
    /// Options for a completed (non-streaming) row — no veil, no cache.
    pub fn settled(row_key: SharedString) -> Self {
        Self {
            row_key,
            veil: None,
            cache: None,
            now: Instant::now(),
            copy: None,
            mermaid: None,
        }
    }
}

/// Cross-frame cache of flatten results, keyed by
/// `(row key, top-level block ix, element discriminator)`.
///
/// During a streaming fade the live row re-renders every frame; without the
/// cache each frame re-derives every block's flat `String` + `TextRun`s —
/// O(reply length) per frame, growing through long replies. The incremental
/// parser only ever touches a suffix of the top-level blocks
/// ([`super::parser::IncrementalParser::stable_prefix_blocks`]), so everything
/// below that boundary is byte-identical and its flatten result (and, via
/// gpui's line-layout cache keyed on identical text+runs, its shaping) can be
/// reused as-is. `SharedString`/`Rc` make the reuse O(1) per block.
/// Cached runs carry a resolved [`gpui::Hsla`] per span, so an entry is only
/// valid for the palette that produced it — content-only keys silently serve
/// dark-mode text onto a light background after an appearance switch.
/// [`RenderCache::sync_palette`] drops everything when the palette moves.
#[derive(Default)]
pub struct RenderCache {
    flats: HashMap<(SharedString, usize, usize), Rc<FlatText>>,
    code: HashMap<(SharedString, usize, usize), Rc<CachedCode>>,
    /// The [`crate::theme::theme_generation`] these entries were shaped under.
    generation: u32,
}

/// Cached per-line code runs (validity: code length + highlight identity).
pub struct CachedCode {
    code_len: usize,
    /// Slice-pointer identity + len of the highlight Arc that produced this.
    hl_key: (usize, usize),
    lines: Vec<(SharedString, Vec<TextRun>)>,
}

impl RenderCache {
    /// Drop every cached entry for `row`.
    pub fn invalidate_row(&mut self, row: &str) {
        self.flats.retain(|(r, _, _), _| r.as_ref() != row);
        self.code.retain(|(r, _, _), _| r.as_ref() != row);
    }

    pub fn clear(&mut self) {
        self.flats.clear();
        self.code.clear();
    }

    /// Drop every entry if the palette changed since they were shaped. Cheap
    /// enough (one relaxed atomic load) to call on every cache access.
    fn sync_palette(&mut self) {
        let generation = crate::theme::theme_generation();
        if self.generation != generation {
            self.clear();
            self.generation = generation;
        }
    }
}

/// Per-line highlight tokens for a code block, or `None` while pending.
pub type CodeHighlight<'a> = Option<&'a [Vec<Token>]>;

/// Render a whole tree stacked with the md block gap. `highlight` resolves
/// tokens for a top-level block index (code blocks only).
pub fn render_tree(
    tree: &BlockTree,
    opts: &RenderOptions,
    theme: &Theme,
    window: &Window,
    highlight: &dyn Fn(usize) -> Option<std::sync::Arc<Vec<Vec<Token>>>>,
) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .gap(px(MD_BLOCK_GAP))
        .children(tree.blocks.iter().enumerate().map(|(ix, top)| {
            let lines = highlight(ix);
            render_block(
                &top.block,
                ix,
                ix,
                opts,
                theme,
                window,
                lines.as_deref().map(|l| &l[..]),
            )
        }))
        .into_any_element()
}

/// Render one block (top-level or nested). `top_ix` is the enclosing top-level
/// block index (cache invalidation scope); `ix` the per-element discriminator.
#[allow(clippy::too_many_arguments)]
pub fn render_block(
    block: &Block,
    top_ix: usize,
    ix: usize,
    opts: &RenderOptions,
    theme: &Theme,
    window: &Window,
    highlight: CodeHighlight,
) -> AnyElement {
    match block {
        Block::Paragraph { runs } => text_element(
            runs,
            MD_TEXT_SIZE,
            MD_LINE_HEIGHT,
            false,
            top_ix,
            ix,
            opts,
            theme,
        ),
        Block::Heading { level, runs } => {
            let (size, line) = heading_metrics(*level);
            text_element(runs, size, line, true, top_ix, ix, opts, theme)
        }
        Block::CodeBlock { language, code } => render_code_block(
            language.as_deref(),
            code,
            top_ix,
            ix,
            opts,
            theme,
            highlight,
        ),
        Block::Mermaid { code } => render_mermaid(code, top_ix, ix, opts, theme),
        Block::BlockQuote { children } => div()
            // Accent-tinted quote: indigo rail + a whisper of the same hue
            // behind it (the inline-code treatment, dialed down).
            .border_l_2()
            .border_color(theme.accent.opacity(0.6))
            .bg(theme.accent.opacity(0.05))
            .rounded_tr(px(6.0))
            .rounded_br(px(6.0))
            .pl(px(12.0))
            .pr(px(10.0))
            .py(px(6.0))
            .flex()
            .flex_col()
            .gap(px(8.0))
            .text_color(theme.text_muted)
            .children(children.iter().enumerate().map(|(ci, child)| {
                render_block(child, top_ix, ix * 100 + ci, opts, theme, window, None)
            }))
            .into_any_element(),
        Block::List {
            ordered_start,
            items,
        } => div()
            .flex()
            .flex_col()
            .gap(px(4.0))
            .children(items.iter().enumerate().map(|(item_ix, item)| {
                // Accent markers (the inline-code hue): ordered numbers as
                // tinted text, unordered as a REAL 5px disc — the glyph "•"
                // reads too small at 14px.
                let marker: gpui::AnyElement = match ordered_start {
                    Some(start) => div()
                        .flex_none()
                        .min_w(px(18.0))
                        .text_size(px(MD_TEXT_SIZE))
                        .line_height(px(MD_LINE_HEIGHT))
                        .text_color(theme.accent.opacity(0.85))
                        .child(SharedString::from(format!("{}.", start + item_ix as u64)))
                        .into_any_element(),
                    None => div()
                        .flex_none()
                        .min_w(px(18.0))
                        // Center the disc on the first text line's cap band.
                        .h(px(MD_LINE_HEIGHT))
                        .flex()
                        .items_center()
                        .child(
                            div()
                                .ml(px(1.0))
                                .w(px(5.0))
                                .h(px(5.0))
                                .rounded_full()
                                .bg(theme.accent.opacity(0.85)),
                        )
                        .into_any_element(),
                };
                div().flex().flex_row().gap(px(8.0)).child(marker).child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap(px(4.0))
                        .children(item.iter().enumerate().map(|(ci, child)| {
                            render_block(
                                child,
                                top_ix,
                                ix * 100 + item_ix * 10 + ci,
                                opts,
                                theme,
                                window,
                                None,
                            )
                        })),
                )
            }))
            .into_any_element(),
        Block::Table {
            header,
            rows,
            align,
        } => render_table(header, rows, align, top_ix, ix, opts, theme, window),
        Block::Rule => div()
            .h(px(1.0))
            .w_full()
            .bg(theme.border)
            .into_any_element(),
        Block::Visualization { doc } => {
            render_visualization(doc, top_ix, ix, opts, theme)
        }
    }
}

/// Tight monochrome heading scale (comet: h2 ≈ 16px semibold; headings step
/// down quickly toward body size).
fn heading_metrics(level: u8) -> (f32, f32) {
    match level {
        1 => (19.0, 27.0),
        2 => (16.0, 24.0),
        3 => (15.0, 22.0),
        _ => (14.0, 22.0),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MermaidDirection {
    TopDown,
    LeftRight,
}

#[derive(Debug, PartialEq, Eq)]
struct MermaidEdge {
    from: String,
    to: String,
    label: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
struct MermaidFlowchart {
    direction: MermaidDirection,
    nodes: Vec<(String, String)>,
    edges: Vec<MermaidEdge>,
}

/// Parse the useful, portable subset of Mermaid flowcharts. Mermaid's browser
/// runtime is not available in the native client, so diagrams are deliberately
/// parsed locally and rendered with GPUI elements. Unsupported diagram kinds
/// retain their source in the diagram card rather than being silently dropped.
fn parse_mermaid_flowchart(source: &str) -> Option<MermaidFlowchart> {
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

fn split_mermaid_edge(statement: &str) -> Option<(&str, &str)> {
    // Check longer arrows first, so `-.->` does not get mistaken for `->`.
    ["-->", "==>", "-.->", "---"]
        .iter()
        .filter_map(|arrow| statement.find(arrow).map(|at| (at, arrow.len())))
        .min_by_key(|(at, _)| *at)
        .map(|(at, len)| (statement[..at].trim(), statement[at + len..].trim()))
}

fn mermaid_node(raw: &str) -> (String, String) {
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

fn add_mermaid_node(nodes: &mut Vec<(String, String)>, id: String, label: String) {
    if let Some((_, existing_label)) = nodes.iter_mut().find(|(existing, _)| *existing == id) {
        if existing_label == &id && label != id {
            *existing_label = label;
        }
    } else {
        nodes.push((id, label));
    }
}

fn mermaid_images() -> &'static Mutex<HashMap<String, Arc<Image>>> {
    static IMAGES: OnceLock<Mutex<HashMap<String, Arc<Image>>>> = OnceLock::new();
    IMAGES.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Default)]
struct MermaidViewer {
    zoom: f32,
    drag_anchor: Option<gpui::Point<gpui::Pixels>>,
    scroll: ScrollHandle,
}

thread_local! {
    static MERMAID_VIEWERS: RefCell<HashMap<String, MermaidViewer>> = RefCell::new(HashMap::new());
}

fn mermaid_viewer(key: &str) -> (f32, ScrollHandle) {
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

fn set_mermaid_zoom(key: &str, change: f32) {
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
fn mermaid_wheel_zoom(delta: gpui::ScrollDelta) -> f32 {
    let y = match delta {
        gpui::ScrollDelta::Pixels(delta) => f32::from(delta.y) / 240.0,
        gpui::ScrollDelta::Lines(delta) => delta.y / 12.0,
    };
    (-y).clamp(-0.25, 0.25)
}

/// Render Mermaid source with `mermaid-rs-renderer` to a native SVG image.
/// The cache keeps streaming transcript frames from recomputing layout.
fn render_mermaid(
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
        return mermaid_image_card(image, viewer_key, source, ix, opts.mermaid.clone());
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
    mermaid_image_card(image, viewer_key, source, ix, opts.mermaid.clone())
}

fn mermaid_image_card(
    image: Arc<Image>,
    viewer_key: String,
    source: &str,
    ix: usize,
    ui: Option<MermaidUi>,
) -> AnyElement {
    let (zoom, scroll) = mermaid_viewer(&viewer_key);
    let zoom_button = |label: &'static str, change: f32| {
        let key = viewer_key.clone();
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
    let pan_key = viewer_key.clone();
    let drag_key = viewer_key.clone();
    let release_key = viewer_key.clone();
    let wheel_key = viewer_key.clone();
    let pinch_key = viewer_key.clone();
    // Copy + Open-full-screen affordances (mirrors the code-block copy button:
    // a small ghost icon button in the card's top-right, beside the zoom
    // controls). `None` (previews outside the transcript) renders neither.
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
    div()
        .relative()
        .rounded(px(10.0))
        .border_1()
        .border_color(crate::theme::white_alpha(0.14))
        .bg(crate::theme::white_alpha(0.035))
        .overflow_hidden()
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
                .child(zoom_button("in", 0.25))
                .children(expand_button)
                .children(copy_button),
        )
        .into_any_element()
}

#[allow(dead_code)]
fn render_mermaid_fallback(source: &str, theme: &Theme) -> AnyElement {
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
    // the inline card (and vice versa).
    let viewer_key = "mermaid-fullscreen".to_string();
    let card = mermaid_image_card(image, viewer_key, source, 0, None);
    // Strip the inline card's max-height cap so the modal can use the full
    // viewport — wrap in a sized container instead.
    let max_h = px(f32::from(viewport.height) * 0.86);
    let max_w = px(f32::from(viewport.width) * 0.92);
    let container = div()
        .max_w(max_w)
        .max_h(max_h)
        .child(card);
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

/// Render a [`VizDocument`] as native GPUI elements. The element graph is
/// resolved recursively from the root; each component type maps to a styled
/// `div`/text element. Unknown types render a muted fallback.
fn render_visualization(
    doc: &VizDocument,
    top_ix: usize,
    ix: usize,
    _opts: &RenderOptions,
    theme: &Theme,
) -> AnyElement {
    let Some(root) = doc.elements.get(&doc.root) else {
        return gpui::Empty.into_any_element();
    };
    let el = render_viz_element(root, doc, top_ix, ix, theme);
    // Allow horizontal scroll for wide content (e.g. row Boxes with many
    // children) instead of clipping. Each viz block needs a unique id for
    // GPUI's scroll handle.
    let scroll_id: SharedString = format!("viz-root-{top_ix}-{ix}").into();
    div()
        .id(scroll_id)
        .overflow_x_scroll()
        .child(el)
        .into_any_element()
}

/// Resolve one visualization element to a GPUI element, recursing into children.
fn render_viz_element(
    el: &VizElement,
    doc: &VizDocument,
    top_ix: usize,
    child_ix: usize,
    theme: &Theme,
) -> AnyElement {
    let children: Vec<AnyElement> = el
        .children
        .iter()
        .enumerate()
        .filter_map(|(ci, cid)| {
            let child = doc.elements.get(cid)?;
            Some(render_viz_element(
                child,
                doc,
                top_ix,
                child_ix * 100 + ci,
                theme,
            ))
        })
        .collect();

    match el.ty.as_str() {
        "Box" => render_viz_box(&el.props, children, child_ix, theme),
        "Text" => render_viz_text(&el.props, theme),
        "Heading" => render_viz_heading(&el.props, theme),
        "Card" => render_viz_card(&el.props, children, theme),
        "BarChart" => render_viz_bar_chart(&el.props, theme),
        "Sparkline" => render_viz_sparkline(&el.props, theme),
        "Table" => render_viz_table(&el.props, top_ix, child_ix, theme),
        "Divider" => render_viz_divider(&el.props, theme),
        "List" => render_viz_list(&el.props, theme),
        "Newline" => div().h(px(8.0)).flex_none().into_any_element(),
        "Spacer" => div().flex_1().into_any_element(),
        "StatusLine" => render_viz_status_line(&el.props, theme),
        "KeyValue" => render_viz_key_value(&el.props, theme),
        "Badge" => render_viz_badge(&el.props, theme),
        "ProgressBar" => render_viz_progress_bar(&el.props, theme),
        "Metric" => render_viz_metric(&el.props, theme),
        "Callout" => render_viz_callout(&el.props, theme),
        "Timeline" => render_viz_timeline(&el.props, theme),
        _ => div()
            .text_size(px(MD_TEXT_SIZE))
            .text_color(theme.text_muted)
            .child(SharedString::from(format!("[unknown: {}]", el.ty)))
            .into_any_element(),
    }
}

// -- helpers --

fn viz_str(val: Option<&serde_json::Value>, fallback: &str) -> String {
    match val {
        Some(serde_json::Value::String(s)) => s.clone(),
        _ => fallback.to_string(),
    }
}

fn viz_num(val: Option<&serde_json::Value>, fallback: f64) -> f64 {
    match val {
        Some(serde_json::Value::Number(n)) => n.as_f64().unwrap_or(fallback),
        _ => fallback,
    }
}

fn viz_bool(val: Option<&serde_json::Value>, fallback: bool) -> bool {
    match val {
        Some(serde_json::Value::Bool(b)) => *b,
        _ => fallback,
    }
}

fn viz_px(val: f64) -> gpui::Pixels {
    px(val as f32)
}

/// Parse a CSS-like color string ("#hex", "rgb(...)", or a named theme color)
/// into a theme-compatible Hsla. Unknown values fall back to `theme.text`.
fn viz_color(val: Option<&serde_json::Value>, fallback: Hsla, theme: &Theme) -> Hsla {
    let Some(serde_json::Value::String(s)) = val else {
        return fallback;
    };
    if let Some(stripped) = s.strip_prefix('#') {
        return hex_to_hsla(stripped).unwrap_or(fallback);
    }
    // Named theme colors.
    match s.as_str() {
        "accent" | "primary" => theme.accent,
        "text" => theme.text,
        "textMuted" | "muted" => theme.text_muted,
        "danger" | "error" => theme.danger,
        "warning" => theme.warning,
        "success" | "completed" | "green" => theme.success,
        "border" => theme.border,
        "cyan" => {
            gpui::hsla(0.50, 0.67, 0.58, 1.0) // cyan-400
        }
        _ => fallback,
    }
}

/// Parse a hex color string (6 or 3 digits, no leading '#') to Hsla.
fn hex_to_hsla(hex: &str) -> Option<Hsla> {
    let hex = hex.trim();
    let parse_hex = |s: &str| u8::from_str_radix(s, 16).ok();
    let (r, g, b) = if hex.len() == 6 {
        (
            parse_hex(&hex[0..2])?,
            parse_hex(&hex[2..4])?,
            parse_hex(&hex[4..6])?,
        )
    } else if hex.len() == 3 {
        let expand = |c: u8| parse_hex(&format!("{}{}", c, c));
        (
            expand(hex.as_bytes()[0])?,
            expand(hex.as_bytes()[1])?,
            expand(hex.as_bytes()[2])?,
        )
    } else {
        return None;
    };
    let (h, s, l) = crate::theme::rgb_to_hsl(
        r as f32 / 255.0,
        g as f32 / 255.0,
        b as f32 / 255.0,
    );
    Some(gpui::hsla(h, s, l, 1.0))
}

// -- components --

fn render_viz_box(
    props: &serde_json::Map<String, serde_json::Value>,
    children: Vec<AnyElement>,
    child_ix: usize,
    _theme: &Theme,
) -> AnyElement {
    let is_row = viz_str(props.get("flexDirection"), "column") == "row";
    let padding = viz_num(props.get("padding"), 0.0);
    let gap = viz_num(props.get("gap"), 0.0);
    let mut el = div().flex();
    if is_row {
        el = el.flex_row().flex_none();
    } else {
        el = el.flex_col();
    }
    el = el
        .when(padding > 0.0, |el| el.p(viz_px(padding)))
        .when(gap > 0.0, |el| el.gap(viz_px(gap)));
    let inner = el.children(children);

    if is_row {
        // Wrap in a horizontal scroll container so wide rows are scrollable
        // rather than overflowing / being clipped by ancestors.
        let scroll_id: SharedString = format!("viz-box-{child_ix}").into();
        div()
            .id(scroll_id)
            .overflow_x_scroll()
            .child(inner)
            .into_any_element()
    } else {
        inner.into_any_element()
    }
}

fn render_viz_text(
    props: &serde_json::Map<String, serde_json::Value>,
    theme: &Theme,
) -> AnyElement {
    let text = viz_str(props.get("text"), "");
    let bold = viz_bool(props.get("bold"), false);
    let color = viz_color(props.get("color"), theme.text, theme);
    let weight = if bold {
        FontWeight::SEMIBOLD
    } else {
        FontWeight::NORMAL
    };
    div()
        .text_size(px(14.0))
        .line_height(px(MD_LINE_HEIGHT))
        .text_color(color)
        .when(bold, |el| el.font_weight(weight))
        .child(SharedString::from(text))
        .into_any_element()
}

fn render_viz_heading(
    props: &serde_json::Map<String, serde_json::Value>,
    theme: &Theme,
) -> AnyElement {
    let text = viz_str(props.get("text"), "");
    let level = viz_num(props.get("level"), 2.0) as u8;
    let (size, line) = heading_metrics(level);
    div()
        .text_size(px(size))
        .line_height(px(line))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(theme.text)
        .child(SharedString::from(text))
        .into_any_element()
}

fn render_viz_card(
    props: &serde_json::Map<String, serde_json::Value>,
    children: Vec<AnyElement>,
    theme: &Theme,
) -> AnyElement {
    let title = viz_str(props.get("title"), "");
    let padding = viz_num(props.get("padding"), 12.0);
    let mut el = div()
        .rounded(px(10.0))
        .border_1()
        .border_color(theme.border)
        .bg(theme.surface_raised.opacity(0.5))
        .p(viz_px(padding))
        .gap(px(8.0))
        .flex()
        .flex_col();
    if !title.is_empty() {
        el = el.child(
            div()
                .font_weight(FontWeight::SEMIBOLD)
                .text_size(px(14.0))
                .text_color(theme.text)
                .child(SharedString::from(title)),
        );
    }
    el.children(children).into_any_element()
}

fn render_viz_bar_chart(
    props: &serde_json::Map<String, serde_json::Value>,
    theme: &Theme,
) -> AnyElement {
    let Some(serde_json::Value::Array(items)) = props.get("data") else {
        return gpui::Empty.into_any_element();
    };
    let data: Vec<(String, f64, Hsla)> = items
        .iter()
        .filter_map(|item| {
            let obj = item.as_object()?;
            let label = viz_str(obj.get("label"), "");
            let value = viz_num(obj.get("value"), 0.0);
            let color = viz_color(obj.get("color"), theme.accent, theme);
            Some((label, value, color))
        })
        .collect();
    if data.is_empty() {
        return gpui::Empty.into_any_element();
    }
    let max_val = data.iter().map(|(_, v, _)| *v).fold(0.0f64, |a, b| a.max(b)).max(0.001);
    let show_pct = viz_bool(props.get("showPercentage"), false);
    let mut col = div().flex().flex_col().gap(px(8.0));
    for (label, value, color) in &data {
        let frac = (*value / max_val) as f32;
        let pct = (frac * 100.0).round() as i32;
        let bar_w = (frac * 100.0).max(2.0) as f32;
        let val_str = if show_pct {
            format!("{}%", pct)
        } else {
            format_num(*value)
        };
        col = col.child(
            div()
                .flex()
                .flex_col()
                .gap(px(3.0))
                .child(
                    div()
                        .text_size(px(11.0))
                        .text_color(theme.text_muted)
                        .child(SharedString::from(label.clone())),
                )
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(8.0))
                        .child(
                            div()
                                .h(px(18.0))
                                .w(relative(bar_w as f32))
                                .rounded(px(4.0))
                                .bg(*color),
                        )
                        .child(
                            div()
                                .text_size(px(12.0))
                                .text_color(theme.text)
                                .child(SharedString::from(val_str)),
                        ),
                ),
        );
    }
    col.into_any_element()
}

fn format_num(v: f64) -> String {
    if v.abs() >= 100.0 {
        format!("{:.0}", v)
    } else if v.abs() >= 10.0 {
        format!("{:.1}", v)
    } else {
        format!("{:.2}", v)
    }
}

fn render_viz_sparkline(
    props: &serde_json::Map<String, serde_json::Value>,
    theme: &Theme,
) -> AnyElement {
    let Some(serde_json::Value::Array(arr)) = props.get("data") else {
        return gpui::Empty.into_any_element();
    };
    let data: Vec<f64> = arr.iter().filter_map(|v| v.as_f64()).collect();
    if data.len() < 2 {
        return gpui::Empty.into_any_element();
    }
    let color = viz_color(props.get("color"), theme.accent, theme);
    let max = data.iter().fold(0.0f64, |a, &b| a.max(b));
    let min = data.iter().fold(f64::INFINITY, |a, &b| a.min(b));
    let range = (max - min).max(0.001);
    let bar_w = 3.0f32;
    let gap = 2.0f32;
    let h = 28.0f32;
    let mut row = div()
        .flex()
        .flex_row()
        .items_end()
        .h(px(h))
        .gap(px(gap));
    for v in &data {
        let frac = ((v - min) / range) as f32;
        row = row.child(
            div()
                .w(px(bar_w))
                .h(px((frac * h).max(1.0)))
                .rounded(px(1.0))
                .bg(color),
        );
    }
    row.into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn render_viz_table(
    props: &serde_json::Map<String, serde_json::Value>,
    _top_ix: usize,
    ix: usize,
    theme: &Theme,
) -> AnyElement {
    let Some(serde_json::Value::Array(cols_arr)) = props.get("columns") else {
        return gpui::Empty.into_any_element();
    };
    let columns: Vec<(String, String, Option<f64>)> = cols_arr
        .iter()
        .filter_map(|c| {
            let obj = c.as_object()?;
            let header = viz_str(obj.get("header"), "");
            let key = viz_str(obj.get("key"), "");
            let width = obj.get("width").and_then(|v| v.as_f64());
            Some((header, key, width))
        })
        .collect();
    if columns.is_empty() {
        return gpui::Empty.into_any_element();
    }
    let rows: Vec<&serde_json::Map<String, serde_json::Value>> = props
        .get("rows")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|r| r.as_object()).collect())
        .unwrap_or_default();
    let header_color = viz_color(props.get("headerColor"), theme.accent, theme);

    let scroll_id: SharedString = format!("viz-table-{ix}").into();
    let mut inner = div().flex().flex_col();
    // Header row
    let mut header_row = div().flex().flex_row();
    for (hdr, _key, width) in &columns {
        let mut cell = div()
            .p(px(10.0))
            .text_size(px(12.0))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(theme.text)
            .border_b_2()
            .border_color(header_color.opacity(0.5));
        if let Some(w) = width {
            cell = cell.min_w(viz_px(*w));
        } else {
            cell = cell.min_w(px(60.0));
        }
        header_row = header_row.child(cell.child(SharedString::from(hdr.clone())));
    }
    inner = inner.child(header_row);
    // Data rows
    for row in &rows {
        let mut row_el = div()
            .flex()
            .flex_row()
            .border_t_1()
            .border_color(theme.border);
        for (_hdr, key, width) in &columns {
            let val = row
                .get(key)
                .map(|v| match v {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Number(n) => n.to_string(),
                    serde_json::Value::Bool(b) => b.to_string(),
                    serde_json::Value::Null => String::new(),
                    other => other.to_string(),
                })
                .unwrap_or_default();
            let mut cell = div()
                .p(px(10.0))
                .text_size(px(12.0))
                .text_color(theme.text);
            if let Some(w) = width {
                cell = cell.min_w(viz_px(*w));
            } else {
                cell = cell.min_w(px(60.0));
            }
            row_el = row_el.child(cell.child(SharedString::from(val)));
        }
        inner = inner.child(row_el);
    }
    div()
        .id(scroll_id)
        .overflow_x_scroll()
        .child(inner)
        .into_any_element()
}

fn render_viz_divider(
    props: &serde_json::Map<String, serde_json::Value>,
    theme: &Theme,
) -> AnyElement {
    let title = viz_str(props.get("title"), "");
    if title.is_empty() {
        return div()
            .h(px(1.0))
            .w_full()
            .bg(theme.border)
            .my(px(4.0))
            .into_any_element();
    }
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .my(px(4.0))
        .child(
            div()
                .text_size(px(11.0))
                .text_color(theme.text_muted)
                .child(SharedString::from(title)),
        )
        .child(div().flex_1().h(px(1.0)).bg(theme.border))
        .into_any_element()
}

fn render_viz_list(
    props: &serde_json::Map<String, serde_json::Value>,
    theme: &Theme,
) -> AnyElement {
    let Some(serde_json::Value::Array(items)) = props.get("items") else {
        return gpui::Empty.into_any_element();
    };
    let items: Vec<String> = items
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect();
    if items.is_empty() {
        return gpui::Empty.into_any_element();
    }
    let ordered = viz_bool(props.get("ordered"), false);
    let mut col = div().flex().flex_col().gap(px(4.0));
    for (i, item) in items.iter().enumerate() {
        let marker = if ordered {
            format!("{}.", i + 1)
        } else {
            "•".to_string()
        };
        col = col.child(
            div()
                .flex()
                .flex_row()
                .gap(px(8.0))
                .items_start()
                .child(
                    div()
                        .flex_none()
                        .text_color(theme.text_muted)
                        .text_size(px(13.0))
                        .child(SharedString::from(marker)),
                )
                .child(
                    div()
                        .flex_1()
                        .text_size(px(13.0))
                        .text_color(theme.text)
                        .child(SharedString::from(item.clone())),
                ),
        );
    }
    col.into_any_element()
}

fn render_viz_status_line(
    props: &serde_json::Map<String, serde_json::Value>,
    theme: &Theme,
) -> AnyElement {
    let text = viz_str(props.get("text"), "");
    let status = viz_str(props.get("status"), "info");
    let color = match status.as_str() {
        "success" | "completed" => theme.success,
        "error" => theme.danger,
        "warning" => theme.warning,
        _ => theme.accent,
    };
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .child(div().w(px(7.0)).h(px(7.0)).rounded(px(3.5)).bg(color))
        .child(
            div()
                .text_size(px(13.0))
                .text_color(theme.text)
                .child(SharedString::from(text)),
        )
        .into_any_element()
}

fn render_viz_key_value(
    props: &serde_json::Map<String, serde_json::Value>,
    theme: &Theme,
) -> AnyElement {
    let label = viz_str(props.get("label"), "");
    let value = viz_str(props.get("value"), "");
    div()
        .flex()
        .flex_row()
        .justify_between()
        .items_center()
        .child(
            div()
                .text_size(px(13.0))
                .text_color(theme.text_muted)
                .child(SharedString::from(label)),
        )
        .child(
            div()
                .text_size(px(13.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.text)
                .child(SharedString::from(value)),
        )
        .into_any_element()
}

fn render_viz_badge(
    props: &serde_json::Map<String, serde_json::Value>,
    theme: &Theme,
) -> AnyElement {
    let label = viz_str(props.get("label"), "");
    let variant = viz_str(props.get("variant"), "default");
    let color = match variant.as_str() {
        "success" => theme.success,
        "error" => theme.danger,
        "warning" => theme.warning,
        _ => theme.accent,
    };
    div()
        .h(px(20.0))
        .px(px(8.0))
        .py(px(3.0))
        .rounded(px(6.0))
        .bg(color.opacity(0.15))
        .text_size(px(11.0))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(color)
        .child(SharedString::from(label))
        .into_any_element()
}

fn render_viz_progress_bar(
    props: &serde_json::Map<String, serde_json::Value>,
    theme: &Theme,
) -> AnyElement {
    let progress = (viz_num(props.get("progress"), 0.0) as f32).clamp(0.0, 1.0);
    let label = viz_str(props.get("label"), "");
    let mut col = div().flex().flex_col().gap(px(4.0));
    if !label.is_empty() {
        col = col.child(
            div()
                .text_size(px(11.0))
                .text_color(theme.text_muted)
                .child(SharedString::from(label)),
        );
    }
    col.child(
        div()
            .h(px(6.0))
            .rounded(px(3.0))
            .bg(theme.border)
            .overflow_hidden()
            .child(
                div()
                    .h_full()
                    .w(relative(progress * 100.0))
                    .bg(theme.accent)
                    .rounded(px(3.0)),
            ),
    )
    .into_any_element()
}

fn render_viz_metric(
    props: &serde_json::Map<String, serde_json::Value>,
    theme: &Theme,
) -> AnyElement {
    let label = viz_str(props.get("label"), "");
    let value = viz_str(props.get("value"), "");
    let trend = viz_str(props.get("trend"), "");
    let trend_color = if trend == "up" {
        theme.success
    } else {
        theme.danger
    };
    let trend_str = if trend == "up" { "↑" } else { "↓" };
    let mut row = div().flex().flex_row().items_baseline().gap(px(4.0));
    row = row.child(
        div()
            .text_size(px(18.0))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(theme.text)
            .child(SharedString::from(value)),
    );
    if trend == "up" || trend == "down" {
        row = row.child(
            div()
                .text_size(px(12.0))
                .text_color(trend_color)
                .child(SharedString::from(trend_str)),
        );
    }
    div()
        .flex()
        .flex_col()
        .gap(px(2.0))
        .child(
            div()
                .text_size(px(11.0))
                .text_color(theme.text_muted)
                .child(SharedString::from(label)),
        )
        .child(row)
        .into_any_element()
}

fn render_viz_callout(
    props: &serde_json::Map<String, serde_json::Value>,
    theme: &Theme,
) -> AnyElement {
    let ty = viz_str(props.get("type"), "info");
    let title = viz_str(props.get("title"), "");
    let content = viz_str(props.get("content"), "");
    let color = match ty.as_str() {
        "success" => theme.success,
        "error" => theme.danger,
        "warning" => theme.warning,
        _ => theme.accent,
    };
    let mut el = div()
        .bg(color.opacity(0.08))
        .border_l_2()
        .border_color(color)
        .rounded(px(6.0))
        .p(px(10.0))
        .gap(px(4.0))
        .flex()
        .flex_col();
    if !title.is_empty() {
        el = el.child(
            div()
                .text_size(px(13.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text)
                .child(SharedString::from(title)),
        );
    }
    if !content.is_empty() {
        el = el.child(
            div()
                .text_size(px(13.0))
                .text_color(theme.text_muted)
                .child(SharedString::from(content)),
        );
    }
    el.into_any_element()
}

fn render_viz_timeline(
    props: &serde_json::Map<String, serde_json::Value>,
    theme: &Theme,
) -> AnyElement {
    let Some(serde_json::Value::Array(items)) = props.get("items") else {
        return gpui::Empty.into_any_element();
    };
    let parsed: Vec<(String, Option<String>, Hsla)> = items
        .iter()
        .filter_map(|item| {
            let obj = item.as_object()?;
            let title = viz_str(obj.get("title"), "");
            let description = obj.get("description").and_then(|v| {
                if let serde_json::Value::String(s) = v {
                    Some(s.clone())
                } else {
                    None
                }
            });
            let status = viz_str(obj.get("status"), "info");
            let color = match status.as_str() {
                "success" | "completed" => theme.success,
                "error" => theme.danger,
                "warning" => theme.warning,
                _ => theme.accent,
            };
            Some((title, description, color))
        })
        .collect();
    if parsed.is_empty() {
        return gpui::Empty.into_any_element();
    }
    let mut col = div().flex().flex_col().gap(px(10.0));
    for (i, (title, desc, dot_color)) in parsed.iter().enumerate() {
        let is_last = i == parsed.len() - 1;
        let mut item_row = div().flex().flex_row().gap(px(10.0));
        let mut rail = div().flex().flex_col().items_center().w(px(12.0));
        rail = rail.child(
            div()
                .w(px(8.0))
                .h(px(8.0))
                .rounded(px(4.0))
                .bg(*dot_color)
                .mt(px(4.0)),
        );
        if !is_last {
            rail = rail.child(div().flex_1().w(px(1.5)).bg(theme.border).mt(px(2.0)));
        }
        item_row = item_row.child(rail);
        let mut text_col = div().flex_1().flex().flex_col();
        text_col = text_col.child(
            div()
                .text_size(px(13.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.text)
                .child(SharedString::from(title.clone())),
        );
        if let Some(d) = desc {
            text_col = text_col.child(
                div()
                    .mt(px(1.0))
                    .text_size(px(12.0))
                    .text_color(theme.text_muted)
                    .child(SharedString::from(d.clone())),
            );
        }
        item_row = item_row.child(text_col);
        col = col.child(item_row);
    }
    col.into_any_element()
}

/// Shared per-column table geometry (port of mugen `tableColumns`).
pub struct TableColumns {
    /// Per-column max-content width, padding included.
    pub naturals: Vec<f32>,
    /// Per-column minimum width, padding included = `min(natural, minColumnWidth)`.
    pub minimums: Vec<f32>,
    /// Σ minimums — the width below which the table stops shrinking and scrolls.
    pub min_table_width: f32,
}

/// Resolve column geometry from measured per-column max-content widths
/// (content only — padding is added here, as the source adds `2 * cellPadding`).
pub fn table_columns(content_widths: &[f32]) -> TableColumns {
    let naturals: Vec<f32> = content_widths
        .iter()
        .map(|w| w.max(TABLE_MIN_COLUMN_CONTENT) + 2.0 * TABLE_CELL_PADDING)
        .collect();
    let minimums: Vec<f32> = naturals
        .iter()
        .map(|n| n.min(TABLE_MIN_COLUMN_WIDTH))
        .collect();
    let min_table_width = minimums.iter().sum();
    TableColumns {
        naturals,
        minimums,
        min_table_width,
    }
}

/// Element/cache discriminator for a table cell (row-major under the block ix).
fn table_cell_ix(ix: usize, r: usize, c: usize) -> usize {
    ix * 100_000 + r * 100 + c
}

/// A GFM table — a port of mugen-markdown's `TableBlock` under comet's md
/// theme (see the `TABLE_*` constants).
///
/// Column widths resolve exactly the way the source's CSS does: each cell is
/// `flex: <max-content> <max-content> 0; min-width: min(max-content, 96px)`,
/// so widths are content-proportional with a readable per-column floor.
/// Naturals come from shaping each cell's runs unwrapped (gpui's line-layout
/// cache makes repeat frames cheap); the flex resolution itself is Taffy's —
/// the same algorithm as the web's. When even the floors no longer fit, the
/// rows overflow the viewport and the table scrolls horizontally instead of
/// crushing every column into per-character wrapping.
#[allow(clippy::too_many_arguments)]
fn render_table(
    header: &[Vec<InlineRun>],
    rows: &[Vec<Vec<InlineRun>>],
    align: &[TableAlign],
    top_ix: usize,
    ix: usize,
    opts: &RenderOptions,
    theme: &Theme,
    window: &Window,
) -> AnyElement {
    // Header row first, mirroring the source's `rows` shape (rows may be ragged).
    let all: Vec<&[Vec<InlineRun>]> = std::iter::once(header)
        .filter(|h| !h.is_empty())
        .map(|h| h as &[Vec<InlineRun>])
        .chain(rows.iter().map(|r| r.as_slice()))
        .collect();
    let cols = all.iter().map(|r| r.len()).max().unwrap_or(0);
    if cols == 0 {
        return gpui::Empty.into_any_element();
    }
    let has_header = !header.is_empty();

    // Flatten every cell (cache-aware) and take per-column max-content widths.
    let text_system = window.text_system();
    let mut flats: Vec<Vec<Option<Rc<FlatText>>>> = Vec::with_capacity(all.len());
    let mut content = vec![0.0f32; cols];
    for (r, row) in all.iter().enumerate() {
        let weight = if has_header && r == 0 {
            TABLE_HEADER_WEIGHT
        } else {
            FontWeight::NORMAL
        };
        let mut out: Vec<Option<Rc<FlatText>>> = Vec::with_capacity(cols);
        for (c, natural) in content.iter_mut().enumerate() {
            let Some(runs) = row.get(c) else {
                out.push(None);
                continue;
            };
            let flat = flatten_cached(runs, weight, top_ix, table_cell_ix(ix, r, c), opts, theme);
            if !flat.text.is_empty() {
                // Cell sources are single-line; guard anyway (same byte count,
                // so the runs still cover the text exactly).
                let line: SharedString = if flat.text.contains('\n') {
                    flat.text.replace('\n', " ").into()
                } else {
                    flat.text.clone()
                };
                let width = f32::from(
                    text_system
                        .shape_line(line, px(MD_TEXT_SIZE), &flat.runs, None)
                        .width(),
                );
                if width > *natural {
                    *natural = width;
                }
            }
            out.push(Some(flat));
        }
        flats.push(out);
    }
    let geo = table_columns(&content);

    // Frameless flat-hairline chrome: 1px rules under the header and between
    // rows are the only paint (`table.gap` = 1, borderColor white@10%); the
    // theme's headerBackground is transparent and its radius 0, so there is no
    // header fill, outer box, or rounding.
    let hairline = table_hairline();
    let mut inner = div()
        .flex()
        .flex_col()
        .w_full()
        .min_w(px(geo.min_table_width));
    for (r, row) in flats.iter().enumerate() {
        if r > 0 {
            inner = inner.child(div().flex_none().h(px(TABLE_DIVIDER)).w_full().bg(hairline));
        }
        let mut row_el = div().flex().flex_row();
        for (c, cell_flat) in row.iter().enumerate() {
            let mut cell = div()
                .flex_grow(geo.naturals[c])
                .flex_shrink(geo.naturals[c])
                .flex_basis(px(0.0))
                .min_w(px(geo.minimums[c]))
                .p(px(TABLE_CELL_PADDING))
                .text_size(px(MD_TEXT_SIZE))
                .line_height(px(MD_LINE_HEIGHT));
            cell = match align.get(c).copied().unwrap_or_default() {
                TableAlign::Left => cell,
                TableAlign::Center => cell.text_center(),
                TableAlign::Right => cell.text_right(),
            };
            if let Some(flat) = cell_flat {
                cell = cell.child(flat_text_element(
                    flat,
                    table_cell_ix(ix, r, c),
                    opts,
                    theme,
                ));
            }
            row_el = row_el.child(cell);
        }
        inner = inner.child(row_el);
    }

    // The horizontal scroller — when the floors exceed the viewport the inner
    // block keeps `min_table_width` and this viewport scrolls it.
    let scroll_id: SharedString = format!("{}-table{ix}", opts.row_key).into();
    div()
        .id(scroll_id)
        .w_full()
        .overflow_x_scroll()
        .child(inner)
        .into_any_element()
}

/// Flattened inline runs: one string + gpui `TextRun`s + clickable link ranges
/// + inline-code ranges (their rounded washes are painted by a canvas UNDER
/// the text — `TextRun::background_color` can only paint square boxes).
/// `text` is a `SharedString` so cached reuse across frames is an Arc clone.
pub struct FlatText {
    pub text: SharedString,
    pub runs: Vec<TextRun>,
    pub links: Vec<(Range<usize>, String)>,
    pub code_ranges: Vec<Range<usize>>,
}

/// Inline-code tint (round 9): the original is neutral (chat-view.tsx mdTheme
/// `inlineCode: #f0f0f0 on white/8%`), but the user asked for "a nice purple"
/// — violet-300 text over a violet-400 wash, readable on the #060606 panel.
pub fn inline_code_text(theme: &Theme) -> Hsla {
    theme.code_text // violet-300
}
pub fn inline_code_wash(theme: &Theme) -> Hsla {
    theme.code_wash // violet-400/12
}
/// Rounded-wash geometry: small radius on a slightly inset box (paint-only —
/// x extends 2px past the glyphs, y insets 2px from the 22px line box).
pub const INLINE_CODE_RADIUS: f32 = 4.5;
pub const INLINE_CODE_PAD_X: f32 = 2.0;
pub const INLINE_CODE_INSET_Y: f32 = 2.0;

/// Flatten inline runs into shaped-text inputs. Pure given a theme.
pub fn flatten_runs(runs: &[InlineRun], theme: &Theme, bold_default: bool) -> FlatText {
    flatten_runs_weighted(
        runs,
        theme,
        if bold_default {
            FontWeight::SEMIBOLD
        } else {
            FontWeight::NORMAL
        },
    )
}

/// [`flatten_runs`] with an explicit base weight (table headers are 700 per
/// comet's `table.headerWeight`; strong runs never drop below semibold).
fn flatten_runs_weighted(runs: &[InlineRun], theme: &Theme, base_weight: FontWeight) -> FlatText {
    let mut text = String::new();
    let mut out: Vec<TextRun> = Vec::with_capacity(runs.len());
    let mut links: Vec<(Range<usize>, String)> = Vec::new();
    let mut code_ranges: Vec<Range<usize>> = Vec::new();
    for run in runs {
        if run.text.is_empty() {
            continue;
        }
        let start = text.len();
        text.push_str(&run.text);
        let mut f = if run.style.code {
            font(theme.font_mono.clone())
        } else {
            font(theme.font_sans.clone())
        };
        f.weight = if run.style.bold && base_weight.0 < FontWeight::SEMIBOLD.0 {
            FontWeight::SEMIBOLD
        } else {
            base_weight
        };
        f.style = if run.style.italic {
            FontStyle::Italic
        } else {
            FontStyle::Normal
        };
        // Links stay monochrome — foreground with an underline (comet's md
        // theme underlines in the text color; indigo is reserved for primary
        // actions).
        let is_link = run.style.link.is_some();
        // Inline code reads violet (see `inline_code_text`); everything else
        // stays the monochrome foreground.
        let color = if run.style.code {
            inline_code_text(theme)
        } else {
            theme.text
        };
        if run.style.code {
            // Merge adjacent code runs into one wash box (like links below).
            match code_ranges.last_mut() {
                Some(range) if range.end == start => range.end = text.len(),
                _ => code_ranges.push(start..text.len()),
            }
        }
        if let Some(url) = &run.style.link {
            // A still-streaming link (mend.rs sentinel) keeps link styling —
            // so the URL's completion changes nothing visually — but is not
            // clickable until the real destination exists.
            if url != super::mend::PENDING_LINK_URL {
                // Merge adjacent runs of the same link into one clickable range.
                match links.last_mut() {
                    Some((range, last_url)) if range.end == start && last_url == url => {
                        range.end = text.len();
                    }
                    _ => links.push((start..text.len(), url.clone())),
                }
            }
        }
        out.push(TextRun {
            len: run.text.len(),
            font: f,
            color,
            // Inline code's wash is painted as ROUNDED quads by the canvas
            // underlay (`code_wash_underlay`) — a run background here could
            // only be a square box.
            background_color: None,
            underline: is_link.then_some(UnderlineStyle {
                color: Some(theme.text_muted),
                thickness: px(1.0),
                wavy: false,
            }),
            strikethrough: run.style.strikethrough.then_some(gpui::StrikethroughStyle {
                thickness: px(1.0),
                color: Some(theme.text_muted),
            }),
        });
    }
    FlatText {
        text: text.into(),
        runs: out,
        links,
        code_ranges,
    }
}

/// Flatten through the cross-frame cache when one is wired: settled blocks
/// reuse text + runs untouched (O(1) per block per frame); only blocks the
/// incremental parser invalidated rebuild.
fn flatten_cached(
    runs: &[InlineRun],
    base_weight: FontWeight,
    top_ix: usize,
    ix: usize,
    opts: &RenderOptions,
    theme: &Theme,
) -> Rc<FlatText> {
    match &opts.cache {
        Some(cache) => {
            let mut cache = cache.borrow_mut();
            cache.sync_palette();
            cache
                .flats
                .entry((opts.row_key.clone(), top_ix, ix))
                .or_insert_with(|| Rc::new(flatten_runs_weighted(runs, theme, base_weight)))
                .clone()
        }
        None => Rc::new(flatten_runs_weighted(runs, theme, base_weight)),
    }
}

/// Veiled, clickable text for a flattened block (no sizing wrapper).
fn flat_text_element(
    flat: &FlatText,
    ix: usize,
    opts: &RenderOptions,
    theme: &Theme,
) -> AnyElement {
    // Streaming veil: opacity-only recolor of the runs covering newly appended
    // chunks. Same text, same fonts, same lengths — layout is untouched.
    // Settled elements return no spans and reuse the cached runs unsplit.
    let text_runs = match &opts.veil {
        Some(veil) => {
            let spans = veil.borrow_mut().advance(ix, &flat.text, opts.now);
            apply_veil(flat.runs.clone(), &spans)
        }
        None => flat.runs.clone(),
    };
    let styled = StyledText::new(flat.text.clone()).with_runs(text_runs);
    let layout = styled.layout().clone();
    let text_el: AnyElement = if flat.links.is_empty() {
        styled.into_any_element()
    } else {
        let (ranges, urls): (Vec<_>, Vec<_>) = flat.links.iter().cloned().unzip();
        let id: SharedString = format!("{}-t{ix}", opts.row_key).into();
        InteractiveText::new(id, styled)
            .on_click(ranges, move |clicked_ix, _window, cx| {
                if let Some(url) = urls.get(clicked_ix) {
                    cx.open_url(url);
                }
            })
            .into_any_element()
    };
    // Underlay canvas: inline-code washes + the selection wash, painted
    // BEFORE the text (earlier sibling ⇒ underneath), reading glyph geometry
    // from the text's own layout handle. Pure paint — never in layout. The
    // same paint pass re-registers the frame-scoped window mouse listeners
    // that drive text selection (round 18; see markdown/selection.rs).
    let sel_key: std::sync::Arc<str> = format!("{}:{ix}", opts.row_key).into();
    let code_ranges = flat.code_ranges.clone();
    let flat_text = flat.text.clone();
    let wash = inline_code_wash(theme);
    let sel_wash = selection_wash(theme);
    let underlay = canvas(
        |_, _, _| (),
        move |_, _, window, _| {
            for range in &code_ranges {
                for rect in range_rects(&layout, range, INLINE_CODE_PAD_X, INLINE_CODE_INSET_Y) {
                    window.paint_quad(quad(
                        rect,
                        px(INLINE_CODE_RADIUS),
                        wash,
                        px(0.0),
                        gpui::transparent_black(),
                        BorderStyle::default(),
                    ));
                }
            }
            if let Some(range) = super::selection::wash_range(&sel_key) {
                for rect in range_rects(&layout, &range, 0.0, 0.0) {
                    window.paint_quad(quad(
                        rect,
                        px(0.0),
                        sel_wash,
                        px(0.0),
                        gpui::transparent_black(),
                        BorderStyle::default(),
                    ));
                }
            }
            // Register this element into the frame's document-ordered
            // registry (paint order IS document order), then the frame's
            // mouse listeners.
            REGISTRY.with(|r| {
                r.borrow_mut().push(RegEntry {
                    key: sel_key.clone(),
                    text: flat_text.clone(),
                    layout: layout.clone(),
                })
            });
            register_selection_listeners(window, &sel_key, &flat_text, &layout);
        },
    )
    .absolute()
    .size_full();
    div()
        .relative()
        .child(underlay)
        .child(text_el)
        .into_any_element()
}

/// Selection tint: the accent hue under the glyphs, dark-panel strength.
fn selection_wash(theme: &Theme) -> Hsla {
    theme.accent.opacity(0.35) // indigo-400
}

/// One painted text element, registered per frame in document order — the
/// continuity model that lets a drag span paragraphs/list items (Zed gets
/// this for free from its single-element markdown; our tree rebuilds it).
struct RegEntry {
    key: std::sync::Arc<str>,
    text: SharedString,
    layout: gpui::TextLayout,
}

thread_local! {
    static REGISTRY: RefCell<Vec<RegEntry>> = const { RefCell::new(Vec::new()) };
}

/// A zero-size canvas that clears the selection registry — paint it FIRST in
/// the transcript root (before any markdown), so each frame's registry holds
/// exactly that frame's visible text elements in paint order.
pub fn selection_frame_reset() -> impl IntoElement {
    canvas(
        |_, _, _| (),
        |_, _, _, _| REGISTRY.with(|r| r.borrow_mut().clear()),
    )
    .absolute()
    .w(px(0.0))
    .h(px(0.0))
}

/// `(element index, byte offset)` for a window position: the registered
/// element whose vertical band contains it, else the nearest by vertical
/// distance (a drag past the gutter or between blocks clamps sensibly).
fn registry_point(position: gpui::Point<gpui::Pixels>) -> Option<(usize, usize)> {
    REGISTRY.with(|r| {
        let reg = r.borrow();
        let mut best: Option<(usize, f32)> = None;
        for (ei, entry) in reg.iter().enumerate() {
            let b = entry.layout.bounds();
            let dy = if position.y < b.top() {
                f32::from(b.top() - position.y)
            } else if position.y > b.bottom() {
                f32::from(position.y - b.bottom())
            } else {
                0.0
            };
            if best.is_none_or(|(_, d)| dy < d) {
                best = Some((ei, dy));
            }
            if dy == 0.0 {
                break;
            }
        }
        let (ei, _) = best?;
        let ix = match reg[ei].layout.index_for_position(position) {
            Ok(ix) | Err(ix) => ix,
        };
        Some((ei, ix))
    })
}

/// Resolve the anchor + head into document-ordered spans over the frame's
/// registry and store them; true if the selection changed.
fn resolve_drag(anchor_key: &str, anchor_ix: usize, head: (usize, usize)) -> bool {
    REGISTRY.with(|r| {
        let reg = r.borrow();
        let Some(anchor_ei) = reg.iter().position(|e| e.key.as_ref() == anchor_key) else {
            return false; // anchor scrolled out of the frame — keep spans
        };
        let elements: Vec<(&str, &str)> = reg
            .iter()
            .map(|e| (e.key.as_ref(), e.text.as_ref()))
            .collect();
        let spans = super::selection::resolve_spans(&elements, (anchor_ei, anchor_ix), head);
        super::selection::update_spans(spans)
    })
}

/// Register this frame's window-level mouse listeners for one text element's
/// selection (Zed-markdown mechanics: window-level so a drag keeps tracking
/// outside the element's bounds; frame-scoped, so paint re-registers).
fn register_selection_listeners(
    window: &mut Window,
    key: &std::sync::Arc<str>,
    text: &SharedString,
    layout: &gpui::TextLayout,
) {
    use gpui::{DispatchPhase, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent};
    {
        let (key, text, layout) = (key.clone(), text.clone(), layout.clone());
        window.on_mouse_event(move |e: &MouseDownEvent, phase, window, _cx| {
            if phase != DispatchPhase::Bubble || e.button != MouseButton::Left {
                return;
            }
            if layout.bounds().contains(&e.position) {
                let ix = match layout.index_for_position(e.position) {
                    Ok(ix) | Err(ix) => ix,
                };
                match e.click_count {
                    2 => {
                        let range = super::selection::word_range(&text, ix);
                        super::selection::begin_with_span(&key, &text, range);
                    }
                    n if n >= 3 => {
                        super::selection::begin_with_span(&key, &text, 0..text.len());
                    }
                    _ => super::selection::begin(&key, ix),
                }
                window.refresh();
            } else if super::selection::clear_if_owner(&key) {
                window.refresh();
            }
        });
    }
    {
        let key = key.clone();
        window.on_mouse_event(move |e: &MouseMoveEvent, phase, window, _cx| {
            if phase != DispatchPhase::Bubble || !e.dragging() {
                return;
            }
            // Only the anchor element's listener drives the drag.
            let Some(anchor_ix) = super::selection::drag_anchor(&key) else {
                return;
            };
            let Some(head) = registry_point(e.position) else {
                return;
            };
            if resolve_drag(&key, anchor_ix, head) {
                window.refresh();
            }
        });
    }
    {
        let key = key.clone();
        window.on_mouse_event(move |_: &MouseUpEvent, phase, _window, _cx| {
            if phase != DispatchPhase::Bubble {
                return;
            }
            if let Some(_text) = super::selection::end_drag(&key) {
                // X11 middle-click paste parity (Zed does the same).
                #[cfg(any(target_os = "linux", target_os = "freebsd"))]
                _cx.write_to_primary(gpui::ClipboardItem::new_string(_text));
            }
        });
    }
}

/// The wash boxes for one byte range: one box per visual line the range
/// covers (soft wraps split it), in window coordinates from the laid-out
/// text's own geometry. `pad_x` overhangs the box horizontally (inline code);
/// `inset_y` shrinks it vertically — both 0 for a selection wash, which wants
/// full-line-height boxes that tile seamlessly across wrapped rows.
pub(crate) fn range_rects(
    layout: &gpui::TextLayout,
    range: &Range<usize>,
    pad_x: f32,
    inset_y: f32,
) -> Vec<Bounds<gpui::Pixels>> {
    let mut rects = Vec::new();
    let line_height = layout.line_height();
    let mut cur = range.start;
    // Walk the range one visual row at a time: find the furthest index that
    // still sits on the current row (binary search over glyph positions).
    let mut guard = 0;
    while cur < range.end && guard < 256 {
        guard += 1;
        let Some(p1) = layout.position_for_index(cur) else {
            break;
        };
        // `seg_end` closes the wash on this row; `next` is the first index on
        // the following row (strict progress even though a row-end index's
        // position still reports the earlier row).
        let (seg_end, next) = match layout.position_for_index(range.end) {
            Some(pe) if pe.y == p1.y => (range.end, range.end),
            _ => {
                // Largest ix on this row (probes stay on char boundaries only
                // at the ends; intermediate probes just need a y).
                let (mut lo, mut hi) = (cur, range.end);
                while hi - lo > 1 {
                    let mid = lo + (hi - lo) / 2;
                    match layout.position_for_index(mid) {
                        Some(pm) if pm.y == p1.y => lo = mid,
                        _ => hi = mid,
                    }
                }
                (lo, hi)
            }
        };
        if let Some(p2) = layout.position_for_index(seg_end)
            && p2.x > p1.x
        {
            rects.push(Bounds::new(
                point(p1.x - px(pad_x), p1.y + px(inset_y)),
                size(
                    p2.x - p1.x + px(2.0 * pad_x),
                    line_height - px(2.0 * inset_y),
                ),
            ));
        }
        if next <= cur {
            break;
        }
        cur = next;
    }
    rects
}

#[allow(clippy::too_many_arguments)]
fn text_element(
    runs: &[InlineRun],
    size: f32,
    line_height: f32,
    bold_default: bool,
    top_ix: usize,
    ix: usize,
    opts: &RenderOptions,
    theme: &Theme,
) -> AnyElement {
    let weight = if bold_default {
        FontWeight::SEMIBOLD
    } else {
        FontWeight::NORMAL
    };
    let flat = flatten_cached(runs, weight, top_ix, ix, opts, theme);
    let inner = flat_text_element(&flat, ix, opts, theme);
    div()
        .text_size(px(size))
        .line_height(px(line_height))
        .child(inner)
        .into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn render_code_block(
    language: Option<&str>,
    code: &str,
    top_ix: usize,
    ix: usize,
    opts: &RenderOptions,
    theme: &Theme,
    highlight: CodeHighlight,
) -> AnyElement {
    let mono = font(theme.font_mono.clone());
    // Per-line strings + runs through the cross-frame cache (validity: code
    // length + highlight slice identity — a fresh highlight Arc re-derives).
    let hl_key = highlight.map_or((0, 0), |h| (h.as_ptr() as usize, h.len()));
    let build = || {
        let lines: Vec<(SharedString, Vec<TextRun>)> = code
            .split('\n')
            .enumerate()
            .map(|(li, line)| {
                let tokens = highlight
                    .and_then(|h| h.get(li))
                    .map(|t| &t[..])
                    .unwrap_or(&[]);
                (
                    SharedString::from(line.to_string()),
                    runs_for_code_line(line, tokens, &mono, theme),
                )
            })
            .collect();
        Rc::new(CachedCode {
            code_len: code.len(),
            hl_key,
            lines,
        })
    };
    let cached: Rc<CachedCode> = match &opts.cache {
        Some(cache) => {
            let mut cache = cache.borrow_mut();
            cache.sync_palette();
            let entry = cache
                .code
                .entry((opts.row_key.clone(), top_ix, ix))
                .or_insert_with(&build);
            if entry.code_len != code.len() || entry.hl_key != hl_key {
                *entry = build();
            }
            entry.clone()
        }
        None => build(),
    };
    // Streaming veil over appended code, tracked on the whole code text and
    // sliced per line below (paint-only run recolor — heights stay exact).
    let veil_spans = match &opts.veil {
        Some(veil) => veil.borrow_mut().advance(ix, code, opts.now),
        None => Vec::new(),
    };
    let scroll_id: SharedString = format!("{}-code{ix}", opts.row_key).into();
    // Copy affordance (round 9; no source counterpart — the original block is
    // header + body only): a small ghost button in the block's top-right,
    // absolutely overlaid so clicking / the "Copied" flash never shifts
    // layout. Sits centered in the header when there is one, floats over the
    // first code line otherwise.
    let copy_button = opts.copy.clone().map(|copy| {
        let copied = copy.copied_ix == Some(ix);
        let code_text: SharedString = code.to_string().into();
        let handler = copy.handler.clone();
        let fade_key = format!("{}-copy{ix}", opts.row_key);
        div()
            .id(SharedString::from(fade_key.clone()))
            .absolute()
            .top(px(3.0))
            .right(px(5.0))
            .h(px(20.0))
            .px(px(6.0))
            .rounded(px(5.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.0))
            .cursor_pointer()
            // Ghost-button hover wash fades over transition-colors like every
            // other interactive chrome (crate::motion hover fades).
            .bg(crate::motion::hover_blend(
                &fade_key,
                gpui::transparent_black(),
                crate::theme::ink(0.08),
            ))
            .on_hover(crate::motion::hover_listener(fade_key))
            .text_size(px(10.5))
            .text_color(theme.text_muted)
            .on_click(move |_, window, cx| handler(ix, code_text.clone(), window, cx))
            .child(
                crate::icons::icon(if copied {
                    crate::icons::CHECK
                } else {
                    crate::icons::COPY
                })
                .size(px(12.0))
                .text_color(theme.text_muted),
            )
            .when(copied, |el| el.child(SharedString::from("Copied")))
    });
    div()
        .rounded(px(10.0))
        // Faint white wash over the near-black panel ≈ #101010 (comet's code
        // surface), with the hairline border.
        .bg(crate::theme::ink(0.035))
        .border_1()
        .border_color(theme.border)
        .overflow_hidden()
        .relative()
        .when_some(language, |el, lang| {
            el.child(
                div()
                    .px(px(CODE_PADDING_X))
                    .py(px(5.0))
                    .border_b_1()
                    .border_color(theme.border)
                    // A whisper of tone separation between header and body.
                    .bg(crate::theme::ink(0.02))
                    .text_size(px(11.0))
                    .text_color(theme.text_muted)
                    .child(SharedString::from(lang.to_string())),
            )
        })
        .child(
            div()
                .id(scroll_id)
                .overflow_x_scroll()
                .px(px(CODE_PADDING_X))
                .py(px(CODE_PADDING_Y))
                .font_family(theme.font_mono.clone())
                .text_size(px(CODE_TEXT_SIZE))
                .line_height(px(CODE_LINE_HEIGHT))
                .whitespace_nowrap()
                .flex()
                .flex_col()
                .children((0..cached.lines.len()).scan(0usize, move |off, li| {
                    let (line, runs) = &cached.lines[li];
                    let start = *off;
                    *off = start + line.len() + 1; // +1 for the '\n'
                    let local = slice_spans(&veil_spans, start, start + line.len());
                    let runs = apply_veil(runs.clone(), &local);
                    Some(
                        div()
                            .h(px(CODE_LINE_HEIGHT))
                            .flex_none()
                            .child(StyledText::new(line.clone()).with_runs(runs)),
                    )
                })),
        )
        // Overlay LAST so it paints above the header/body.
        .children(copy_button)
        .into_any_element()
}

/// Paint color for a token class — the soft syntax palette (round 9: the
/// original's mdTheme code blocks are monochrome `#e7e7e7`, but the user
/// asked for color; these are the diff pane's hues, now shared by both).
pub fn token_color(class: TokenClass, theme: &Theme) -> Hsla {
    match class {
        TokenClass::Keyword => theme.syntax_keyword, // soft rose
        TokenClass::StringLit => theme.syntax_string, // soft green
        TokenClass::Number => theme.syntax_number,   // soft amber
        TokenClass::Comment => theme.text_faint,
    }
}

/// Build the exact-cover `TextRun` list for one code line from its tokens.
/// Same font everywhere — recoloring can never change layout.
pub fn runs_for_code_line(
    line: &str,
    tokens: &[Token],
    mono: &gpui::Font,
    theme: &Theme,
) -> Vec<TextRun> {
    runs_with_palette(line, tokens, mono, theme.text, |class| {
        token_color(class, theme)
    })
}

/// [`runs_for_code_line`] with a caller-supplied palette (the diff pane keys
/// its plain color differently; the hues are shared via [`token_color`]).
pub fn runs_with_palette(
    line: &str,
    tokens: &[Token],
    mono: &gpui::Font,
    plain_color: Hsla,
    color_for: impl Fn(TokenClass) -> Hsla,
) -> Vec<TextRun> {
    let plain = |len: usize| TextRun {
        len,
        font: mono.clone(),
        color: plain_color,
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    let mut runs = Vec::new();
    let mut at = 0usize;
    for token in tokens {
        if token.range.start > at {
            runs.push(plain(token.range.start - at));
        }
        let mut run = plain(token.range.len());
        run.color = color_for(token.class);
        runs.push(run);
        at = token.range.end;
    }
    if at < line.len() {
        runs.push(plain(line.len() - at));
    }
    runs.retain(|r| r.len > 0);
    runs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::highlight::{Lang, tokenize_line};
    use crate::markdown::parser::InlineStyle;

    #[test]
    fn code_line_runs_cover_exactly() {
        let theme = Theme::dark();
        let mono = font(theme.font_mono.clone());
        let line = r#"let x = "hi"; // done"#;
        let (tokens, _) = tokenize_line(Lang::Rust, line, Default::default());
        let runs = runs_for_code_line(line, &tokens, &mono, &theme);
        let total: usize = runs.iter().map(|r| r.len).sum();
        assert_eq!(total, line.len());
        assert!(
            runs.iter().all(|r| r.font == mono),
            "highlight must not change fonts"
        );
        // At least one non-plain color made it through.
        assert!(runs.iter().any(|r| r.color != theme.text));
    }

    #[test]
    fn parses_flowchart_nodes_edges_labels_and_direction() {
        let chart = parse_mermaid_flowchart(
            "flowchart LR\nstart[Start] -->|continues| review{Review}\nreview --> done[Done]",
        )
        .expect("flowchart");
        assert_eq!(chart.direction, MermaidDirection::LeftRight);
        assert_eq!(
            chart.nodes,
            vec![
                ("start".into(), "Start".into()),
                ("review".into(), "Review".into()),
                ("done".into(), "Done".into()),
            ]
        );
        assert_eq!(chart.edges[0].label.as_deref(), Some("continues"));
        assert_eq!(chart.edges[1].from, "review");
        assert_eq!(chart.edges[1].to, "done");
    }

    #[test]
    fn non_flowchart_mermaid_uses_source_fallback() {
        assert!(parse_mermaid_flowchart("sequenceDiagram\nAlice->>Bob: Hi").is_none());
    }

    #[test]
    fn mermaid_renderer_emits_svg_for_sequence_diagrams() {
        let svg = mermaid_rs_renderer::render("sequenceDiagram\nAlice->>Bob: Hi")
            .expect("sequence diagram SVG");
        assert!(svg.contains("<svg"));
    }

    #[test]
    fn mermaid_zoom_is_persistent_and_clamped() {
        let key = "mermaid-zoom-test";
        assert_eq!(mermaid_viewer(key).0, 1.0);
        set_mermaid_zoom(key, 0.25);
        assert_eq!(mermaid_viewer(key).0, 1.25);
        set_mermaid_zoom(key, -10.0);
        assert_eq!(mermaid_viewer(key).0, 0.5);
        set_mermaid_zoom(key, 10.0);
        assert_eq!(mermaid_viewer(key).0, 3.0);
    }

    #[test]
    fn mermaid_wheel_direction_and_speed_are_bounded() {
        assert_eq!(
            mermaid_wheel_zoom(gpui::ScrollDelta::Lines(point(0.0, -3.0))),
            0.25
        );
        assert_eq!(
            mermaid_wheel_zoom(gpui::ScrollDelta::Pixels(point(px(0.0), px(24.0)))),
            -0.1
        );
        assert_eq!(
            mermaid_wheel_zoom(gpui::ScrollDelta::Pixels(point(px(0.0), px(-9_999.0)))),
            0.25
        );
    }

    #[test]
    fn code_line_runs_with_no_tokens_are_one_plain_run() {
        let theme = Theme::dark();
        let mono = font(theme.font_mono.clone());
        let runs = runs_for_code_line("plain text", &[], &mono, &theme);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].len, 10);
    }

    #[test]
    fn flatten_collects_and_merges_inline_code_ranges() {
        let theme = Theme::dark();
        let code = |text: &str| InlineRun {
            text: text.into(),
            style: InlineStyle {
                code: true,
                ..Default::default()
            },
        };
        let plain = |text: &str| InlineRun {
            text: text.into(),
            style: InlineStyle::default(),
        };
        let flat = flatten_runs(
            &[
                plain("use "),
                code("foo"),
                code("()"),
                plain(" and "),
                code("bar"),
            ],
            &theme,
            false,
        );
        // Adjacent code runs merge into ONE wash box; separated ones don't.
        assert_eq!(flat.code_ranges, vec![4..9, 14..17]);
        // Code text is the violet tint; the square run background is gone
        // (the rounded wash is painted by the canvas underlay instead).
        assert_eq!(flat.runs[1].color, inline_code_text(&theme));
        assert_eq!(flat.runs[1].background_color, None);
        assert_eq!(flat.runs[0].color, theme.text);
    }

    #[test]
    fn code_palette_is_colored_and_shared() {
        // Round 9: transcript code blocks paint the soft hues (rose keyword,
        // green string, amber number); comments stay faint neutral.
        let theme = Theme::dark();
        assert_ne!(token_color(TokenClass::Keyword, &theme), theme.text);
        assert_ne!(
            token_color(TokenClass::StringLit, &theme),
            token_color(TokenClass::Keyword, &theme)
        );
        assert_eq!(token_color(TokenClass::Comment, &theme), theme.text_faint);
    }

    #[test]
    fn flatten_runs_maps_links_and_styles() {
        let theme = Theme::dark();
        let runs = vec![
            InlineRun {
                text: "go ".into(),
                style: InlineStyle::default(),
            },
            InlineRun {
                text: "here".into(),
                style: InlineStyle {
                    link: Some("https://x.dev".into()),
                    ..Default::default()
                },
            },
            InlineRun {
                text: " now".into(),
                style: InlineStyle {
                    bold: true,
                    ..Default::default()
                },
            },
        ];
        let flat = flatten_runs(&runs, &theme, false);
        assert_eq!(flat.text, "go here now");
        assert_eq!(flat.links, vec![(3..7, "https://x.dev".to_string())]);
        let total: usize = flat.runs.iter().map(|r| r.len).sum();
        assert_eq!(total, flat.text.len());
        // Links stay monochrome (foreground + underline), never accent-tinted.
        assert_eq!(flat.runs[1].color, theme.text);
        assert!(flat.runs[1].underline.is_some());
        assert_eq!(flat.runs[2].font.weight, FontWeight::SEMIBOLD);
    }

    #[test]
    fn table_columns_floor_and_padding() {
        // A short column keeps its content width (floored at MIN_COLUMN_CONTENT
        // + padding); a wide one may wrap but no narrower than minColumnWidth.
        let geo = table_columns(&[10.0, 200.0]);
        assert_eq!(geo.naturals, vec![72.0, 224.0]); // 48+24, 200+24
        assert_eq!(geo.minimums, vec![72.0, 96.0]);
        assert_eq!(geo.min_table_width, 168.0);
    }

    #[test]
    fn table_columns_are_content_proportional_not_equal() {
        let geo = table_columns(&[300.0, 60.0, 60.0]);
        // Flex grow factors are the naturals — a prose column gets a larger
        // share than short ones (not equal thirds).
        assert!(geo.naturals[0] > 3.0 * geo.naturals[1] * 0.9);
        assert_eq!(geo.naturals[1], geo.naturals[2]);
    }

    #[test]
    fn table_header_flattens_at_weight_700() {
        let theme = Theme::dark();
        let runs = vec![InlineRun {
            text: "Header".into(),
            style: InlineStyle::default(),
        }];
        let flat = flatten_runs_weighted(&runs, &theme, TABLE_HEADER_WEIGHT);
        assert_eq!(flat.runs[0].font.weight, FontWeight::BOLD);
        // Strong runs inside a 700 header stay 700 (never drop to semibold).
        let bold_runs = vec![InlineRun {
            text: "Strong".into(),
            style: InlineStyle {
                bold: true,
                ..Default::default()
            },
        }];
        let flat = flatten_runs_weighted(&bold_runs, &theme, TABLE_HEADER_WEIGHT);
        assert_eq!(flat.runs[0].font.weight, FontWeight::BOLD);
    }

    #[test]
    fn adjacent_same_link_runs_merge_into_one_range() {
        let theme = Theme::dark();
        let style = InlineStyle {
            link: Some("https://x.dev".into()),
            ..Default::default()
        };
        let runs = vec![
            InlineRun {
                text: "bold".into(),
                style: InlineStyle {
                    bold: true,
                    ..style.clone()
                },
            },
            InlineRun {
                text: " tail".into(),
                style,
            },
        ];
        let flat = flatten_runs(&runs, &theme, false);
        assert_eq!(flat.links, vec![(0..9, "https://x.dev".to_string())]);
    }
}

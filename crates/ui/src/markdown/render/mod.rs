//! BlockTree → gpui elements.
//!
//! Numbers drive layout (font sizes, line heights, paddings — all constants
//! here); colors are paint. Code blocks render per-line so their height is
//! exactly `lines × line_height`, and syntax highlighting arrives later as
//! recolored `TextRun`s on the identical mono font — layout never changes
//! (mugen's "highlight is pure paint"). Streaming fade-in is a per-appended-
//! chunk opacity veil over the text runs (see [`super::veil`]) — opacity only,
//! zero translate, applied after layout-relevant properties are fixed.

mod code;
mod inline;
mod mermaid;
mod selection;
mod table;
mod viz;

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Instant;

use gpui::{
    AnyElement, FontWeight, Hsla, SharedString, TextRun, Window, div, prelude::*, px,
};

use crate::theme::Theme;

use crate::markdown::highlight::Token;
use crate::markdown::parser::{Block, BlockTree};
use crate::markdown::veil::RowVeil;

// Submodule functions are re-exported below; no local `use` needed because
// `render_block` lives in this file and uses them via the re-exports.

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
pub(crate) type CodeHighlight<'a> = Option<&'a [Vec<Token>]>;

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
        Block::Visualization { doc } => render_visualization(doc, top_ix, ix, opts, theme),
    }
}

/// Tight monochrome heading scale (comet: h2 ≈ 16px semibold; headings step
/// down quickly toward body size).
pub(crate) fn heading_metrics(level: u8) -> (f32, f32) {
    match level {
        1 => (19.0, 27.0),
        2 => (16.0, 24.0),
        3 => (15.0, 22.0),
        _ => (14.0, 22.0),
    }
}

pub use code::{render_code_block, runs_for_code_line, runs_with_palette, token_color};
pub(crate) use code::text_element;
pub use inline::{FlatText, flat_text_element, flatten_cached, flatten_runs, flatten_runs_weighted};
pub use mermaid::{mermaid_fullscreen, render_mermaid};
pub use selection::{register_selection_listeners, selection_frame_reset, selection_wash};
pub(crate) use selection::range_rects;
pub use table::{TableColumns, render_table, table_cell_ix, table_columns};
pub use viz::render_visualization;


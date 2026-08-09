//! Inline text flattening: pulldown-cmark `InlineRun`s → a flat String +
//! `TextRun`s (with link ranges + inline-code ranges for the canvas wash).

use std::ops::Range;
use std::rc::Rc;

use gpui::{
    AnyElement, BorderStyle, FontStyle, FontWeight, Hsla, InteractiveText, SharedString,
    StyledText, TextRun, UnderlineStyle, canvas, div, font, prelude::*, px, quad,
};

use crate::theme::Theme;
use crate::markdown::parser::InlineRun;
use crate::markdown::veil::apply_veil;

use super::selection::{range_rects, register_selection_listeners, selection_wash, RegEntry, REGISTRY};
use super::RenderOptions;

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
pub fn flatten_runs_weighted(runs: &[InlineRun], theme: &Theme, base_weight: FontWeight) -> FlatText {
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
            if url != crate::markdown::mend::PENDING_LINK_URL {
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
pub fn flatten_cached(
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
pub fn flat_text_element(
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
            if let Some(range) = crate::markdown::selection::wash_range(&sel_key) {
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

//! Code block rendering: per-line layout (height = lines × line_height),
//! highlight as paint-only TextRun colors, copy button, and the shared
//! token-color palette.

use std::rc::Rc;

use gpui::{
    AnyElement, FontWeight, Hsla, SharedString, StyledText, TextRun, div, font, prelude::*, px,
};

use crate::theme::Theme;
use crate::markdown::highlight::{Token, TokenClass};
use crate::markdown::parser::InlineRun;
use crate::markdown::veil::{apply_veil, slice_spans};

use super::inline::{flat_text_element, flatten_cached};
use super::{
    CachedCode, CodeHighlight, RenderOptions, CODE_LINE_HEIGHT, CODE_PADDING_X, CODE_PADDING_Y, CODE_TEXT_SIZE,
};

#[allow(clippy::too_many_arguments)]
pub(crate) fn text_element(
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
pub fn render_code_block(
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
    use super::super::inline::{flatten_runs, flatten_runs_weighted, inline_code_text};
    use super::super::table::table_columns;
    use super::super::TABLE_HEADER_WEIGHT;
    use super::super::mermaid::{
        MermaidDirection, mermaid_viewer, mermaid_wheel_zoom, parse_mermaid_flowchart,
        set_mermaid_zoom,
    };
    use gpui::point;

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

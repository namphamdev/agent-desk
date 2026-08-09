//! Visualization rendering: native GPUI elements for VizDocument graphs
//! (boxes, text, spacers, arrows, columns, rows, trees, flow branches).

use gpui::{AnyElement, FontWeight, Hsla, SharedString, div, prelude::*, px, relative};

use crate::theme::Theme;
use crate::markdown::parser::{VizDocument, VizElement};

use super::RenderOptions;
use super::{MD_LINE_HEIGHT, MD_TEXT_SIZE, heading_metrics};

/// Render a [`VizDocument`] as native GPUI elements. The element graph is
/// resolved recursively from the root; each component type maps to a styled
/// `div`/text element. Unknown types render a muted fallback.
pub fn render_visualization(
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
pub fn render_viz_element(
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

pub fn viz_str(val: Option<&serde_json::Value>, fallback: &str) -> String {
    match val {
        Some(serde_json::Value::String(s)) => s.clone(),
        _ => fallback.to_string(),
    }
}

pub fn viz_num(val: Option<&serde_json::Value>, fallback: f64) -> f64 {
    match val {
        Some(serde_json::Value::Number(n)) => n.as_f64().unwrap_or(fallback),
        _ => fallback,
    }
}

pub fn viz_bool(val: Option<&serde_json::Value>, fallback: bool) -> bool {
    match val {
        Some(serde_json::Value::Bool(b)) => *b,
        _ => fallback,
    }
}

pub fn viz_px(val: f64) -> gpui::Pixels {
    px(val as f32)
}

/// Parse a CSS-like color string ("#hex", "rgb(...)", or a named theme color)
/// into a theme-compatible Hsla. Unknown values fall back to `theme.text`.
pub fn viz_color(val: Option<&serde_json::Value>, fallback: Hsla, theme: &Theme) -> Hsla {
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
pub fn hex_to_hsla(hex: &str) -> Option<Hsla> {
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
    let (h, s, l) = crate::theme::rgb_to_hsl(r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);
    Some(gpui::hsla(h, s, l, 1.0))
}

// -- components --

pub fn render_viz_box(
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

pub fn render_viz_text(
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

pub fn render_viz_heading(
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

pub fn render_viz_card(
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

pub fn render_viz_bar_chart(
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
    let max_val = data
        .iter()
        .map(|(_, v, _)| *v)
        .fold(0.0f64, |a, b| a.max(b))
        .max(0.001);
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

pub fn format_num(v: f64) -> String {
    if v.abs() >= 100.0 {
        format!("{:.0}", v)
    } else if v.abs() >= 10.0 {
        format!("{:.1}", v)
    } else {
        format!("{:.2}", v)
    }
}

pub fn render_viz_sparkline(
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
    let mut row = div().flex().flex_row().items_end().h(px(h)).gap(px(gap));
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
pub fn render_viz_table(
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
            let mut cell = div().p(px(10.0)).text_size(px(12.0)).text_color(theme.text);
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

pub fn render_viz_divider(
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

pub fn render_viz_list(
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

pub fn render_viz_status_line(
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

pub fn render_viz_key_value(
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

pub fn render_viz_badge(
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

pub fn render_viz_progress_bar(
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

pub fn render_viz_metric(
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

pub fn render_viz_callout(
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

pub fn render_viz_timeline(
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


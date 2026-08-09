//! ACP agent logo cache: fetches each agent's `icon` URL (typically an SVG)
//! once, decodes it into a gpui [`Image`], and caches the result keyed by URL
//! so the rail, the tabs, and the settings page all share one decoded copy.
//!
//! Failures (network, decode) are cached as `None` so a broken logo doesn't
//! re-fetch on every render. While a fetch is in flight a per-URL gpui entity
//! is created; concurrent renders for the same URL attach to the same entity,
//! coalescing into a single request.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use gpui::{App, Context, Image, ImageFormat, Task, WeakEntity, img, prelude::*};
use gpui_tokio::Tokio;
use parking_lot::Mutex;

use crate::theme::Theme;

/// The decoded logo for one URL, or `None` once the fetch/decode failed.
type CacheValue = Option<Arc<Image>>;

/// A pending fetch keyed by URL; the entity drives one `Task` that fills the
/// shared cell, and concurrent lookups attach to the same entity.
struct Pending {
    cell: WeakEntity<PendingLogo>,
    _task: Task<()>,
}

static CACHE: LazyLock<Mutex<HashMap<String, CacheValue>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static PENDING: LazyLock<Mutex<HashMap<String, Pending>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// agent id -> icon URL, refreshed from the ACP agents snapshot by the settings
/// page. Lets the rail, tabs, and harness-tab picker resolve a logo from just an
/// agent id (they never hold the snapshot themselves).
static ICON_URLS: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The entity a render subscribes to for a not-yet-resolved logo. Holds the
/// decoded image once the fetch completes; `cx.notify()` re-renders dependents.
pub struct PendingLogo {
    resolved: CacheValue,
}

impl PendingLogo {
    pub fn value(&self) -> CacheValue {
        self.resolved.clone()
    }
}

impl gpui::Render for PendingLogo {
    fn render(
        &mut self,
        _window: &mut gpui::Window,
        _cx: &mut Context<Self>,
    ) -> impl gpui::IntoElement {
        // Never rendered directly — callers read `.value()` and render their own.
        gpui::div()
    }
}

/// The outcome of a logo lookup for rendering: a ready image, a pending fetch
/// (with the entity to observe), or nothing to show.
pub enum Logo {
    Ready(Arc<Image>),
    Pending(WeakEntity<PendingLogo>),
    None,
}

/// Look up a logo by URL. On a cache hit returns `Ready`/`None` immediately.
/// On a miss, kicks off one fetch task (coalesced across callers) and returns
/// `Pending` — renderers observe the returned entity until it resolves (the
/// cache then serves `Ready`/`None`).
pub fn logo(url: &str, cx: &mut App) -> Logo {
    let key = url.to_string();
    if let Some(value) = CACHE.lock().get(&key).cloned() {
        return match value {
            Some(image) => Logo::Ready(image),
            None => Logo::None,
        };
    }
    let mut pending = PENDING.lock();
    if let Some(entry) = pending.get(&key) {
        return Logo::Pending(entry.cell.clone());
    }
    let entity = cx.new(|_| PendingLogo { resolved: None });
    let weak = entity.downgrade();
    let task_weak = entity.downgrade();
    let cell_weak = entity.downgrade();
    let fetch_key = key.clone();
    let task_key = key.clone();
    // reqwest needs the tokio runtime: `Tokio::spawn` runs the fetch on tokio,
    // the outer `cx.spawn` bridges the result back onto gpui's executor.
    let fetch = Tokio::spawn(cx, async move { fetch_logo(&fetch_key).await });
    let task = cx.spawn(async move |cx| {
        let result = fetch.await.unwrap_or(None);
        CACHE.lock().insert(task_key.clone(), result.clone());
        PENDING.lock().remove(&task_key);
        let _ = task_weak.update(cx, |pending, cx| {
            pending.resolved = result;
            cx.notify();
        });
    });
    pending.insert(
        key,
        Pending {
            cell: cell_weak,
            _task: task,
        },
    );
    Logo::Pending(weak)
}

/// Record each agent's icon URL from a fresh ACP agents snapshot. Called by the
/// settings page whenever it loads/refreshes agents so the rail, tabs, and
/// harness-tab picker can resolve logos by agent id. Replaces the table on each
/// call so removed/uninstalled agents don't linger.
pub fn set_agent_icons(installed: &[(&str, Option<&str>)]) {
    let mut urls = ICON_URLS.lock();
    urls.clear();
    for (id, icon) in installed {
        if let Some(icon) = icon.filter(|u| !u.is_empty()) {
            urls.insert((*id).to_string(), icon.to_string());
        }
    }
}

/// The cached icon URL for an ACP agent id, if any. Returns None when the agent
/// has no icon or was never registered.
pub fn agent_icon_url(agent_id: &str) -> Option<String> {
    ICON_URLS.lock().get(agent_id).cloned()
}

/// Look up the logo for an ACP agent by id: resolves the icon URL from the
/// ICON_URLS table, then fetches/decodes it via logo(). Returns Logo::None
/// when no icon URL is registered (e.g. built-in harnesses or agents
/// without a logo), so callers can render a static fallback.
pub fn harness_logo(agent_id: &str, cx: &mut App) -> Logo {
    match agent_icon_url(agent_id) {
        Some(url) => logo(&url, cx),
        None => Logo::None,
    }
}

/// Like [`harness_logo`] but returns the logo only when the harness is ACP and
/// the agent has a registered icon URL. Non-ACP harnesses return `None`, so the
/// static brand icon path is used. This is the entry point for the rail, tabs,
/// and harness-tab picker: they have the harness + agent id and want a logo
/// only for ACP agents that declared an icon.
pub fn harness_logo_for(
    harness: comet_proto::HarnessId,
    acp_agent_id: Option<&str>,
    cx: &mut App,
) -> Option<Logo> {
    if harness == comet_proto::HarnessId::Acp {
        acp_agent_id.map(|id| harness_logo(id, cx))
    } else {
        None
    }
}

/// Fetch + decode a logo URL into an `Image`. Detects format from the URL
/// extension, the Content-Type, then a content sniff.
async fn fetch_logo(url: &str) -> CacheValue {
    let client = reqwest::Client::builder()
        .user_agent(concat!("comet-native/", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()?;
    let response = client.get(url).send().await.ok()?;
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|s| s.to_ascii_lowercase());
    let bytes = response.bytes().await.ok()?.to_vec();
    let format = format_for_logo(url, content_type.as_deref(), &bytes)?;
    Some(Arc::new(Image::from_bytes(format, bytes)))
}

/// Resolve the image format from the URL extension, then the Content-Type,
/// then a content sniff (SVG vs PNG magic bytes). Defaults to SVG — the ACP
/// registry serves logos as SVG, and SVGs lack a Content-Type guarantee on
/// some CDNs.
fn format_for_logo(url: &str, content_type: Option<&str>, bytes: &[u8]) -> Option<ImageFormat> {
    let lower = url.split('?').next().unwrap_or(url).to_ascii_lowercase();
    if lower.ends_with(".svg") {
        return Some(ImageFormat::Svg);
    }
    if lower.ends_with(".png") {
        return Some(ImageFormat::Png);
    }
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        return Some(ImageFormat::Jpeg);
    }
    if lower.ends_with(".webp") {
        return Some(ImageFormat::Webp);
    }
    if lower.ends_with(".gif") {
        return Some(ImageFormat::Gif);
    }
    if let Some(mime) = content_type {
        if mime.contains("svg") {
            return Some(ImageFormat::Svg);
        }
        if mime.contains("png") {
            return Some(ImageFormat::Png);
        }
        if mime.contains("jpeg") || mime.contains("jpg") {
            return Some(ImageFormat::Jpeg);
        }
        if mime.contains("webp") {
            return Some(ImageFormat::Webp);
        }
        if mime.contains("gif") {
            return Some(ImageFormat::Gif);
        }
    }
    // Magic-byte sniff: SVG starts with `<` (after optional whitespace/BOM);
    // PNG starts with its 8-byte signature.
    let trimmed = bytes.iter().take_while(|b| b.is_ascii_whitespace()).count();
    if bytes.get(trimmed).is_some_and(|b| *b == b'<') {
        return Some(ImageFormat::Svg);
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Some(ImageFormat::Png);
    }
    None
}

/// Render a 16×16 brand glyph: the decoded logo when available, else a
/// fallback icon tinted for the surface. Mirrors `crate::icons::icon()` so
/// remote logos and built-in marks align in the same slot.
pub fn brand_glyph(
    logo: Logo,
    fallback_icon: &'static str,
    is_viewed: bool,
    theme: &Theme,
) -> gpui::AnyElement {
    match logo {
        Logo::Ready(image) => img(image)
            .size(gpui::px(16.0))
            .flex_none()
            .into_any_element()
            .into_any_element(),
        Logo::Pending(_) | Logo::None => crate::icons::icon(fallback_icon)
            .size(gpui::px(16.0))
            .flex_none()
            .text_color(if is_viewed {
                theme.text
            } else {
                theme.text_muted
            })
            .into_any_element(),
    }
}

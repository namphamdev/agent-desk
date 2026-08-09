//! Internal entity-state types for the Changes pane (not exported outside
//! the module): the parsed diff cache, per-file fold state + tween arming,
//! and the time-sliced highlight slot.

use std::sync::Arc;
use std::time::Duration;

use gpui::Task;

use crate::markdown::highlight::Token;

use super::patch::FileDiff;

pub(crate) struct ParsedDiff {
    /// `checkout_id:checksum` — identity of the parsed content.
    pub(crate) key: String,
    pub(crate) files: Arc<Vec<FileDiff>>,
}

#[derive(Default, Clone, Copy)]
pub(crate) struct FileFold {
    pub(crate) collapsed: bool,
    /// Bumped per toggle — keys the height tween + chevron transition.
    pub(crate) epoch: usize,
    pub(crate) from: f32,
    pub(crate) to: f32,
    /// When the toggle happened: the tweens are armed only briefly after the
    /// click — gpui replays an element's animation on remount, and in the
    /// virtualized list a row scrolling back into view is a remount (the
    /// transcript's tool groups had the same flash; user report).
    pub(crate) toggled_at: Option<std::time::Instant>,
}

/// Tween arming window after a fold toggle (COLLAPSE's 180ms plus margin).
pub(crate) const FOLD_TWEEN_WINDOW: Duration = Duration::from_millis(400);

impl FileFold {
    pub(crate) fn animating(&self) -> bool {
        self.epoch > 0
            && self
                .toggled_at
                .is_some_and(|at| at.elapsed() < FOLD_TWEEN_WINDOW)
    }
}

pub(crate) struct HighlightSlot {
    pub(crate) fingerprint: u64,
    pub(crate) lines: Option<Arc<Vec<Vec<Token>>>>,
    pub(crate) _task: Option<Task<()>>,
}

/// One-shot `poll_fn` yield so long background loops time-slice fairly with
/// other executor tasks.
pub(crate) async fn yield_now() {
    let mut yielded = false;
    futures::future::poll_fn(move |cx| {
        if yielded {
            std::task::Poll::Ready(())
        } else {
            yielded = true;
            cx.waker().wake_by_ref();
            std::task::Poll::Pending
        }
    })
    .await
}

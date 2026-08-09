//! Background highlight store for code blocks.

use std::collections::HashMap;
use std::sync::Arc;

use gpui::{Context, SharedString, Task};

use crate::markdown::highlight::{Lang, LineCarry, Token, tokenize_line};

use super::Transcript;
pub(super) struct HighlightEntry {
    pub(super) code_len: usize,
    pub(super) lines: Option<Arc<Vec<Vec<Token>>>>,
    pub(super) _task: Option<Task<()>>,
}

/// Cache of tokenized code blocks keyed by `(row id, block ix)`. Tokenization
/// runs on the background executor, time-sliced; results apply as paint-only
/// run colors when they land.
#[derive(Default)]
pub(super) struct HighlightStore {
    pub(super) entries: HashMap<(SharedString, usize), HighlightEntry>,
}

impl HighlightStore {
    /// Current tokens if ready; kicks a background tokenize when stale/missing.
    pub(super) fn request(
        &mut self,
        row_id: SharedString,
        block_ix: usize,
        lang: Lang,
        code: &str,
        cx: &mut Context<Transcript>,
    ) -> Option<Arc<Vec<Vec<Token>>>> {
        let key = (row_id.clone(), block_ix);
        if let Some(entry) = self.entries.get(&key)
            && entry.code_len == code.len()
        {
            return entry.lines.clone();
        }
        // Keep stale lines visible while the fresh parse runs (paint-only, so a
        // briefly stale color is harmless; lengths shift at most on the tail).
        let stale = self.entries.get(&key).and_then(|e| e.lines.clone());
        let code = code.to_string();
        let code_len = code.len();
        let task = cx.spawn(async move |this, cx| {
            let lines = cx
                .background_executor()
                .spawn(async move {
                    let mut carry = LineCarry::None;
                    let mut out = Vec::new();
                    for (ix, line) in code.split('\n').enumerate() {
                        let (tokens, next) = tokenize_line(lang, line, carry);
                        carry = next;
                        out.push(tokens);
                        if ix % 128 == 127 {
                            yield_now().await;
                        }
                    }
                    out
                })
                .await;
            this.update(cx, |transcript, cx| {
                if let Some(entry) = transcript.highlights.entries.get_mut(&key)
                    && entry.code_len == code_len
                {
                    entry.lines = Some(Arc::new(lines));
                    cx.notify();
                }
            })
            .ok();
        });
        self.entries.insert(
            (row_id, block_ix),
            HighlightEntry {
                code_len,
                lines: stale.clone(),
                _task: Some(task),
            },
        );
        stale
    }
}

// ---------------------------------------------------------------------------
// Transcript entity
// ---------------------------------------------------------------------------

async fn yield_now() {
    let mut yielded = false;
    futures::future::poll_fn(move |cx| {
        if yielded {
            std::task::Poll::Ready(())
        } else {
            yielded = true;
            cx.waker().wake_by_ref();
            std::task::Poll::Pending
        }
    }).await
}

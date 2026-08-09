use std::collections::HashMap;
use std::sync::Arc;

use comet_doc::{MessagePart, MessageRole, MessageStatus, SessionMessageEntry};
use comet_proto::ToolCall;

use crate::markdown::parser::{BlockTree, parse_full};
use crate::markdown::render::{self};

use super::parse::{
    ParseOutcome, chips_height, diff_rows, flavour_seed, flavour_word, format_elapsed,
    parse_for_row, tool_chip_height, tool_group_summary, top_gap_for,
};
use super::rows::{
    RowKind, ToolItem, format_timestamp, rows_for_entry,
};
use super::spring::StickSpring;
use super::{
    Transcript, GAP_TURN, SPRING_CHASE_MAX_LEAD, TODO_ITEM_HEIGHT, TODO_ITEMS_PAD,
    CHIP_CARD_HEIGHT, CHIP_GAP, CHIP_HEIGHT, CHIPS_TOP_PAD, GAP_BLOCK,
    single_line, tool_chip_content,
};


// ---- streaming parse wiring (the transcript side, not the parser) ----

#[test]
fn live_row_parse_work_is_bounded_per_commit() {
// Drive the EXACT wiring `rows_for` uses (`parse_for_row`) with the
// prefix-extending commit snapshots the doc watch delivers, and prove
// the per-commit parse work stays O(reparsed tail): a full-reparse
// wiring would feed ~N/2 × final_len bytes through the parser across N
// commits; the incremental path stays within a small multiple of the
// final length regardless of N.
let mut live_parsers = HashMap::new();
let mut tree_cache = HashMap::new();
let paragraph = "A paragraph of streaming prose that keeps arriving.\n\n";
let commits = 120usize;
let mut text = String::new();
let mut total_parsed = 0usize;
for i in 0..commits {
    // Each commit appends ~half a paragraph (crosses block boundaries).
    let chunk = &paragraph[..paragraph.len() / 2];
    text.push_str(if i % 2 == 0 {
        chunk
    } else {
        &paragraph[paragraph.len() / 2..]
    });
    let (tree, outcome) =
        parse_for_row(true, "e1#p1", &text, &mut live_parsers, &mut tree_cache);
    assert!(!tree.blocks.is_empty());
    let ParseOutcome::Incremental {
        parsed_bytes,
        stable_prefix_blocks,
    } = outcome
    else {
        panic!("streaming commit must take the incremental path");
    };
    total_parsed += parsed_bytes;
    // Per commit: never a full reparse once the doc has grown past the
    // tail window (last two complete blocks + the partial trailing
    // one + the delta ≤ 3 paragraphs here).
    assert!(
        parsed_bytes <= 3 * paragraph.len(),
        "commit {i}: parsed {parsed_bytes} bytes — not bounded by the tail window"
    );
    // The stable prefix grows with the doc — settled blocks are never
    // re-touched (this is what keeps render caches valid).
    assert!(stable_prefix_blocks + 2 >= tree.blocks.len().saturating_sub(1));
}
// Across the whole stream: work is commits × O(tail), an order of
// magnitude under the ~commits × len/2 a full-reparse wiring costs.
let final_len = text.len();
let full_reparse_cost = commits * final_len / 2;
assert!(total_parsed <= commits * 3 * paragraph.len());
assert!(
    total_parsed * 10 < full_reparse_cost,
    "total parsed {total_parsed} vs full-reparse ~{full_reparse_cost}"
);

// Live→complete handoff: the completed part adopts the live parser's
// exact tree without parsing a single byte.
let (_, outcome) = parse_for_row(false, "e1#p1", &text, &mut live_parsers, &mut tree_cache);
assert_eq!(outcome, ParseOutcome::Handoff);
// And the settled cache serves repeats with no work at all.
let (_, outcome) = parse_for_row(false, "e1#p1", &text, &mut live_parsers, &mut tree_cache);
assert_eq!(outcome, ParseOutcome::Cached);
}

// ---- stick-to-bottom spring ----

#[test]
fn spring_converges_to_a_fixed_target() {
let mut spring = StickSpring::new();
let target = 400.0;
let mut pos = 0.0;
let mut frames = 0;
while pos < target && frames < 600 {
    pos = spring.step(pos, target, 1.0);
    frames += 1;
}
assert_eq!(pos, target, "spring must land exactly on the target");
assert!(
    frames < 300,
    "400px should converge within 5s of frames, took {frames}"
);
// Once landed it stays landed (and idles out).
for _ in 0..120 {
    pos = spring.step(pos, target, 1.0);
    assert_eq!(pos, target);
}
assert!(spring.is_idle(), "no residual motion at rest");
}

#[test]
fn spring_never_overshoots_or_oscillates() {
let mut spring = StickSpring::new();
let target = 250.0;
let mut pos = 0.0;
let mut last = pos;
for _ in 0..600 {
    pos = spring.step(pos, target, 1.0);
    assert!(pos <= target, "overshoot: {pos} > {target}");
    assert!(
        pos >= last - 1e-3,
        "oscillation: position moved backwards {last} -> {pos}"
    );
    last = pos;
}
assert_eq!(pos, target);
}

#[test]
fn spring_feed_forward_tracks_constant_growth() {
// Target grows 2px/frame (≈120px/s — a typical stream). After warmup
// the EMA feed-forward must carry the viewport at the same rate with a
// bounded, stable lag — a glide, not 0,0,0,Npx steps.
let growth = 2.0;
let mut spring = StickSpring::new();
let mut target = 600.0;
let mut pos = 600.0;
let mut deltas: Vec<f32> = Vec::new();
for frame in 0..400 {
    target += growth;
    let next = spring.step(pos, target, 1.0);
    if frame >= 200 {
        deltas.push(next - pos);
    }
    pos = next;
}
// Steady state: per-frame movement ≈ growth rate…
let mean = deltas.iter().sum::<f32>() / deltas.len() as f32;
assert!(
    (mean - growth).abs() < 0.2,
    "steady-state speed {mean} should track growth {growth}"
);
// …with no stepping (every frame moves, none jumps).
for d in &deltas {
    assert!(*d > 0.0, "viewport stalled mid-stream");
    assert!(*d < growth * 3.0, "viewport jumped: {d}px in one frame");
}
// The EMA growth estimate itself has locked on.
assert!((spring.target_vel() - growth).abs() < 0.3);
// Lag stays bounded by the chase lead.
assert!(target - pos <= SPRING_CHASE_MAX_LEAD + growth);
}

#[test]
fn spring_feed_forward_resets_when_target_shrinks() {
let mut spring = StickSpring::new();
let mut pos = 0.0;
for i in 1..=50 {
    pos = spring.step(pos, 100.0 + i as f32 * 4.0, 1.0);
}
assert!(spring.target_vel() > 1.0);
// A collapse (target shrinks by more than 1px) drops the estimate.
spring.step(pos.min(120.0), 120.0, 1.0);
assert_eq!(spring.target_vel(), 0.0);
}

#[test]
fn spring_catchup_frames_glide_instead_of_teleporting() {
// A 5-frame hitch advances roughly as far as 5 single steps would —
// sub-stepped, still clamped at the target.
let target = 300.0;
let mut a = StickSpring::new();
let mut pos_a = 0.0;
for _ in 0..5 {
    pos_a = a.step(pos_a, target, 1.0);
}
let mut b = StickSpring::new();
let pos_b = b.step(0.0, target, 5.0);
assert!((pos_a - pos_b).abs() < 1.0, "{pos_a} vs {pos_b}");
assert!(pos_b <= target);
}

#[test]
fn restick_is_direction_aware() {
// Scrolling away from the bottom never resticks, even inside the band
// (a 20px wheel notch from the pinned bottom must break the pin).
assert!(!Transcript::should_restick(20.0, 0.0));
assert!(!Transcript::should_restick(69.0, 30.0));
// Returning toward the bottom resticks once inside the 70px band…
assert!(Transcript::should_restick(69.0, 120.0));
assert!(Transcript::should_restick(0.0, 30.0));
// …but not while still outside it.
assert!(!Transcript::should_restick(200.0, 300.0));
// No movement — leave the pin alone.
assert!(!Transcript::should_restick(50.0, 50.0));
}

fn parse(_: &str, text: &str) -> Arc<BlockTree> {
Arc::new(parse_full(text))
}

fn assistant(id: &str, status: MessageStatus, parts: Vec<MessagePart>) -> SessionMessageEntry {
SessionMessageEntry {
    id: id.into(),
    role: MessageRole::Assistant,
    parts,
    created_at: 0,
    device_id: "dev".into(),
    status: Some(status),
    continuation_of: None,
}
}

fn text_part(id: &str, text: &str) -> MessagePart {
MessagePart::Text {
    id: id.into(),
    text: text.into(),
}
}

fn tool_part(id: &str, command: &str) -> MessagePart {
MessagePart::Tool {
    id: id.into(),
    call: ToolCall::Exec {
        command: command.into(),
    },
    is_error: false,
    resolved: true,
}
}

const MD: &str = "# Title\n\npara one\n\n```rust\nlet x = 1;\n```";

#[test]
fn live_entry_splits_per_block_with_id_continuity() {
// Live rows split per block exactly like completed ones (the list
// virtualizes them — the fading tail is the only per-frame work).
let live = assistant("m1", MessageStatus::Streaming, vec![text_part("t0", MD)]);
let live_rows = rows_for_entry(&live, false, &mut parse);
assert_eq!(live_rows.len(), 3, "one live row per top-level block");
assert!(
    live_rows
        .iter()
        .all(|r| matches!(r.kind, RowKind::LiveMarkdown { .. }))
);
assert_eq!(live_rows[0].id.as_ref(), "m1#t0.0");
assert_eq!(live_rows[2].id.as_ref(), "m1#t0.2");

let done = assistant("m1", MessageStatus::Complete, vec![text_part("t0", MD)]);
let done_rows = rows_for_entry(&done, false, &mut parse);
assert_eq!(done_rows.len(), 3, "three top-level blocks");
// Every block row keeps its id across the flip — no flicker on handoff.
for (live, done) in live_rows.iter().zip(&done_rows) {
    assert_eq!(live.id, done.id);
    // The flip changes the version even at identical text (the
    // streaming bit), forcing a splice.
    assert_ne!(live.version, done.version);
}
assert!(matches!(
    done_rows[0].kind,
    RowKind::Markdown { block_ix: 0, .. }
));
}

#[test]
fn live_commit_changes_only_tail_row_versions() {
// Streaming commit: appending to the last block leaves every settled
// block row's (id, version) untouched — the diff splices only the tail.
let t1 = "para one\n\npara two\n\npara three";
let t2 = "para one\n\npara two\n\npara three grows here";
let live1 = assistant("m1", MessageStatus::Streaming, vec![text_part("t0", t1)]);
let live2 = assistant("m1", MessageStatus::Streaming, vec![text_part("t0", t2)]);
let r1 = rows_for_entry(&live1, false, &mut parse);
let r2 = rows_for_entry(&live2, false, &mut parse);
assert_eq!(r1.len(), 3);
assert_eq!(r2.len(), 3);
assert_eq!(r1[0].version, r2[0].version, "settled block untouched");
assert_eq!(r1[1].version, r2[1].version, "settled block untouched");
assert_ne!(r1[2].version, r2[2].version, "tail block respliced");
assert_eq!(diff_rows(&r1, &r2), Some((2..3, 1)));
}

#[test]
fn split_sibling_gaps_match_live_internal_spacing() {
// The live row spaces its internal blocks by MD_BLOCK_GAP; after the
// live→split handoff the same boundaries are inter-row gaps. They must
// be identical or the whole message jumps at completion.
let done = assistant(
    "m1",
    MessageStatus::Complete,
    vec![
        text_part("t0", MD),
        tool_part("a", "ls"),
        text_part("t1", "tail para"),
    ],
);
let rows = rows_for_entry(&done, false, &mut parse);
// Rows: t0.0, t0.1, t0.2 (three MD blocks), g0, t1.0.
assert_eq!(rows.len(), 5);
// Sibling markdown blocks from the same part: md block gap.
assert_eq!(top_gap_for(Some(&rows[0]), &rows[1]), render::MD_BLOCK_GAP);
assert_eq!(top_gap_for(Some(&rows[1]), &rows[2]), render::MD_BLOCK_GAP);
// Markdown → tool group and tool group → next part: block gap.
assert_eq!(top_gap_for(Some(&rows[2]), &rows[3]), GAP_BLOCK);
assert_eq!(top_gap_for(Some(&rows[3]), &rows[4]), GAP_BLOCK);
// Turn starts get the turn gap regardless.
assert_eq!(top_gap_for(None, &rows[0]), GAP_TURN);
}

#[test]
fn consecutive_tools_fold_into_groups_between_text() {
let entry = assistant(
    "m2",
    MessageStatus::Complete,
    vec![
        text_part("t0", "before"),
        tool_part("a", "ls"),
        tool_part("b", "pwd"),
        text_part("t1", "after"),
        tool_part("c", "make"),
    ],
);
let rows = rows_for_entry(&entry, false, &mut parse);
let ids: Vec<&str> = rows.iter().map(|r| r.id.as_ref()).collect();
assert_eq!(ids, ["m2#t0.0", "m2#g0", "m2#t1.0", "m2#g1"]);
let RowKind::ToolGroup { tools, .. } = &rows[1].kind else {
    panic!("group expected")
};
assert_eq!(tools.len(), 2);
assert!(rows[0].turn_start && !rows[1].turn_start);
}

#[test]
fn trailing_group_auto_opens_only_while_streaming() {
let parts = vec![text_part("t0", "hi"), tool_part("a", "ls")];
let streaming = assistant("m3", MessageStatus::Streaming, parts.clone());
let rows = rows_for_entry(&streaming, false, &mut parse);
let RowKind::ToolGroup { auto_open, .. } = rows[1].kind else {
    panic!()
};
assert!(auto_open, "trailing group opens while streaming");

let complete = assistant("m3", MessageStatus::Complete, parts);
let rows = rows_for_entry(&complete, false, &mut parse);
let RowKind::ToolGroup { auto_open, .. } = rows[1].kind else {
    panic!()
};
assert!(!auto_open);

// A non-trailing group never auto-opens.
let mid = assistant(
    "m4",
    MessageStatus::Streaming,
    vec![tool_part("a", "ls"), text_part("t0", "hi")],
);
let rows = rows_for_entry(&mid, false, &mut parse);
let RowKind::ToolGroup { auto_open, .. } = rows[0].kind else {
    panic!()
};
assert!(!auto_open);
}

#[test]
fn user_rows_and_echo_versions() {
let mut entry = assistant("u1", MessageStatus::Complete, vec![]);
entry.role = MessageRole::User;
entry.status = None;
entry.parts = vec![text_part("t0", "hello")];
let confirmed = rows_for_entry(&entry, false, &mut parse);
let echoed = rows_for_entry(&entry, true, &mut parse);
assert_eq!(confirmed.len(), 1);
assert_eq!(confirmed[0].id, echoed[0].id);
// Pending → confirmed changes the version so the row re-renders.
assert_ne!(confirmed[0].version, echoed[0].version);
assert!(matches!(
    &echoed[0].kind,
    RowKind::User { pending: true, .. }
));
}

#[test]
fn user_rows_split_attachment_refs_from_text() {
let content = crate::attachments::with_attachments(
    "what color is this?",
    &["/data/uploads/ab12-red.png".to_string()],
);
let mut entry = assistant("u2", MessageStatus::Complete, vec![]);
entry.role = MessageRole::User;
entry.status = None;
entry.parts = vec![text_part("t0", &content)];
let rows = rows_for_entry(&entry, false, &mut parse);
assert_eq!(rows.len(), 1);
let RowKind::User {
    text, attachments, ..
} = &rows[0].kind
else {
    panic!("expected a user row");
};
assert_eq!(text.as_ref(), "what color is this?");
assert_eq!(attachments.len(), 1);
assert_eq!(attachments[0].path, "/data/uploads/ab12-red.png");
assert_eq!(attachments[0].name, "ab12-red.png");

// Image-only send: no bubble text, refs parsed.
let only = crate::attachments::with_attachments("", &["/a/p.png".to_string()]);
entry.parts = vec![text_part("t0", &only)];
let rows = rows_for_entry(&entry, false, &mut parse);
let RowKind::User {
    text, attachments, ..
} = &rows[0].kind
else {
    panic!("expected a user row");
};
assert_eq!(text.as_ref(), "");
assert_eq!(attachments.len(), 1);
}

/// A sent prompt's file mentions render as chips in the transcript: the
/// row carries the projected display text plus spans, while ordinary
/// prompts keep the empty-spans fast path. The row version derives from
/// the RAW text either way, so projection never perturbs the diff key.
#[test]
fn user_rows_project_file_mentions_into_chips() {
let raw = "look at [composer.rs](comet-file:crates/ui/src/composer.rs) please";
let mut entry = assistant("u3", MessageStatus::Complete, vec![]);
entry.role = MessageRole::User;
entry.status = None;
entry.parts = vec![text_part("t0", raw)];
let rows = rows_for_entry(&entry, false, &mut parse);
let RowKind::User { text, mentions, .. } = &rows[0].kind else {
    panic!("expected a user row");
};
assert!(
    !text.contains("comet-file:"),
    "raw link left visible: {text}"
);
assert!(text.contains("composer.rs"));
assert_eq!(mentions.len(), 1);
assert!(!mentions[0].is_dir);
assert_eq!(mentions[0].path.as_ref(), "crates/ui/src/composer.rs");
assert_eq!(&text[mentions[0].range.clone()], {
    let projected: &str = "\u{00A0}@composer.rs\u{00A0}";
    projected
});
assert_eq!(rows[0].version, (raw.len() as u64) << 1);

entry.parts = vec![text_part("t0", "no mentions here")];
let rows = rows_for_entry(&entry, false, &mut parse);
let RowKind::User { text, mentions, .. } = &rows[0].kind else {
    panic!("expected a user row");
};
assert_eq!(text.as_ref(), "no mentions here");
assert!(mentions.is_empty());
}

#[test]
fn diff_rows_appends_and_middle_edits() {
let entry1 = assistant("m1", MessageStatus::Complete, vec![text_part("t0", "one")]);
let entry2 = assistant("m2", MessageStatus::Complete, vec![text_part("t0", "two")]);
let r1 = rows_for_entry(&entry1, false, &mut parse);
let mut both = r1.clone();
both.extend(rows_for_entry(&entry2, false, &mut parse));

// Identical → None.
assert!(diff_rows(&r1, &r1.clone()).is_none());
// Append → splice at the tail.
assert_eq!(diff_rows(&r1, &both), Some((1..1, 1)));
// Removal from the end.
assert_eq!(diff_rows(&both, &r1), Some((1..2, 0)));

// Middle content change: only the changed row splices.
let entry1b = assistant(
    "m1",
    MessageStatus::Complete,
    vec![text_part("t0", "one more")],
);
let mut both_b = rows_for_entry(&entry1b, false, &mut parse);
both_b.extend(rows_for_entry(&entry2, false, &mut parse));
assert_eq!(diff_rows(&both, &both_b), Some((0..1, 1)));

// Full reset when everything shifts.
let r2 = rows_for_entry(&entry2, false, &mut parse);
assert_eq!(diff_rows(&r1, &r2), Some((0..1, 1)));
}

#[test]
fn diff_handles_live_to_split_growth() {
let live = assistant("m1", MessageStatus::Streaming, vec![text_part("t0", MD)]);
let done = assistant("m1", MessageStatus::Complete, vec![text_part("t0", MD)]);
let live_rows = rows_for_entry(&live, false, &mut parse);
let done_rows = rows_for_entry(&done, false, &mut parse);
// Same ids; every version flips its streaming bit → one 3-row splice.
assert_eq!(diff_rows(&live_rows, &done_rows), Some((0..3, 3)));
}

#[test]
fn tool_group_summaries() {
let exec = |c: &str| ToolItem {
    call: ToolCall::Exec { command: c.into() },
    is_error: false,
    resolved: true,
};
let edit = |p: &str| ToolItem {
    call: ToolCall::EditFile {
        path: p.into(),
        old_string: None,
        new_string: None,
    },
    is_error: false,
    resolved: true,
};
let tools = vec![
    exec("ls"),
    exec("pwd"),
    exec("make"),
    edit("a.rs"),
    edit("b.rs"),
];
assert_eq!(
    tool_group_summary(&tools),
    "Ran 3 commands · edited 2 files"
);
// Distinct-path dedupe: editing one file twice counts once.
let tools = vec![edit("a.rs"), edit("a.rs")];
assert_eq!(tool_group_summary(&tools), "Edited 1 file");
// Failures append.
let mut failing = exec("boom");
failing.is_error = true;
assert_eq!(tool_group_summary(&[failing]), "Ran 1 command · 1 failed");
// Reads / searches / misc.
let tools = vec![
    ToolItem {
        call: ToolCall::ReadFile { path: "x".into() },
        is_error: false,
        resolved: true,
    },
    ToolItem {
        call: ToolCall::Glob {
            pattern: "*.rs".into(),
        },
        is_error: false,
        resolved: true,
    },
    ToolItem {
        call: ToolCall::WebSearch { query: "q".into() },
        is_error: false,
        resolved: true,
    },
];
assert_eq!(tool_group_summary(&tools), "Read 1 file · searched 2 times");
}

#[test]
fn duplicate_adjacent_error_parts_render_once() {
let entry = assistant(
    "m1",
    MessageStatus::Complete,
    vec![
        MessagePart::Error {
            id: "e0".into(),
            message: "connection refused".into(),
        },
        MessagePart::Error {
            id: "e1".into(),
            message: "connection refused".into(),
        },
    ],
);

let rows = rows_for_entry(&entry, false, &mut parse);
assert_eq!(
    rows.iter()
        .filter(|row| matches!(row.kind, RowKind::ErrorChip { .. }))
        .count(),
    1
);
}

#[test]
fn tool_chip_labels_per_kind() {
assert_eq!(
    tool_chip_content(&ToolCall::Exec {
        command: "cargo test".into()
    }),
    ("Run", "cargo test".to_string())
);
assert_eq!(
    tool_chip_content(&ToolCall::Search {
        pattern: "foo".into(),
        path: Some("src".into())
    }),
    ("Search", "foo in src".to_string())
);
assert_eq!(
    tool_chip_content(&ToolCall::ApplyPatch { path: None }),
    ("Patch", "workspace".to_string())
);
assert_eq!(
    tool_chip_content(&ToolCall::Mcp {
        server: "gh".into(),
        tool: "issues".into(),
        input: None
    }),
    ("MCP", "gh · issues".to_string())
);
let todo = ToolCall::Todo {
    items: vec![
        comet_proto::TodoItem {
            text: "a".into(),
            done: true,
        },
        comet_proto::TodoItem {
            text: "b".into(),
            done: false,
        },
    ],
};
assert_eq!(tool_chip_content(&todo), ("Todo", "1/2 done".to_string()));
}

#[test]
fn multiline_command_flattens_to_one_chip_line() {
// The user's breaker: a multi-line script in a Run chip. The detail
// must come out as ONE sanitized line — the chip's fixed 30px card
// then truncates it with an ellipsis like the original's CSS.
let (label, detail) = tool_chip_content(&ToolCall::Exec {
    command: "set -e\nfixture_in_original=0\n\tgrep -c  \"x\"".into(),
});
assert_eq!(label, "Run");
assert_eq!(detail, "set -e fixture_in_original=0 grep -c \"x\"");
assert!(!detail.contains('\n'));
// The chip row height is a constant, independent of content shape
// (for non-Todo tools).
let one = vec![ToolItem {
    call: ToolCall::Exec {
        command: "x".into(),
    },
    is_error: false,
    resolved: false,
}];
assert_eq!(chips_height(&one), CHIPS_TOP_PAD + CHIP_HEIGHT);
// Every detail kind is sanitized (MCP inputs / queries are model text).
let (_, q) = tool_chip_content(&ToolCall::WebSearch {
    query: "line one\nline two".into(),
});
assert_eq!(q, "line one line two");
}

#[test]
fn timestamp_strip_lands_on_the_last_settled_row() {
use chrono::FixedOffset;
// Fixed zone (UTC−4): "Jul 1, 3:45 PM" — the exact formatTimestamp
// shape (short month, numeric day, no leading zero, 2-digit minutes).
let tz = FixedOffset::west_opt(4 * 3600).unwrap();
let ms = chrono::DateTime::parse_from_rfc3339("2026-07-01T19:45:00Z")
    .unwrap()
    .timestamp_millis();
assert_eq!(format_timestamp(ms, &tz), "Jul 1, 3:45 PM");

// User entries carry the strip on their single row (pending too).
let user = SessionMessageEntry {
    id: "u1".into(),
    role: MessageRole::User,
    parts: vec![text_part("p1", "hi")],
    created_at: ms,
    device_id: "dev".into(),
    status: None,
    continuation_of: None,
};
let rows = rows_for_entry(&user, true, &mut parse);
assert_eq!(rows.len(), 1);
assert_eq!(rows[0].timestamp, Some(ms));
assert!(rows[0].raw_text.is_none(), "pending echoes have no actions");
let rows = rows_for_entry(&user, false, &mut parse);
assert_eq!(rows[0].raw_text.as_deref(), Some("hi"));
assert_eq!(rows[0].role, Some(MessageRole::User));

// Assistant entries: strip on the LAST row once settled…
let done = assistant(
    "a1",
    MessageStatus::Complete,
    vec![text_part("p1", "one\n\ntwo")],
);
let rows = rows_for_entry(&done, false, &mut parse);
assert!(rows.len() >= 2);
assert_eq!(rows.last().unwrap().timestamp, Some(done.created_at));
assert!(rows[..rows.len() - 1].iter().all(|r| r.timestamp.is_none()));
assert_eq!(rows.last().unwrap().raw_text.as_deref(), Some("one\n\ntwo"));
assert!(rows[..rows.len() - 1].iter().all(|r| r.raw_text.is_none()));

// …but never mid-stream (chat-view.tsx: no hover under a moving reply).
let live = assistant(
    "a2",
    MessageStatus::Streaming,
    vec![text_part("p1", "streaming…")],
);
let rows = rows_for_entry(&live, false, &mut parse);
assert!(rows.iter().all(|r| r.timestamp.is_none()));
assert!(rows.iter().all(|r| r.raw_text.is_none()));
// Every row knows its entry (the hover group).
assert!(rows.iter().all(|r| r.entry_id.as_ref() == live.id));
}

#[test]
fn single_line_collapses_all_whitespace_runs() {
assert_eq!(single_line("a\nb"), "a b");
assert_eq!(single_line("  a\t\t b \r\n c  "), "a b c");
assert_eq!(single_line("plain"), "plain");
assert_eq!(single_line(""), "");
assert_eq!(single_line("\n\n"), "");
}

#[test]
fn chips_height_is_analytic() {
let exec = || ToolItem {
    call: ToolCall::Exec {
        command: "x".into(),
    },
    is_error: false,
    resolved: false,
};
assert_eq!(chips_height(&[]), 0.0);
assert_eq!(chips_height(&[exec()]), CHIPS_TOP_PAD + CHIP_HEIGHT);
assert_eq!(
    chips_height(&[exec(), exec(), exec()]),
    CHIPS_TOP_PAD + 3.0 * CHIP_HEIGHT + 2.0 * CHIP_GAP
);
}

#[test]
fn todo_chip_height_grows_with_items() {
// Empty todo list: flat chip height (just the header summary).
let empty = ToolCall::Todo { items: vec![] };
assert_eq!(tool_chip_height(&empty), CHIP_HEIGHT);

// Each item adds TODO_ITEM_HEIGHT; the card is CHIP_CARD_HEIGHT for
// the header + padding top/bottom.
let two = ToolCall::Todo {
    items: vec![
        comet_proto::TodoItem {
            text: "a".into(),
            done: true,
        },
        comet_proto::TodoItem {
            text: "b".into(),
            done: false,
        },
    ],
};
let expected = CHIP_CARD_HEIGHT + TODO_ITEMS_PAD * 2.0 + 2.0 * TODO_ITEM_HEIGHT;
assert_eq!(tool_chip_height(&two), expected);
assert!(expected > CHIP_HEIGHT, "todo chip must be taller than flat");
}

#[test]
fn chips_height_accounts_for_todo_expansion() {
let todo = ToolItem {
    call: ToolCall::Todo {
        items: vec![
            comet_proto::TodoItem {
                text: "a".into(),
                done: false,
            },
            comet_proto::TodoItem {
                text: "b".into(),
                done: false,
            },
        ],
    },
    is_error: false,
    resolved: false,
};
let exec = ToolItem {
    call: ToolCall::Exec {
        command: "ls".into(),
    },
    is_error: false,
    resolved: false,
};
// Mixed group: todo expansion height + flat exec height + gap.
let h = chips_height(&[todo.clone(), exec.clone()]);
let expected = CHIPS_TOP_PAD + tool_chip_height(&todo.call) + CHIP_GAP + CHIP_HEIGHT;
assert_eq!(h, expected);
}

#[test]
fn flavour_words_rotate_every_seven_seconds() {
let seed = flavour_seed("chat-1");
assert_eq!(flavour_word(seed, 0), flavour_word(seed, 6));
assert_ne!(flavour_word(seed, 0), flavour_word(seed, 7));
// Deterministic per chat; different chats usually differ in phase.
assert_eq!(flavour_word(seed, 3), flavour_word(seed, 3));
assert_eq!(format_elapsed(59), "59s");
assert_eq!(format_elapsed(92), "1m 32s");
assert_eq!(format_elapsed(-5), "0s");
}

#[test]
fn empty_text_parts_produce_no_rows() {
let entry = assistant(
    "m9",
    MessageStatus::Streaming,
    vec![text_part("t0", ""), text_part("t1", "   ")],
);
assert!(rows_for_entry(&entry, false, &mut parse).is_empty());
}

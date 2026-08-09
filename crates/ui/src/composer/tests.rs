use super::*;
use super::mention::*;
use std::ops::Range;

    pub(crate) fn tooltip_target(range: Range<usize>, path: &str) -> MentionTooltipTarget {
        MentionTooltipTarget {
            range,
            path: path.into(),
        }
    }

    #[test]
    pub(crate) fn mention_tooltip_wait_survives_pointer_jitter_and_promotes_once() {
        let target = tooltip_target(3..20, "src/composer.rs");
        let waiting = MentionTooltipPhase::Waiting {
            target: target.clone(),
            generation: 1,
        };
        let restarted = mention_tooltip_reduce(waiting.clone(), Some(target.clone()), false, 2);
        assert_eq!(restarted, waiting);
        assert!(matches!(
            restarted,
            MentionTooltipPhase::Waiting { generation: 1, .. }
        ));
        assert_eq!(
            mention_tooltip_promote(restarted.clone(), 2, true),
            restarted,
            "a stale timer must not reveal the tooltip"
        );
        let visible = mention_tooltip_promote(restarted, 1, true);
        assert!(matches!(
            visible,
            MentionTooltipPhase::Visible { generation: 1, .. }
        ));
        assert_eq!(
            mention_tooltip_reduce(visible.clone(), Some(target), false, 3),
            visible,
            "one visible activation keeps its presentation generation stable"
        );
    }

    #[test]
    pub(crate) fn mention_tooltip_changes_target_and_cancels_disappeared_target() {
        let first = tooltip_target(0..10, "src/a.rs");
        let second = tooltip_target(20..30, "src/a.rs");
        let visible = MentionTooltipPhase::Visible {
            target: first,
            generation: 4,
        };
        assert!(matches!(
            mention_tooltip_reduce(visible, Some(second), false, 5),
            MentionTooltipPhase::Waiting { generation: 5, .. }
        ));
        assert_eq!(
            mention_tooltip_promote(
                MentionTooltipPhase::Waiting {
                    target: tooltip_target(20..30, "src/a.rs"),
                    generation: 5,
                },
                5,
                false,
            ),
            MentionTooltipPhase::Hidden
        );
    }

    #[test]
    pub(crate) fn mention_tooltip_stays_visible_over_chip_or_popup_only() {
        assert!(mention_tooltip_contains(true, false));
        assert!(mention_tooltip_contains(false, true));
        assert!(!mention_tooltip_contains(false, false));
    }

    #[test]
    pub(crate) fn mention_wash_moves_wholly_to_the_next_visual_row_at_a_wrap() {
        assert_eq!(
            display_row_segments(12..24, [12, 40]),
            vec![(1, 12, 12..24)]
        );
        assert_eq!(
            display_row_segments(8..24, [12, 40]),
            vec![(0, 0, 8..12), (1, 12, 12..24)]
        );
    }

    #[test]
    pub(crate) fn mention_token_requires_a_token_boundary_and_tracks_full_token() {
        assert_eq!(
            mention_token("Fix @src/com", 12),
            Some(MentionToken {
                range: 4..12,
                query: "src/com".into(),
            })
        );
        assert!(mention_token("mail@example.com", 16).is_none());
        assert!(mention_token("word@file", 9).is_none());
        assert!(mention_token("path/@file", 10).is_none());
        assert_eq!(
            mention_token("See (@lib", 9).map(|token| token.range),
            Some(5..9)
        );
    }

    #[test]
    pub(crate) fn dismissed_mentions_reject_stale_responses() {
        let mut state = FileMentionState {
            token: mention_token("@src", 4),
            request: 7,
            ..FileMentionState::default()
        };
        assert!(mention_response_is_current(&state, 7));
        state.request += 1;
        state.token = None;
        assert!(!mention_response_is_current(&state, 7));
        assert!(!mention_response_is_current(&state, 8));
    }

    #[test]
    pub(crate) fn file_mentions_serialize_to_strict_local_markdown() {
        let raw = local_file_link("src/a file#[x].rs", false);
        assert_eq!(
            raw,
            "[a file#\\[x\\].rs](comet-file:src/a%20file%23%5Bx%5D.rs)"
        );
        let links = file_mention_links(&raw);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].path, "src/a file#[x].rs");
        assert_eq!(links[0].basename, "a file#[x].rs");
        assert!(!links[0].is_dir);

        let folder = local_file_link("src/components", true);
        assert_eq!(folder, "[components](comet-file:src/components/)");
        let links = file_mention_links(&folder);
        assert_eq!(links[0].path, "src/components");
        assert!(links[0].is_dir);
    }

    #[test]
    pub(crate) fn file_mentions_reject_external_or_noncanonical_markdown() {
        assert!(file_mention_links("[site](https://example.com/a)").is_empty());
        assert!(file_mention_links("[a.rs](../a.rs)").is_empty());
        assert!(file_mention_links("[a.rs](src/a file.rs)").is_empty());
        assert!(file_mention_links("[other](src/a.rs)").is_empty());
        assert!(file_mention_links("[a.rs](src/a.rs)").is_empty());
        assert!(file_mention_links("[a.rs](src%5Cfake%5Ca.rs)").is_empty());
        assert!(file_mention_links("[a.rs](src/a%0A.rs)").is_empty());
    }

    #[test]
    pub(crate) fn duplicate_mention_basenames_use_unique_suffixes() {
        let raw = format!(
            "{} {}",
            local_file_link("src/one/mod.rs", false),
            local_file_link("src/two/mod.rs", false)
        );
        let projection = TextProjection::new(&raw);
        assert!(projection.display.contains("one/mod.rs"));
        assert!(projection.display.contains("two/mod.rs"));
    }

    #[test]
    pub(crate) fn mention_suffixes_compare_path_components() {
        let links = vec![
            FileMentionLink {
                range: 0..0,
                basename: "mod.rs".into(),
                path: "foo/mod.rs".into(),
                is_dir: false,
            },
            FileMentionLink {
                range: 0..0,
                basename: "oomod.rs".into(),
                path: "bar/oomod.rs".into(),
                is_dir: false,
            },
        ];
        assert_eq!(
            mention_display_labels(&links),
            vec!["mod.rs".to_string(), "oomod.rs".to_string()]
        );
    }

    #[test]
    pub(crate) fn projection_maps_and_expands_atomic_chip_ranges() {
        let raw = format!("open {} now", local_file_link("src/composer.rs", false));
        let projection = TextProjection::new(&raw);
        let (link, chip) = &projection.mentions[0];
        assert_eq!(
            &projection.display[chip.clone()],
            "\u{00A0}@composer.rs\u{00A0}"
        );
        assert_eq!(projection.display_to_raw(chip.start + 1), link.range.start);
        assert_eq!(projection.display_to_raw(chip.end - 1), link.range.end);
        assert_eq!(
            projection.previous_boundary(link.range.end),
            Some(link.range.start)
        );
        assert_eq!(
            projection.next_boundary(link.range.start),
            Some(link.range.end)
        );
        assert_eq!(
            projection.normalize_range(link.range.start + 2..link.range.end - 2),
            link.range
        );
    }

    #[test]
    pub(crate) fn sent_mention_display_projects_chips_for_the_transcript() {
        let raw = format!(
            "check {} and {}",
            local_file_link("src/composer.rs", false),
            local_file_link("src/components", true)
        );
        let (display, spans) = sent_mention_display(&raw).expect("mentions project");
        assert!(!display.contains(FILE_MENTION_SCHEME));
        assert!(display.contains("composer.rs"));
        assert!(display.contains("components"));
        assert_eq!(spans.len(), 2);
        assert_eq!(
            &display[spans[0].range.clone()],
            "\u{00A0}@composer.rs\u{00A0}"
        );
        assert!(!spans[0].is_dir);
        assert_eq!(spans[0].path.as_ref(), "src/composer.rs");
        assert!(spans[1].is_dir);
        assert_eq!(spans[1].path.as_ref(), "src/components/");
    }

    /// Ordinary prompts must stay on the zero-cost path, including ones that
    /// merely *talk about* the scheme without containing a valid mention.
    #[test]
    pub(crate) fn sent_mention_display_leaves_plain_prompts_untouched() {
        assert_eq!(sent_mention_display("fix the composer"), None);
        assert_eq!(
            sent_mention_display("what is a comet-file: link?"),
            None,
            "scheme substring without a valid mention link"
        );
        assert_eq!(
            sent_mention_display("[a.rs](comet-file:../a.rs)"),
            None,
            "a hostile path never becomes a chip in the transcript either"
        );
    }

    pub(crate) fn question(id: &str, options: &[&str], multi: bool) -> UserInputQuestion {
        UserInputQuestion {
            id: id.into(),
            header: "Header".into(),
            question: format!("Question {id}"),
            options: options.iter().map(|s| s.to_string()).collect(),
            multi_select: multi,
        }
    }

    #[test]
    pub(crate) fn flip_decision() {
        // Fits in the pill → compact stays compact.
        assert!(!composer_flip(false, 150.0, 300.0, false, false));
        // Overflow → expand.
        assert!(composer_flip(false, 320.0, 300.0, false, false));
        // Newline always expands (either mode, even mid-resize).
        assert!(composer_flip(false, 10.0, 300.0, true, false));
        assert!(composer_flip(true, 10.0, 300.0, true, true));
        // Narrow column (< MIN_COMPACT_INPUT_WIDTH) always expands.
        assert!(composer_flip(false, 10.0, 199.0, false, false));
        assert!(!composer_flip(false, 10.0, 200.0, false, false));
    }

    #[test]
    pub(crate) fn flip_hysteresis_band_prevents_oscillation() {
        let cap = 300.0;
        // Text just over capacity expands…
        assert!(composer_flip(false, cap + 1.0, cap, false, false));
        // …and the SAME width, now expanded, does NOT collapse back — the
        // collapse threshold sits COLLAPSE_HYSTERESIS below the expand one.
        assert!(composer_flip(true, cap + 1.0, cap, false, false));
        // Anywhere inside the band the two modes are both stable (no width in
        // (cap - 32, cap] flips in either direction).
        let in_band = cap - COLLAPSE_HYSTERESIS + 1.0;
        assert!(!composer_flip(false, in_band, cap, false, false));
        assert!(composer_flip(true, in_band, cap, false, false));
        // Comfortably under the band → collapses.
        assert!(!composer_flip(
            true,
            cap - COLLAPSE_HYSTERESIS - 1.0,
            cap,
            false,
            false
        ));
    }

    #[test]
    pub(crate) fn flip_frozen_during_interactive_resize() {
        // While resizing, both modes hold even across their thresholds…
        assert!(!composer_flip(false, 500.0, 300.0, false, true));
        assert!(composer_flip(true, 0.0, 300.0, false, true));
        // …including the narrow-column force-expand.
        assert!(!composer_flip(false, 10.0, 150.0, false, true));
        // Once settled, the same inputs flip.
        assert!(composer_flip(false, 500.0, 300.0, false, false));
        assert!(!composer_flip(true, 0.0, 300.0, false, false));
        assert!(composer_flip(false, 10.0, 150.0, false, false));
    }

    #[test]
    pub(crate) fn caret_blink_phase() {
        // Solid through the first half-period (typing burst never blinks).
        assert!(caret_visible(0));
        assert!(caret_visible(CARET_BLINK_MS - 1));
        // Off for the second half-period, back on for the third.
        assert!(!caret_visible(CARET_BLINK_MS));
        assert!(!caret_visible(2 * CARET_BLINK_MS - 1));
        assert!(caret_visible(2 * CARET_BLINK_MS));
    }

    #[test]
    pub(crate) fn auto_grow_math() {
        // The source heights (comet composer.tsx line 235 clamp, composer-
        // actions.tsx row, 1px hairlines): 76+46+2 empty … 260+46+2 capped.
        assert_eq!(COMPOSER_MIN_HEIGHT, 124.0);
        assert_eq!(COMPOSER_MAX_HEIGHT, 308.0);
        // One line sits at the floor: the textarea BOX (content + `pt-4 pb-1`)
        // clamps UP to 76 exactly like `Math.max(scrollHeight, 76)` — this is
        // what makes the always-expanded new-chat composer 124px tall.
        assert_eq!(
            composer_total_height(input_content_height(1)),
            COMPOSER_MIN_HEIGHT
        );
        // Growth is linear once the textarea box exceeds its 76px floor.
        let h4 = composer_total_height(input_content_height(4));
        assert_eq!(
            h4,
            4.0 * INPUT_LINE_HEIGHT + TEXTAREA_PAD_V + ACTIONS_ROW_HEIGHT + PILL_BORDER_V
        );
        // Caps at a 260px textarea box (comet max-h-[260px] / the JS clamp).
        assert_eq!(
            composer_total_height(input_content_height(100)),
            COMPOSER_MAX_HEIGHT
        );
        // Zero lines still measures one.
        assert_eq!(input_content_height(0), INPUT_LINE_HEIGHT);
    }

    #[test]
    pub(crate) fn input_wheel_scroll_uses_gpui_direction_and_clamps() {
        // Positive wheel delta moves toward the start; negative moves down.
        assert_eq!(input_scroll_offset(40.0, 20.0, 200.0, 100.0), 20.0);
        assert_eq!(input_scroll_offset(40.0, -30.0, 200.0, 100.0), 70.0);
        // Neither edge can be overscrolled.
        assert_eq!(input_scroll_offset(10.0, 50.0, 200.0, 100.0), 0.0);
        assert_eq!(input_scroll_offset(90.0, -50.0, 200.0, 100.0), 100.0);
        // Short content has no internal scroll range.
        assert_eq!(input_scroll_offset(20.0, -50.0, 80.0, 100.0), 0.0);
    }

    #[test]
    pub(crate) fn input_scroll_reveals_only_when_caret_leaves_viewport() {
        // A visible caret preserves the user's viewport.
        assert_eq!(
            input_scroll_offset_for_cursor(40.0, 60.0, 20.0, 300.0, 100.0),
            40.0
        );
        // Moving above or below reveals the row with the smallest adjustment.
        assert_eq!(
            input_scroll_offset_for_cursor(80.0, 30.0, 20.0, 300.0, 100.0),
            30.0
        );
        assert_eq!(
            input_scroll_offset_for_cursor(20.0, 130.0, 20.0, 300.0, 100.0),
            50.0
        );
        // Revealing the final row clamps exactly to the content end.
        assert_eq!(
            input_scroll_offset_for_cursor(0.0, 290.0, 20.0, 300.0, 100.0),
            200.0
        );
    }

    #[test]
    pub(crate) fn input_drag_autoscroll_is_edge_proportional_and_capped() {
        let top = 100.0;
        let bottom = 300.0;
        let line = INPUT_LINE_HEIGHT;
        assert_eq!(input_drag_scroll_delta(200.0, top, bottom, line), 0.0);
        assert_eq!(input_drag_scroll_delta(90.0, top, bottom, line), -2.0);
        assert_eq!(input_drag_scroll_delta(315.0, top, bottom, line), 3.0);
        assert_eq!(input_drag_scroll_delta(-100.0, top, bottom, line), -line);
        assert_eq!(input_drag_scroll_delta(500.0, top, bottom, line), line);
    }

    /// One frame short of the full morph timeline (never rounds up to done).
    const ALMOST: f32 = 179.0;

    #[test]
    pub(crate) fn flip_morph_starts_once_per_committed_flip() {
        // No committed flip → no morph.
        assert_eq!(flip_morph_step(None, false, 49.0, 0.0, false, false), None);
        // A committed flip starts one, from the last rendered height…
        let m = flip_morph_step(None, true, 49.0, 100.0, false, false).unwrap();
        assert_eq!(m.from, 49.0);
        assert_eq!(m.start_ms, 100.0);
        // …and same-mode renders keep it UNCHANGED (no restart at the
        // boundary, whatever the heights are doing).
        assert_eq!(
            flip_morph_step(Some(m.clone()), false, 80.0, 150.0, false, false),
            Some(m.clone())
        );
        // A finished morph clears on the next same-mode render.
        assert_eq!(
            flip_morph_step(Some(m.clone()), false, 124.0, 100.0 + ALMOST, false, false),
            Some(m.clone())
        );
        assert_eq!(
            flip_morph_step(Some(m.clone()), false, 124.0, 300.0, false, false),
            None
        );
    }

    #[test]
    pub(crate) fn flip_morph_height_ramps_monotonically_to_target() {
        let m = FlipMorph {
            from: 49.0,
            start_ms: 0.0,
        };
        // Starts exactly at the committed height…
        let mut prev = m.height(124.0, 0.0);
        assert_eq!(prev, 49.0);
        // …ramps without ever moving backwards…
        for step in 1..=18 {
            let h = m.height(124.0, step as f32 * 10.0);
            assert!(h >= prev, "height regressed at {step}: {h} < {prev}");
            prev = h;
        }
        // …and lands exactly on the target when done (and stays there).
        assert_eq!(m.height(124.0, 180.0), 124.0);
        assert!(m.done(180.0));
        assert_eq!(m.height(124.0, 500.0), 124.0);
        // Collapse runs the same ramp downward.
        assert!(m.height(124.0, 90.0) > 49.0);
        let down = FlipMorph {
            from: 124.0,
            start_ms: 0.0,
        };
        assert!(down.height(49.0, 90.0) < 124.0);
        assert!(down.height(49.0, 90.0) > 49.0);
    }

    #[test]
    pub(crate) fn flip_morph_reverse_hands_off_from_current_height() {
        let m = FlipMorph {
            from: 49.0,
            start_ms: 0.0,
        };
        let mid = m.height(124.0, 90.0);
        assert!(mid > 49.0 && mid < 124.0);
        // A reverse flip mid-flight commits a new morph FROM the animated
        // height — continuous at the handoff, no pop to an endpoint.
        let rev = flip_morph_step(Some(m), true, mid, 90.0, false, false).unwrap();
        assert_eq!(rev.from, mid);
        assert_eq!(rev.height(49.0, 90.0), mid);
    }

    #[test]
    pub(crate) fn flip_morph_snaps_for_reduced_motion_and_first_paint() {
        // Reduced motion never creates a morph (the flip just snaps)…
        assert_eq!(flip_morph_step(None, true, 49.0, 0.0, true, false), None);
        // …and neither does a flip before anything was ever rendered.
        assert_eq!(flip_morph_step(None, true, 0.0, 0.0, false, false), None);
    }

    #[test]
    pub(crate) fn route_change_never_arms_the_morph() {
        // A flip committed inside the route-snap window must NOT animate —
        // switching sessions (chat↔chat or chat↔new-session) snaps the
        // composer straight to the target mode, like the header (round 6).
        assert_eq!(flip_morph_step(None, true, 49.0, 0.0, false, true), None);
        // The route change also kills anything already in flight…
        let m = FlipMorph {
            from: 49.0,
            start_ms: 0.0,
        };
        assert_eq!(
            flip_morph_step(Some(m.clone()), false, 80.0, 50.0, false, true),
            None
        );
        assert_eq!(
            flip_morph_step(Some(m), true, 80.0, 50.0, false, true),
            None
        );
        // …while outside the window the same flip animates as usual.
        let armed = flip_morph_step(None, true, 49.0, 300.0, false, false).unwrap();
        assert_eq!(armed.from, 49.0);
    }

    #[test]
    pub(crate) fn morph_anchoring_holds_controls_and_glides_text() {
        // Steady state (progress 1): no offsets, everything at rest.
        assert_eq!(morph_cluster_dy(1.0), 0.0);
        assert_eq!(morph_text_pad(1.0), 16.0);
        assert_eq!(collapse_text_glide(124.0, 1.0), 0.0);
        // At the commit instant the pieces start from the OLD mode's resting
        // geometry: text pad at the compact 12px inset, cluster displaced by
        // exactly the 2.5px centering delta.
        assert_eq!(morph_text_pad(0.0), 12.0);
        assert_eq!(morph_cluster_dy(0.0), CLUSTER_Y_DELTA);
        // Collapse glide: starts where the expanded text sat (17px below the
        // committed pill top → `from − 53` above the compact resting spot)…
        assert_eq!(collapse_text_glide(124.0, 0.0), 71.0);
        // …decays monotonically to zero…
        let mut prev = collapse_text_glide(124.0, 0.0);
        for step in 1..=10 {
            let g = collapse_text_glide(124.0, step as f32 / 10.0);
            assert!(g <= prev, "glide regressed at {step}");
            prev = g;
        }
        // …and can't go negative on shallow mid-flight reversals.
        assert_eq!(collapse_text_glide(50.0, 0.0), 0.0);
    }

    #[test]
    pub(crate) fn cluster_inset_glides_between_the_source_endpoints() {
        // The morph starts from the OLD mode's resting inset (no sideways
        // step at the commit) and eases to the committed mode's…
        assert_eq!(morph_cluster_inset(true, 0.0), 8.0); // expand: from compact pr-2
        assert_eq!(morph_cluster_inset(true, 1.0), 12.0); // …to expanded px-3
        assert_eq!(morph_cluster_inset(false, 0.0), 12.0); // collapse: from px-3
        assert_eq!(morph_cluster_inset(false, 1.0), 8.0); // …to pr-2
        // …monotonically, bounded by the 4px source delta.
        let mut prev = morph_cluster_inset(true, 0.0);
        for step in 1..=10 {
            let v = morph_cluster_inset(true, step as f32 / 10.0);
            assert!(v >= prev && v <= 8.0 + CLUSTER_X_DELTA);
            prev = v;
        }
        // Internal spacing is SHARED between modes (one cluster in the
        // source) — only this wrapper inset may differ across the flip.
    }

    #[test]
    pub(crate) fn flip_morph_tracks_live_target_and_drives_fade() {
        let m = FlipMorph {
            from: 49.0,
            start_ms: 0.0,
        };
        // Auto-grow can move the target mid-morph: evaluation tracks the
        // live value instead of finishing on a stale height.
        assert!(m.height(159.0, 90.0) > m.height(124.0, 90.0));
        // The eased progress is the actions-row fade: 0 at commit, 1 at rest.
        assert_eq!(m.progress(0.0), 0.0);
        assert_eq!(m.progress(180.0), 1.0);
        let mid = m.progress(90.0);
        assert!(mid > 0.0 && mid < 1.0);
    }

    #[test]
    pub(crate) fn send_button_morph() {
        assert_eq!(send_button_mode(false, false), SendButtonMode::Send);
        assert_eq!(send_button_mode(false, true), SendButtonMode::Send);
        assert_eq!(send_button_mode(true, true), SendButtonMode::Steer);
        assert_eq!(send_button_mode(true, false), SendButtonMode::Stop);
    }

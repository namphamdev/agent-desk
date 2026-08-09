use super::*;
use super::mention::*;
use super::tests::question;
use std::ops::Range;


    #[test]
    pub(crate) fn wizard_single_select_auto_advances_and_completes() {
        let mut w = Wizard::new(
            "req".into(),
            vec![
                super::tests::question("q1", &["a", "b"], false),
                super::tests::question("q2", &["x"], false),
            ],
        );
        assert_eq!(w.counter(), "1/2");
        assert_eq!(w.select(1), WizardStep::AutoAdvance);
        assert!(w.is_picked(1));
        assert_eq!(w.advance(), WizardStep::Stay);
        assert_eq!(w.counter(), "2/2");
        assert_eq!(w.select(0), WizardStep::AutoAdvance);
        let WizardStep::Done(answers) = w.advance() else {
            panic!("expected Done")
        };
        assert_eq!(answers.len(), 2);
        assert_eq!(answers[0].labels, vec!["b"]);
        assert_eq!(answers[1].labels, vec!["x"]);
    }

    #[test]
    pub(crate) fn wizard_multi_select_toggles_and_stays() {
        let mut w = Wizard::new("req".into(), vec![super::tests::question("q", &["a", "b", "c"], true)]);
        assert_eq!(w.select(0), WizardStep::Stay);
        assert_eq!(w.select(2), WizardStep::Stay);
        assert!(w.is_picked(0) && w.is_picked(2));
        // Toggle off.
        assert_eq!(w.select(0), WizardStep::Stay);
        assert!(!w.is_picked(0));
        let WizardStep::Done(answers) = w.advance() else {
            panic!()
        };
        assert_eq!(answers[0].labels, vec!["c"]);
    }

    #[test]
    pub(crate) fn wizard_number_keys_and_bounds() {
        let mut w = Wizard::new("req".into(), vec![super::tests::question("q", &["a", "b"], false)]);
        assert_eq!(w.press_number(9), WizardStep::Stay, "out of range ignored");
        assert_eq!(w.press_number(0), WizardStep::Stay);
        assert_eq!(w.press_number(2), WizardStep::AutoAdvance);
        assert!(w.is_picked(1));
        assert_eq!(w.select(5), WizardStep::Stay, "bad option ix ignored");
    }

    #[test]
    pub(crate) fn wizard_typed_answer_overrides_and_back_pages() {
        let mut w = Wizard::new(
            "req".into(),
            vec![
                super::tests::question("q1", &["a"], false),
                super::tests::question("q2", &["x", "y"], false),
            ],
        );
        w.select(0);
        w.advance();
        assert_eq!(w.page, 1);
        assert!(w.back());
        assert_eq!(w.page, 0);
        assert!(!w.back(), "already at first page");
        w.advance();
        w.set_typed("  custom answer  ".into());
        let WizardStep::Done(answers) = w.advance() else {
            panic!()
        };
        assert_eq!(answers[0].labels, vec!["a"]);
        assert_eq!(
            answers[1].labels,
            vec!["custom answer"],
            "typed overrides picked, trimmed"
        );
    }

    #[test]
    pub(crate) fn pending_input_detection() {
        use comet_doc::MessageStatus;
        let input_part = MessagePart::Input {
            id: "in-r1".into(),
            request_id: "r1".into(),
            questions: vec![super::tests::question("q", &["a"], false)],
            resolved: false,
        };
        let entry = |status: Option<MessageStatus>, parts: Vec<MessagePart>| SessionMessageEntry {
            id: "m".into(),
            role: MessageRole::Assistant,
            parts,
            created_at: 0,
            device_id: "d".into(),
            status,
            continuation_of: None,
        };
        // Streaming entry with unresolved input → panel.
        let t = vec![entry(
            Some(MessageStatus::Streaming),
            vec![input_part.clone()],
        )];
        assert_eq!(
            pending_input_request(&t).map(|(id, _)| id),
            Some("r1".into())
        );
        // DEAD entry with an unresolved input STILL gets the panel: the
        // question stays answerable until answered (the engine delivers the
        // answer as a resumed turn), so a run reaped under its question —
        // engine restart — must not orphan it (user report).
        let t = vec![entry(
            Some(MessageStatus::Aborted),
            vec![input_part.clone()],
        )];
        assert_eq!(
            pending_input_request(&t).map(|(id, _)| id),
            Some("r1".into())
        );
        // A NEWER assistant entry supersedes an unanswered question.
        let t = vec![
            entry(Some(MessageStatus::Aborted), vec![input_part.clone()]),
            SessionMessageEntry {
                id: "m2".into(),
                role: MessageRole::Assistant,
                parts: vec![MessagePart::Text {
                    id: "t2".into(),
                    text: "moved on".into(),
                }],
                created_at: 2,
                device_id: "d".into(),
                status: Some(MessageStatus::Complete),
                continuation_of: None,
            },
        ];
        assert!(pending_input_request(&t).is_none());
        // Resolved part → no panel.
        let resolved = MessagePart::Input {
            id: "in-r1".into(),
            request_id: "r1".into(),
            questions: vec![],
            resolved: true,
        };
        let t = vec![entry(
            Some(MessageStatus::Streaming),
            vec![resolved.clone()],
        )];
        assert!(pending_input_request(&t).is_none());
        assert!(pending_input_request(&[]).is_none());

        // Regression (user forensics): a steer prompt appends a USER entry
        // AFTER the streaming assistant entry — the question must still be
        // found (a last-entry-only read vanished the panel exactly when the
        // user typed, bricking the answer flow).
        let user_echo = SessionMessageEntry {
            id: "u2".into(),
            role: MessageRole::User,
            parts: vec![MessagePart::Text {
                id: "t".into(),
                text: "I answered".into(),
            }],
            created_at: 1,
            device_id: "d".into(),
            status: Some(MessageStatus::Complete),
            continuation_of: None,
        };
        let t = vec![
            entry(Some(MessageStatus::Streaming), vec![input_part.clone()]),
            user_echo,
        ];
        assert_eq!(
            pending_input_request(&t).map(|(id, _)| id),
            Some("r1".into()),
            "question survives entries appended behind the streaming entry"
        );

        // Latch release: only an explicitly resolved matching part releases.
        assert!(!input_request_resolved(&t, "r1"));
        let t = vec![entry(Some(MessageStatus::Streaming), vec![resolved])];
        assert!(input_request_resolved(&t, "r1"));
        assert!(!input_request_resolved(&t, "other"));
    }

    #[test]
    pub(crate) fn word_range_for_double_click_selection() {
        let t = "fix the parser bug";
        //         0123456789012345678
        //                  1111111111
        assert_eq!(word_range_for_offset(t, 0), 0..3); // "fix"
        assert_eq!(word_range_for_offset(t, 1), 0..3); // middle of "fix"
        assert_eq!(word_range_for_offset(t, 2), 0..3); // end of "fix"
        assert_eq!(word_range_for_offset(t, 3), 0..3); // boundary after "fix"
        assert_eq!(word_range_for_offset(t, 4), 4..7); // "the"
        assert_eq!(word_range_for_offset(t, 8), 8..14); // "parser"
        assert_eq!(word_range_for_offset(t, 11), 8..14); // middle of "parser"
        assert_eq!(word_range_for_offset(t, 15), 15..18); // "bug"
    }

    #[test]
    pub(crate) fn word_range_selects_word_in_spaces() {
        // Double-clicking in the middle of whitespace selects nothing.
        let t = "a    b";
        assert_eq!(word_range_for_offset(t, 2), 2..2); // middle of spaces
    }

    #[test]
    pub(crate) fn word_range_handles_underscores_and_unicode() {
        // Byte offsets: é is 2 bytes, so "héllo" spans bytes 14..20.
        let t = "let foo_bar = héllo;";
        assert_eq!(word_range_for_offset(t, 4), 4..11); // "foo_bar"
        assert_eq!(word_range_for_offset(t, 5), 4..11); // inside "foo_bar"
        assert_eq!(word_range_for_offset(t, 10), 4..11); // end of "foo_bar"
        assert_eq!(word_range_for_offset(t, 14), 14..20); // "héllo"
        assert_eq!(word_range_for_offset(t, 16), 14..20); // mid-multibyte word
        assert_eq!(&t[word_range_for_offset(t, 12)], "="); // lone symbol
    }

    #[test]
    pub(crate) fn word_range_at_string_edges() {
        assert_eq!(word_range_for_offset("word", 0), 0..4);
        assert_eq!(word_range_for_offset("word", 3), 0..4); // last char
        assert_eq!(word_range_for_offset("word", 4), 0..4); // past end → word
        assert_eq!(word_range_for_offset("", 0), 0..0);
        assert_eq!(word_range_for_offset("  ", 1), 1..1); // whitespace only
    }

    #[test]
    pub(crate) fn shape_cache_skips_reshape_only_when_every_input_is_unchanged() {
        let px = |v| Pixels::from(v as f32);
        let display = "x".repeat(65_000);
        let marked = Some(0usize..4);

        // Same inputs => reuse the stored layout (the idle blink /
        // redundant-notify case that previously re-shaped the whole draft).
        assert!(ComposerInput::shape_inputs_unchanged(
            &display,
            300.0,
            px(14.0),
            false,
            &marked,
            &display,
            300.0,
            px(14.0),
            false,
            &marked,
        ));

        // Any single change invalidates the cache.
        assert!(!ComposerInput::shape_inputs_unchanged(
            &display,
            300.0,
            px(14.0),
            false,
            &marked,
            &display,
            300.0,
            px(14.0),
            false,
            &None,
        )); // marked text changed (IME)
        assert!(!ComposerInput::shape_inputs_unchanged(
            &display,
            300.0,
            px(14.0),
            false,
            &marked,
            &format!("{}y", display),
            300.0,
            px(14.0),
            false,
            &marked,
        )); // a keystroke changed the text
        assert!(!ComposerInput::shape_inputs_unchanged(
            &display,
            300.0,
            px(14.0),
            false,
            &marked,
            &display,
            640.0,
            px(14.0),
            false,
            &marked,
        )); // a compact to expanded flip changed the width
        assert!(!ComposerInput::shape_inputs_unchanged(
            &display,
            300.0,
            px(14.0),
            false,
            &marked,
            &display,
            300.0,
            px(16.0),
            false,
            &marked,
        )); // font size changed
        assert!(!ComposerInput::shape_inputs_unchanged(
            &display,
            300.0,
            px(14.0),
            false,
            &marked,
            "Do anything",
            300.0,
            px(14.0),
            true,
            &marked,
        )); // placeholder mode toggled
    }

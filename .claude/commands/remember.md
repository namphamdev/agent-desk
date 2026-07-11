---
description: Capture a team lesson into project memory journal (not INDEX)
---

Capture durable **team** knowledge from this conversation into project memory.

## Rules

1. Write under `docs/memory/` only — never secrets or personal prefs.
2. Default: append to `docs/memory/journal/YYYY-MM.md` (current month; create if needed).
3. Do **not** dump long text into `docs/memory/INDEX.md` (keep INDEX small).
4. If the user names a topic and the fact is already curated, you may add a short bullet to the matching `docs/memory/topics/*.md` file instead.
5. If this is a procedure (multi-step how-to), prefer a skill under `.claude/skills/` over memory prose.
6. If this is an architecture decision, add/update an ADR under `docs/architecture/09-architecture-decisions/` and only link from memory.

## Journal entry format

```markdown
## YYYY-MM-DD — short title
- Context:
- Lesson:
- Promote to: topics/<file>.md | skill | arc42 | discard
```

## After writing

- Show the user the path and a one-line summary.
- Mention they can run `/memory-promote` later to move journal → topics.

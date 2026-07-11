---
description: Promote journal lessons into topic memory files; keep INDEX small
---

Promote project memory from journal into curated topics.

## Steps

1. Read `docs/memory/INDEX.md` and note the character budget.
2. Read recent entries in `docs/memory/journal/` (current and previous month).
3. For each entry, decide:
   - **topic** — short durable fact → `docs/memory/topics/<file>.md`
   - **skill** — multi-step procedure → `.claude/skills/<name>/SKILL.md`
   - **arc42** — structural decision → ADR + architecture section
   - **discard** — ephemeral or already covered
4. Apply edits surgically (small bullets, stable headings).
5. Update `INDEX.md` **only if**:
   - a new topic file must be listed, or
   - a true hot fact belongs in the always-loaded list  
   Never paste full topic content into INDEX.
6. Remove or mark journal lines as promoted so the journal stays a scratchpad.
7. Summarize for the user: what moved where; warn if INDEX or any topic is near/over budget (~1500 chars INDEX, ~2–4k per topic).

## Do not

- Merge everything into one MEMORY.md
- Put secrets in any memory file
- Duplicate AGENTS.md or full arc42 sections into topics

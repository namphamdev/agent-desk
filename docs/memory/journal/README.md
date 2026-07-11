# Memory journal

Append-only (by month) capture of session lessons. **Not** imported into `CLAUDE.md`.

## How to use

1. Add notes to `YYYY-MM.md` (create the file for the current month if missing).
2. Run `/memory-promote` (or manually) to move durable facts into `docs/memory/topics/`.
3. Delete or mark promoted lines so the journal stays a scratchpad, not a second wiki.

## Format

```markdown
## YYYY-MM-DD — short title
- Context:
- Lesson:
- Promote to: topics/<file>.md | skill | arc42 | discard
```

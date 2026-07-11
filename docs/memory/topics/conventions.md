# Conventions

> Soft cap ~2–4k chars. Durable team conventions only.

## Agent coding guidelines

- Source of truth: repo root `AGENTS.md` (Karpathy-style: think first, simplicity, surgical diffs, goal-driven checks).
- `CLAUDE.md` imports `AGENTS.md` and this memory index — do not duplicate long guideline text here.

## Git / PR

- Knowledge files (`docs/memory/**`, `docs/architecture/**`) are reviewed like code.
- Prefer topic-scoped memory edits over bloating `INDEX.md`.
- Do not commit secrets, credentials, or personal access tokens.

## Docs split

| Kind | Where |
| --- | --- |
| Architecture | `docs/architecture/` |
| Short team facts | `docs/memory/topics/` |
| Raw capture | `docs/memory/journal/` |
| Procedures | `.claude/skills/` or project skills dirs |

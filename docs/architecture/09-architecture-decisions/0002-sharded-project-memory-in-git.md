# ADR 0002: Sharded project memory in git

- **Status:** Accepted
- **Date:** 2026-07-11

## Context

Team-shared memory should sync when developers commit and pull. A single always-loaded `MEMORY.md` will grow into the largest prompt attachment, increase merge conflicts, and force crude global compaction.

Hermes-style single bounded files fit **personal** agents. **Project** memory is multi-author and long-lived.

## Decision

1. Memory is **project-scoped** and lives under `docs/memory/` in the git tree.
2. Layout:
   - `INDEX.md` — only file always imported (catalog + hot facts; keep small)
   - `topics/*.md` — one concern per file; durable facts
   - `journal/YYYY-MM.md` — raw capture; **not** always loaded; promote then trim
3. No single system-of-record `MEMORY.md`.
4. Soft/hard budgets: INDEX ~1500 chars; topics ~2–4k chars each; journal unbounded but offline to the default prompt.
5. Secrets never belong in memory files.
6. Personal preferences stay out of shared memory (local/gitignored only).

## Consequences

### Positive

- Prompt cost stays bounded (INDEX only)
- Topic-level PRs and fewer merge conflicts
- Capture (journal) decoupled from curated truth (topics)
- Fits Claude `@import` progressive reading

### Negative

- Agents must follow INDEX and open topic files when needed
- Requires promote discipline (`/memory-promote` or human review)
- Slightly more files to scaffold

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| One `MEMORY.md` with hard char cap | Cap fights growth; still one merge hotspot; team history lost or crushed |
| SQLite/vector DB in repo | Poor PR review; weaker portability; overkill for v1 |
| App-data global memory only | Does not sync to teammates on commit |
| Stuff everything into `AGENTS.md` | Mixes behavior rules with facts; unbounded |

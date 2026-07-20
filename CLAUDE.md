@AGENTS.md
@docs/memory/INDEX.md

# Architecture

Canonical architecture: `docs/architecture/` (arc42).
Read relevant sections before large structural changes.
Record decisions as ADRs under `docs/architecture/09-architecture-decisions/`.

# Memory

Team memory: `docs/memory/` (git-synced).

- **Always loaded:** `docs/memory/INDEX.md` only (keep it small).
- **Durable facts:** `docs/memory/topics/*.md` — open when INDEX says so.
- **Raw capture:** `docs/memory/journal/YYYY-MM.md` — not always loaded.
- **Commands:** `/remember` (capture), `/memory-promote` (journal → topics).
- **No secrets** or personal prefs in shared memory.
- **Procedures** → skills under `.claude/skills/`, not long memory essays.

Stop hook (in `.claude/settings.json`): after each turn, a prompt-type Stop gate asks whether a team-durable lesson should be journaled before the agent fully stops. Prefer approve when unsure; never store secrets.

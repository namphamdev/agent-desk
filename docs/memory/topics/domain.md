# Domain

> Soft cap ~2–4k chars. Product/domain facts that agents need often.

## What terminal-react is

- Desktop ACP **host** that renders agent output as rich HTML (markdown, code, Mermaid, diffs, tool cards, plans).
- Not a replacement for Claude Code’s tool loop — it drives agents over ACP and displays results.

## Core concepts

| Concept | Meaning |
| --- | --- |
| Session | One agent conversation; persisted locally in SQLite |
| Timeline | Ordered UI model produced by `reduce()` from ACP updates |
| Project cwd | Folder the agent runs in; source of git-synced docs/memory |
| Harness | Applies project agent optimizations (e.g. AGENTS.md, skills) |
| Skills | On-demand `SKILL.md` procedures |
| Memory | Sharded team facts under `docs/memory/` (not session DB) |

## Architecture pointer

For building blocks, runtime, and ADRs see `docs/architecture/README.md`.

# Project memory index

> **Budget:** keep this file under ~1500 characters.  
> **Always loaded** via `CLAUDE.md`. Put detail in `topics/` or `journal/`, not here.

## Hot facts

- Stack: Electrobun + Bun main + React/Vite webview; tests via `bun test`
- Agent protocol: ACP; Claude Code via `claude-agent-acp`; Grok via `grok agent stdio`; Droid via `droid exec --output-format acp`
- App data (local, not team memory): `~/.terminal-react/`
- Architecture home: `docs/architecture/` (arc42) — do not paste full design here

## Topics (read when relevant)

| Topic | File | When |
| --- | --- | --- |
| Conventions | [topics/conventions.md](./topics/conventions.md) | style, commits, PR, agent behavior |
| Tooling | [topics/tooling.md](./topics/tooling.md) | env, scripts, CI, hooks |
| Domain | [topics/domain.md](./topics/domain.md) | product behavior, ACP/UI concepts |
| Incidents | [topics/incidents.md](./topics/incidents.md) | recurring bugs / gotchas |

## Journal

Raw session lessons: [journal/](./journal/) (`YYYY-MM.md`).  
**Not** imported into the default prompt. Promote into topics, then trim.

## Rules

1. Team-shared only — no personal prefs, no secrets.
2. One concern per topic file; compact instead of endless append.
3. Procedures → `.claude/skills/`, not memory essays.
4. Architecture changes → arc42 section + ADR; link from here if needed.

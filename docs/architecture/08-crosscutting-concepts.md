# 8. Cross-cutting concepts

## 8.1 Render contract

- Webview only consumes local types (`src/session/types.ts`).
- Timeline is always `reduce(events)` — live, replay, and fixtures share one path.

## 8.2 Capability gating

- FS and similar capabilities are opt-in via settings.
- Permissions for agent tools surface as explicit UI.

## 8.3 Project vs personal knowledge

| Kind | Location | Git |
| --- | --- | --- |
| Team architecture | `docs/architecture/` | Yes |
| Team memory | `docs/memory/` | Yes |
| Team skills | `.claude/skills/`, `.agents/skills/` | Yes when project-scoped |
| Personal prefs | Local / gitignored | No |
| Session transcripts | App SQLite | No |

## 8.4 Memory size discipline

- **INDEX.md**: hard practical budget (~1500 chars). Catalog + hot facts only.
- **topics/\*.md**: one concern per file; soft cap (~2–4k chars); compact in place.
- **journal/**: monthly files; not imported into `CLAUDE.md`; promote then trim.
- Never store secrets, tokens, or credentials in memory or skills.

## 8.5 Security

- Shared memory is injected into agent context → treat as trusted team content only.
- Review memory/skill PRs like code.
- Optional future: write-path guards (hooks) limiting memory writes to `docs/memory/`.

## 8.6 Simplicity (product)

Follow `AGENTS.md`: no speculative frameworks; prefer files agents already load over new databases for team knowledge.

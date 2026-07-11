# 4. Solution strategy

## 4.1 Core ideas

1. **ACP host, not agent harness** — keep render types and reducer pure; Bun translates wire ACP.
2. **Claude Code first for learning** — use `CLAUDE.md` imports, project hooks, slash commands, and skills the agent already understands.
3. **Git-backed team knowledge** — project memory and architecture are repo files; PR is the approval path.
4. **Sharded memory** — always-load a small `INDEX.md`; durable facts in topic files; raw capture in journal (not always loaded).
5. **arc42 as architecture home** — deep design lives under `docs/architecture/`; memory only points at it.
6. **Progressive disclosure** — skills and topic files load when needed; avoid one mega-context file.

## 4.2 Technology choices

| Choice | Rationale |
| --- | --- |
| Electrobun | Lightweight desktop + Bun native |
| React + Vite webview | Rich rendering, existing UI investment |
| `bun:sqlite` | Local multi-session history |
| Markdown memory/arc42 | Human + agent + git friendly |
| Project harness | One apply path for AGENTS.md / skills / (later) memory scaffold |

## 4.3 Learning-loop strategy (Claude Code)

```text
Session work
  → capture candidates in docs/memory/journal/YYYY-MM.md
  → promote durable facts into docs/memory/topics/*.md
  → keep docs/memory/INDEX.md short (catalog + hot facts)
  → procedures → .claude/skills/*/SKILL.md
  → architecture changes → arc42 section + ADR
  → git commit / PR → team sync
```

terminal-react’s role over time:

| Phase | Host responsibility |
| --- | --- |
| Now (docs) | Templates + ADRs + CLAUDE.md pointers |
| Next | Harness apply for layout; Memory UI |
| Later | Review session → staged memory/skill patches |

## 4.4 Deliberate non-goals (v1)

- Single unbounded `MEMORY.md`
- Cloud memory providers
- Mid-session system-prompt mutation of the entire memory corpus
- Full Hermes skills hub inside terminal-react

# Tooling

> Soft cap ~2–4k chars. Env, commands, and agent tooling quirks.

## Commands

```bash
bun install
bun run dev          # Electrobun desktop
bun run dev:web      # Vite webview mock
bun run typecheck
bun test
bunx vite build
```

## Paths

| Path | Role |
| --- | --- |
| `~/.terminal-react/` | Local sessions DB, settings, agents.json |
| `TERMINAL_REACT_DATA` | Override app data dir |
| `docs/memory/` | Team-shared memory (git) |
| `docs/architecture/` | arc42 architecture (git) |

## Claude Code (project)

- Entry: `CLAUDE.md` (`@AGENTS.md`, `@docs/memory/INDEX.md`)
- Commands: `.claude/commands/remember.md`, `memory-promote.md`
- Skills: project `.claude/skills/` (and harness-managed packages)
- Stop hook: `.claude/settings.json` prompt-type gate (scaffolded by project-memory harness) nudges journal capture when a team-durable lesson was not written; example at `.claude/settings.example.json`

## Agents

- Configure ACP agents in `~/.terminal-react/agents.json`
- Claude Code is not ACP-native; use `claude-agent-acp`
- Grok Build is ACP-native: `grok agent stdio` (binary in `~/.grok/bin`, which is on the augmented PATH)
- Auth: Claude via app Providers / `ANTHROPIC_*`; Grok via `grok login` or `XAI_API_KEY`

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
- Optional hooks: see `.claude/settings.example.json` (copy into local/project settings as needed)

## Agents

- Configure ACP agents in `~/.terminal-react/agents.json`
- Claude Code is not ACP-native; use `claude-agent-acp`

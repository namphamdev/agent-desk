# 6. Runtime view

## 6.1 Live agent turn (existing)

```text
User types prompt
  → webview RPC sendPrompt
  → SessionManager → ACP session/prompt
  → agent streams session/update
  → translate → reduce → timeline UI
  → optional permission prompts
  → turn ends (or cancel)
```

## 6.2 Session history

- Raw ACP events persisted in SQLite under `~/.terminal-react/` (override `TERMINAL_REACT_DATA`).
- Replay rehydrates via the same reducer as live streaming.
- Local history is **not** team memory and is **not** git-synced.

## 6.3 Learning capture (target; Claude Code)

```text
During / after session
  → agent or /remember appends to docs/memory/journal/YYYY-MM.md
  → optional Stop hook nudges capture (Claude project settings)
  → human or /memory-promote moves durable lines into topics/*.md
  → INDEX.md updated only for hot facts or new topic rows
  → procedures become .claude/skills/<name>/SKILL.md
  → git add/commit/PR → teammates pull
```

## 6.4 Architecture change

```text
Significant design change
  → update arc42 section(s)
  → add ADR under 09-architecture-decisions/
  → optional one-line pointer in docs/memory/INDEX.md or topics/
  → do not paste full ADR into memory
```

## 6.5 Project harness apply (existing + future)

Today: writes `AGENTS.md`, `CLAUDE.md` pointer, skill packages under project skill dirs.

Future: also scaffold `docs/memory/*`, example commands, and documented hook snippets if missing.

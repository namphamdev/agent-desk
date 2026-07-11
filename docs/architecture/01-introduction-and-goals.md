# 1. Introduction and goals

## 1.1 Summary

**terminal-react** is a desktop “terminal” that renders coding-agent output as rich React/HTML (Markdown, code, Mermaid, diffs, tool cards, plans) instead of a flat TUI. It integrates with agents via the [Agent Client Protocol (ACP)](https://agentclientprotocol.com) and is built on Electrobun (Bun + system webview).

## 1.2 Stakeholders

| Stakeholder | Interest |
| --- | --- |
| Individual developers | Fast, readable agent sessions with multi-project history |
| Small teams | Shared project memory and architecture docs via git |
| Future contributors | Clear architecture (this arc42 set) and small diffs |

## 1.3 Quality goals (priority order)

1. **Faithful live rendering** — ACP streams must map cleanly to a stable timeline model.
2. **Agent portability** — host stays ACP-centric; first-class support starts with Claude Code.
3. **Team-shared project knowledge** — memory and architecture live in-repo and sync on commit/PR.
4. **Simplicity** — minimal speculative abstraction; surgical product surface.
5. **Safety** — permissions, no secrets in shared memory, user control over agent actions.

## 1.4 Product scope (current)

In scope today:

- Multi-session ACP host with SQLite history
- Rich timeline (markdown, mermaid, diffs, tools, plans, permissions)
- Project open / harness (AGENTS.md, skills)
- Skills install/enable UI
- Remote LAN access (optional)

Planned / designed (see ADRs):

- Claude Code–first learning loop (hooks + prompts)
- Sharded project memory under `docs/memory/`
- arc42 as architecture home
- Host UI for memory review / promote (later)

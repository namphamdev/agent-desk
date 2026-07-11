# 2. Constraints

## 2.1 Technical constraints

| Constraint | Implication |
| --- | --- |
| ACP as agent boundary | terminal-react is a **host**, not the agent runtime |
| Electrobun + Bun + webview | Desktop process model; RPC between Bun main and React view |
| Claude Code first | Learning loop uses Claude hooks, `CLAUDE.md`, project skills/commands |
| Git as team sync | Shared memory and arc42 must be plain files in the repo |
| Existing skills roots | Prefer `~/.agents/skills` and project `.claude/skills` / `.agents/skills` |

## 2.2 Organizational constraints

| Constraint | Implication |
| --- | --- |
| Small / solo-friendly codebase | Avoid Hermes-scale product surface |
| Team PRs review shared knowledge | Memory writes are reviewable diffs |
| No cloud memory service in v1 | No Mem0/Honcho requirement |

## 2.3 Conventions

- Behavioral rules for agents: `AGENTS.md` (Karpathy-style guidelines).
- Architecture: `docs/architecture/` (arc42).
- Team memory: `docs/memory/` (sharded; see ADR 0002).
- Personal overrides: gitignored local files only (e.g. `CLAUDE.local.md` if used).

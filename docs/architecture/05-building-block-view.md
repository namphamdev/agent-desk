# 5. Building block view

## 5.1 Level 1 — system

```text
terminal-react
├── Bun main process (Electrobun)
│   ├── ACP client + SessionManager
│   ├── SQLite store
│   ├── Agents / settings / skills / harness
│   └── RPC handlers
├── React mainview
│   ├── Timeline (reducer-driven)
│   ├── Sidebar / prompt / permissions
│   └── Settings / skills / harness UI
└── Project repo (external to app binary)
    ├── Source code
    ├── docs/architecture (arc42)
    ├── docs/memory (sharded)
    └── .claude (hooks, skills, commands)
```

## 5.2 Level 2 — host modules (code)

| Block | Location | Responsibility |
| --- | --- | --- |
| ACP client | `src/bun/acp-client.ts` | Spawn agent, prompt, cancel, updates |
| Session manager | `src/bun/session-manager/` | Multi-session lifecycle |
| Store | `src/bun/store.ts` | SQLite persistence |
| Translate | `src/bun/translate.ts` | Wire ACP → local types |
| Reducer | `src/session/reducer.ts` | Updates → timeline |
| Skills | `src/bun/skills.ts` | List/install/enable skills |
| Project harness | `src/bun/project-harness.ts` | Apply AGENTS.md / skill packages |
| RPC contract | `src/shared/rpc.ts` | Typed host ↔ view API |
| UI | `src/mainview/` | React shell and renderers |

## 5.3 Level 2 — project knowledge blocks (repo)

| Block | Path | Always in prompt? |
| --- | --- | --- |
| Agent guidelines | `AGENTS.md` | Yes (via CLAUDE.md) |
| Memory index | `docs/memory/INDEX.md` | Yes |
| Memory topics | `docs/memory/topics/*.md` | No — on demand |
| Memory journal | `docs/memory/journal/*` | No |
| Architecture | `docs/architecture/*` | No — on demand |
| Claude skills | `.claude/skills/` | Progressive / trigger |
| Claude commands | `.claude/commands/` | On slash invoke |

## 5.4 Whitebox: knowledge flow

```text
CLAUDE.md
  ├─ @AGENTS.md
  └─ @docs/memory/INDEX.md
         │
         ├─ points to → topics/*.md
         ├─ points to → journal/
         └─ points to → docs/architecture/
```

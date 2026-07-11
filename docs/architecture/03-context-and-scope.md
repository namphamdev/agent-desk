# 3. Context and scope

## 3.1 Business context

```text
┌────────────┐     prompts / UI      ┌──────────────────┐
│  Developer │◄─────────────────────►│  terminal-react  │
└────────────┘                       └────────┬─────────┘
                                              │ ACP (stdio JSON-RPC)
                                              ▼
                                     ┌──────────────────┐
                                     │  Coding agent    │
                                     │  (Claude Code    │
                                     │   via ACP, …)    │
                                     └────────┬─────────┘
                                              │ tools: FS, shell, git
                                              ▼
                                     ┌──────────────────┐
                                     │  Project repo    │
                                     │  code + docs/    │
                                     │  memory + arc42  │
                                     └──────────────────┘
```

## 3.2 Technical context

| Neighbor | Interface | Notes |
| --- | --- | --- |
| Claude Code (+ `claude-agent-acp`) | ACP | Primary agent; hooks/prompts/skills in project |
| Other ACP agents | ACP | Same host path; learning hooks may be Claude-only |
| Project filesystem | Files | Source of truth for code, memory, arc42 |
| Git remote | Git | Team sync of memory + architecture |
| `~/.terminal-react/` | Local app data | Sessions DB, settings — **not** team memory |
| Skills hubs / CLI | Optional install | Managed via skills UI / CLI |

## 3.3 Scope boundary

| In scope (host) | Out of scope (host) |
| --- | --- |
| Spawn/drive ACP agents | Replacing Claude Code’s tool loop |
| Scaffold project harness + memory layout | Global personal profile modeling (Honcho-class) |
| Render sessions; local history | Cloud multi-tenant memory |
| UI to view/edit project memory (planned) | Training / fine-tuning models |

## 3.4 External interfaces (summary)

- **RPC** (`src/shared/rpc.ts`): webview ↔ Bun main.
- **ACP**: Bun ↔ agent process (`src/bun/acp-client.ts`).
- **SQLite**: session/events/settings under app data dir.

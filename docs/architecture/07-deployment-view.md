# 7. Deployment view

## 7.1 Desktop app

| Piece | Notes |
| --- | --- |
| Packaging | Electrobun macOS (primary); Windows/Linux later |
| Runtime | Bun main + system webview |
| App data | `~/.terminal-react/` (sessions, settings) |
| Agent binaries | Configured in `~/.terminal-react/agents.json` (on PATH or absolute) |

## 7.2 Project workspace

Each opened project folder is the agent `cwd`. Team-shared knowledge is **in that folder’s git tree**:

```text
<project>/
  docs/architecture/
  docs/memory/
  AGENTS.md
  CLAUDE.md
  .claude/
```

## 7.3 Distribution status

- Local/dev and canary builds exist under `build/` / `artifacts/`.
- Signed notarized distribution and auto-update remain partial (see milestone plan).

## 7.4 Remote access (optional)

- LAN HTTP/WebSocket server for phone/browser viewing and messaging.
- Requires built `dist/`; not the primary knowledge-sync path (git is).

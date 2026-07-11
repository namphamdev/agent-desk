# AgentDesk

A desktop app that renders coding-agent output as rich React/HTML
(Markdown, syntax-highlighted code, **Mermaid diagrams**, file diffs,
tool-call cards, plans) instead of a flat TUI. Integration target is the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com). Built on
[Electrobun](https://github.com/blackboardsh/electrobun) (Bun + system webview).

## Status — Milestones 1–5

| Milestone | Goal | Status |
| --- | --- | --- |
| M1 | Rich rendering pipeline (fixture-driven) | ✅ |
| M2 | Live ACP agent over stdio + RPC bridge | ✅ |
| M3 | Interactive loop: prompts, permissions, cancel | ✅ |
| M4 | Multi-session, persistence, history | ✅ |
| M5 | Polish (lazy Mermaid, theme, settings) | ✅ (partial — no signed distro yet) |

## Run

```bash
bun install

# Webview via Vite (browser mock of the RPC bridge — demo agent only)
bun run dev:web    # → http://localhost:5173

# Electrobun desktop app (spawns agents, SQLite, editor open)
bun run dev

# Electrobun + Vite HMR
bun run dev:hmr
```

Verify:

```bash
bun run typecheck
bun test
bunx vite build
```

## Configure agents

On first launch the app writes `~/.terminal-react/agents.json`. Edit it to
point at your ACP-capable agent binary.

**Claude Code is not ACP-native.** Use the official adapter:

```bash
npm i -g @agentclientprotocol/claude-agent-acp
# binary: claude-agent-acp  (also installs a deprecated alias claude-code-acp)
```

```json
{
  "defaultAgentId": "claude-code",
  "agents": [
    {
      "id": "claude-code",
      "name": "Claude Code (ACP)",
      "command": "claude-agent-acp",
      "args": []
    }
  ]
}
```

Switch the default in Settings or the JSON file.

If you see `Executable not found in $PATH: "…"`, the `command` field does not
resolve. Fix the path/name in `~/.terminal-react/agents.json`.

Sessions, settings, and raw ACP events live under
`~/.terminal-react/sessions.sqlite` (override with `TERMINAL_REACT_DATA`).

## Structure

```
docs/
  architecture/           # arc42 + ADRs (canonical design)
  memory/                 # sharded team memory (INDEX + topics + journal)
src/
  bun/
    index.ts              # Electrobun main — RPC + SessionManager
    acp-client.ts         # spawn agent, ACP initialize/prompt/cancel
    session-manager/      # multi-session orchestration (manager, agent connection, helpers)
    store.ts              # bun:sqlite persistence
    agents.ts             # ~/.terminal-react/agents.json
    translate.ts          # wire ACP → local render types
    settings.ts
  shared/rpc.ts           # typed Electrobun RPC contract
  session/
    types.ts              # render-focused ACP model
    reducer.ts            # pure: session/update stream → timeline
  fixtures/demo.ts        # recorded session for Demo agent
  mainview/               # React webview
    App.tsx
    rpc.ts                # Electroview client (+ browser mock)
    components/
      Sidebar / Header / PromptInput / Timeline
      PermissionPrompt / SettingsPanel / ConnectionBanner
      content/            # Markdown, Mermaid (lazy), DiffView
      entries/            # ToolCallCard, PlanView
```

Architecture and team memory are git-synced under `docs/`. See [`docs/README.md`](docs/README.md).

## Features

- **Live streaming** of markdown, code, Mermaid, diffs, tool calls, plans
- **Permissions** UI for `session/request_permission` (allow once/always, deny)
- **Stop** mid-turn via `session/cancel`
- **Clickable file locations** → open in `$EDITOR` / Settings editor command
- **Multi-session sidebar** with SQLite history across restarts
- **Review in new session** — header **Review** summarizes file edits/diffs from the current chat, opens a fresh session with that summary, and auto-sends a structured review prompt as the first requirement
- **Open project** — New task picks a folder (native dialog + recent projects); agent `cwd` is that folder
- **Settings**: theme (dark/light/system), editor, default agent, FS capabilities
- **Remote access** — phone icon in the sidebar footer; QR code + LAN URL with a
  random access code so a browser on the same Wi‑Fi can view sessions and send
  messages (uses a local HTTP/WebSocket server; requires a built `dist/`)
- **Lazy Mermaid** — diagram types code-split out of the main bundle

## Protocol notes

- Render types stay in `src/session/types.ts`; Bun translates live ACP wire
  types so the webview stays portable and unit-testable.
- All timeline state goes through `reduce()` — live stream, replay, and the
  demo fixture render identically.
- Filesystem ACP capabilities are **off by default** (Settings toggle).
- The official `@agentclientprotocol/sdk` runs under Bun for the stdio client.

## Build (macOS & Windows)

Electrobun packages for the **host platform only**. Build on a Mac for macOS
artifacts and on Windows (or CI) for Windows artifacts.

```bash
# Local / debug bundle (unsigned, no installer)
bun run build

# Distribution channel builds → build/ + artifacts/
bun run build:canary   # pre-release channel
bun run build:stable   # production channel
```

| Platform | Outputs |
| --- | --- |
| **macOS** | `build/canary-macos-*/AgentDesk-canary.app`, DMG + update tarball under `artifacts/` |
| **Windows** | App folder under `build/canary-win-*/`, self-extracting Setup `.exe` under `artifacts/` |

CI: `.github/workflows/build.yml` runs canary on `main`/PRs and stable on `v*`
tags for both `macos-latest` and `windows-latest`, then attaches artifacts (and
creates a GitHub Release on tags).

### Signing & auto-update (optional)

Unsigned builds work for local testing. For shipping:

1. **macOS** — set `build.mac.codesign` / `notarize` to `true` in
   `electrobun.config.ts` and provide Apple credentials via env:
   `ELECTROBUN_APPLEID`, `ELECTROBUN_APPLEIDPASS`, `ELECTROBUN_TEAMID`
   (or App Store Connect API key vars).
2. **Updates** — set `release.baseUrl` to a static host (S3/R2/GitHub Releases)
   and `release.generatePatch: true` for delta patches.

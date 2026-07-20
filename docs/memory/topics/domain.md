# Domain

> Soft cap ~2–4k chars. Product/domain facts that agents need often.

## What terminal-react is

- Desktop ACP **host** that renders agent output as rich HTML (markdown, code, Mermaid, diffs, tool cards, plans).
- Not a replacement for Claude Code’s or Grok Build’s tool loop — it drives agents over ACP and displays results.

## Core concepts

| Concept | Meaning |
| --- | --- |
| Session | One agent conversation; persisted locally in SQLite |
| ACP idle offload | Live ACP process auto-killed after 1h without agent activity (connect/prompt/turn-end/cancel); chat history kept; reconnect on next use |
| Timeline | Ordered UI model produced by `reduce()` from ACP updates |
| Project cwd | Folder the agent runs in; source of git-synced docs/memory |
| Harness | Applies project agent optimizations (e.g. AGENTS.md, skills) |
| Workflow | New-task mode with harness-aware first prompt; built-ins in `src/session/workflows.ts`, global overrides in Settings, project replace via `.terminal-react/workflows.json` |
| Skills | On-demand `SKILL.md` procedures |
| Memory | Sharded team facts under `docs/memory/` (not session DB) |
| Browser MCP | Server **`browser`** registered on every `session/new`, bound via `TR_BROWSER_SESSION_ID` to that chat. Tools include `browser_session_info`, `browser_open`, navigate/snapshot/click, store/list tokens. System prompt append + `ENABLE_TOOL_SEARCH=""` keep tools discoverable. Tokens in SQLite per project cwd; injected on prompt. |
| Git Changes | Header icon left of **Review** opens a panel: status/diff/stage/commit for project cwd. **AI message** runs a one-shot ACP turn (`generateGitCommitMessage`) for subject + body; does not use the chat session. |

## Architecture pointer

For building blocks, runtime, and ADRs see `docs/architecture/README.md`.

# terminal-react

A desktop "terminal" that renders coding-agent output as rich React/HTML
(Markdown, syntax-highlighted code, **Mermaid diagrams**, file diffs,
tool-call cards, plans) instead of a flat TUI. Integration target is the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com). Built on
[Electrobun](https://github.com/blackboardsh/electrobun) (Bun + system webview).

## Status — Milestone 1 (rendering pipeline)

The rich rendering pipeline is working and driven by a recorded ACP fixture:
- A pure reducer (`src/session/reducer.ts`) turns a stream of ACP
  `session/update` notifications into an ordered **timeline**.
- Content renderers handle Markdown (GFM), syntax-highlighted code, **Mermaid**,
  file diffs, images, and resource links.
- The UI shell (sidebar, header, timeline, input bar) is built from the
  original `ui.html` design as React + Tailwind components.

No live agent yet — the demo session is in `src/fixtures/demo.ts`.

## Run

```bash
bun install

# Webview via Vite dev server (fastest iteration, browser-like)
bun run dev:web    # → http://localhost:5173

# Electrobun desktop app (no HMR): builds then launches the window
bun run dev

# Electrobun desktop app with Vite HMR
bun run dev:hmr
```

Verify (typecheck + unit tests):
```bash
bun run typecheck
bun test          # or: bunx vitest run --config vitest.config.ts
```

## Structure

```
src/
  bun/index.ts              # Electrobun main process — opens the window (M2: spawns ACP agent)
  session/
    types.ts                # ACP content/tool/plan/timeline types (render-focused)
    reducer.ts              # pure: session/update stream → timeline
    reducer.test.ts
  fixtures/demo.ts          # recorded session: markdown/code/mermaid/diff/tool-call/plan
  mainview/                 # the webview (React app)
    App.tsx
    index.css               # Tailwind v4 + theme tokens from ui.html + prose-chat
    components/
      Sidebar/Header/PromptInput.tsx
      Timeline.tsx
      content/              # Markdown, CodeBlock(via highlight), MermaidDiagram, DiffView, Content
      entries/              # ToolCallCard, PlanView
```

## Roadmap

- **M2 — live agent:** Bun main process spawns an ACP agent (e.g. Claude Code)
  over stdio using `@agentclientprotocol/sdk` and forwards `session/update`
  notifications to the webview via Electrobun typed RPC. The renderer is reused
  unchanged.
- **M3 — interaction:** prompts, permission requests, follow-along file
  locations, command/mode switching.
- **Perf:** lazy-load Mermaid diagram types to shrink the bundle.

## Note on Electrobun + Node SDK

The official ACP SDK (`@agentclientprotocol/sdk`) is Node-oriented. Electrobun's
main process runs on Bun; for M2 we'll either use the SDK under Bun (it's
mostly JSON-RPC over stdio) or implement the thin client portion directly. This
only affects the Bun side — the webview rendering pipeline is already done.

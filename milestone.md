# Milestone Plan — terminal-react

A desktop "terminal" that renders coding-agent output as rich React/HTML
(Markdown, syntax-highlighted code, Mermaid diagrams, file diffs, tool-call
cards, plans) instead of a flat TUI. Integrates with coding agents via the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com). Built on
[Electrobun](https://github.com/blackboardsh/electrobun) (Bun + system webview).

This document is the full roadmap. Each milestone has a goal, scope, concrete
tasks, a definition of done, and open questions. Milestones are meant to be
shipped sequentially; later ones depend on earlier ones.

---

## Status at a glance

| Milestone | Goal | Status |
| --- | --- | --- |
| M1 | Rich rendering pipeline (fixture-driven) | ✅ Done |
| M2 | Live ACP agent over stdio + RPC bridge | ✅ Done |
| M3 | Interactive loop: prompts, permissions, follow-along | ✅ Done |
| M4 | Multi-session, persistence, history | ✅ Done |
| M5 | Polish, distribution, auto-update | 🟡 Partial |

---

## M1 — Rich rendering pipeline ✅

**Goal:** prove the core value — take a stream of ACP `session/update` events
and render them as styled HTML in React.

**Done:**
- Pure reducer (`src/session/reducer.ts`) mapping `session/update` → ordered timeline.
- Content renderers: Markdown (GFM), syntax-highlighted code (rehype-highlight),
  **Mermaid** diagrams, file diffs (line-level), images, resource links.
- UI shell rebuilt from `ui.html` as React + Tailwind: Sidebar, Header, Timeline
  (user bubble + agent markdown + tool-call cards + plan checklist), PromptInput.
- Electrobun main process opens the window (HMR-aware).
- Recorded fixture (`src/fixtures/demo.ts`) exercises every renderer.
- Typecheck clean, 4 reducer unit tests pass, Vite build succeeds.

**Verification:**
```bash
bun run typecheck && bunx vitest run --config vitest.config.ts && bunx vite build
```

---

## M2 — Live ACP agent over stdio + RPC bridge ✅

**Goal:** connect to a real coding agent (e.g. Claude Code) via ACP and stream
its output through the existing renderer. The webview should feel live, not
fixture-driven.

**Done:**
- `@agentclientprotocol/sdk` under Bun (`src/bun/acp-client.ts`): spawn, initialize,
  `session/new`, prompt, drain `session/update` via `ActiveSession.nextUpdate()`.
- Wire → local translation in `src/bun/translate.ts` (incl. `agent_thought_chunk`
  → `thought_sequence_chunk`, plan `status` → `state`).
- Typed Electrobun RPC contract in `src/shared/rpc.ts`; Bun handlers in
  `src/bun/index.ts`; webview client in `src/mainview/rpc.ts` (browser mock for
  `dev:web`).
- PromptInput sends `sendPrompt`; timeline grows via `reduce()` as chunks arrive.
- Agent discovery from `~/.terminal-react/agents.json` (+ built-in Demo fixture agent).
- Connection banner for connecting / ready / error states.

**Definition of done (met):** open the app, type a prompt, watch the Demo agent
stream markdown + code + diffs + tool calls; configure a real binary in
`agents.json` for live ACP. Follow-ups accumulate in the same session.

---

## M3 — Interactive loop: permissions, cancellation, follow-along ✅

**Goal:** make the session fully interactive and safe — the user controls what
the agent is allowed to do, can interrupt it, and can jump to the files it's
touching.

**Done:**
- `session/request_permission` → `PermissionPrompt` card with allow once/always
  and reject options; responses flow back over RPC.
- Session-scoped `allow_always` allowlist per tool kind on the Bun side.
- Stop button + Esc → `session/cancel`; prompting state clears on turn end.
- Clickable tool-call locations → `openFile` RPC → `$EDITOR` / Settings command.
- `/commands` picker from `available_commands_update`; mode pill from
  `current_mode_update`.
- Thoughts render as collapsible dimmed blocks.

---

## M4 — Multi-session, persistence, history ✅

**Goal:** treat this like a real workspace — multiple sessions/projects in the
sidebar, resumable history, and a way to browse past work.

**Done:**
- `src/bun/store.ts` — SQLite schema (sessions, events, settings) via `bun:sqlite`.
- `SessionManager` creates/lists/switches/deletes sessions; one agent connection
  at a time; full raw events persisted for re-derive.
- Sidebar lists real sessions grouped by project; search; New task.
- Replay: `onSessionLoaded` rehydrates timeline through the same reducer.
- Optional FS capabilities behind Settings toggle (`fs/read_text_file`,
  `fs/write_text_file`).

**Data dir:** `~/.terminal-react/` (override with `TERMINAL_REACT_DATA`).

---

## M5 — Polish, distribution, auto-update 🟡

**Goal:** ship a small, fast, signed, auto-updating desktop app.

**Done:**
- Mermaid dynamic import + manual chunk (`mermaid` split out of the critical path).
- Theme tokens as CSS variables; dark / light / system via Settings.
- Settings screen persisted to SQLite (editor, theme, default agent, FS flag).
- Timeline uses `content-visibility: auto` for long sessions; thoughts collapsible.
- Accessibility: permission dialog focus, ARIA labels on tool status, `role="log"`
  on timeline, Stop button label.

**Remaining (needs release credentials / CI):**
1. Electrobun build pipeline: code signing + notarization.
2. Built-in updater channel config for delta updates.
3. Cross-platform CI matrix (Windows WebView2, Linux webkit2gtk).

**Definition of done (shipping):** a signed macOS build under ~15MB (post Mermaid
lazy load), with auto-update wired. Local unsigned `bun run build` works today.

---

## Cross-cutting decisions

- **Render types vs. wire types:** the renderer only ever sees the local types
  in `src/session/types.ts`. The Bun side owns the translation from live ACP.
  This keeps the webview portable and the reducer unit-testable without an agent.
- **Reducer as the contract:** the timeline is always the output of `reduce()`.
  Live streaming, replay, and fixtures all flow through the same reducer, so
  they render identically.
- **Bun + official SDK:** `@agentclientprotocol/sdk` works under Bun for the
  thin JSON-RPC-over-stdio client path.
- **Capability-gated features:** fs/terminal/command features are opt-in and
  off by default; surfaced as settings, never silently enabled.

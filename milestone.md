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
| M2 | Live ACP agent over stdio + RPC bridge | 🔜 Next |
| M3 | Interactive loop: prompts, permissions, follow-along | ⏳ Planned |
| M4 | Multi-session, persistence, history | ⏳ Planned |
| M5 | Polish, distribution, auto-update | ⏳ Planned |

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

## M2 — Live ACP agent over stdio + RPC bridge 🔜

**Goal:** connect to a real coding agent (e.g. Claude Code) via ACP and stream
its output through the existing renderer. The webview should feel live, not
fixture-driven.

**Scope (in):**
- Spawn an ACP agent as a subprocess from the Bun main process.
- Speak JSON-RPC 2.0 over stdio: `initialize` → `session/new` → `session/prompt`.
- Receive `session/update` notifications and forward each to the webview over
  Electrobun typed RPC.
- Translate wire-level ACP types into the local render types
  (`src/session/types.ts`) on the Bun side, so the renderer stays decoupled.
- Wire the PromptInput to actually send a prompt (`session/prompt`) and reset
  the timeline.
- Handle a second prompt in the same session (turn accumulation).

**Scope (out):** permissions, cancellation, modes/commands, multiple sessions
(those land in M3/M4).

**Tasks:**
1. Add `@agentclientprotocol/sdk` and evaluate whether it runs under Bun.
   - If yes → use it as the stdio client.
   - If no → implement the thin client portion directly (JSON-RPC framing over
     stdio; it's small). Decide with a spike first.
2. `src/bun/acp-client.ts` — encapsulates agent lifecycle: spawn, `initialize`,
   negotiate capabilities/protocol version, `session/new`, send a prompt,
   expose an async-iterator/callback for `session/update`.
3. `src/shared/rpc.ts` — typed Electrobun RPC contract:
   - webview → bun: `sendPrompt(text)`, `cancel()`, `listAgents()`.
   - bun → webview: `onUpdate(update)` (one `session/update` at a time), `onTurnEnd(stopReason)`.
4. `src/bun/index.ts` — register RPC handlers, hold the active session, pump
   updates to the webview.
5. `src/mainview` — replace the fixture with a live `useEffect` that subscribes
   to `onUpdate`, feeds each into `reduce()`, and re-renders the timeline.
   Keep reducer-based streaming (messages grow as chunks arrive).
6. Agent discovery: read available agents from a config file
   (`~/.terminal-react/agents.json`) — name + command + args, so users point at
   their own Claude Code / Codex / Gemini CLI binary.
7. Loading + connection states in the UI (connecting / ready / error), with a
   clear error surface when the agent fails to initialize.

**Definition of done:** open the app, type a prompt, watch the real agent stream
markdown + code + diffs + tool calls into the rich renderer, then ask a
follow-up in the same session.

**Open questions / risks:**
- Does `@agentclientprotocol/sdk` work under Bun, or only Node? (Spike first.)
- Which agent binary do we target first — Claude Code? Confirm it speaks ACP
  over stdio and the spawn flags.
- Stderr from the agent process — log it, but don't let it crash the window.

---

## M3 — Interactive loop: permissions, cancellation, follow-along

**Goal:** make the session fully interactive and safe — the user controls what
the agent is allowed to do, can interrupt it, and can jump to the files it's
touching.

**Scope (in):**
- **Permissions:** handle `session/request_permission` (client method). Show an
  approve/deny UI for tool calls (e.g. "run `npm test`?", "edit foo.ts?") with
  the diff/command preview. Choices: allow once / always / deny. Respond over
  RPC back to the Bun side.
- **Cancellation:** `session/cancel` notification wired to a Stop button; the
  timeline shows where it stopped.
- **Follow-along file locations:** `ToolCallLocation[]` already exist in the
  model — make them clickable to open the file at a line. (Electrobun can shell
  out to the user's `$EDITOR`, or open in a built-in viewer later.)
- **Modes & slash commands:** render `current_mode` and
  `available_commands_update` — a `/commands` picker and mode switch in the
  PromptInput (mirrors the model/effort selectors already there).
- **Thoughts:** render `thought_sequence_chunk` entries as collapsible,
  dimmed blocks (already modeled as role `"thought"`).

**Scope (out):** fs/terminal capability passthrough (M4 candidate), persistent
allowlists.

**Tasks:**
1. Extend `src/shared/rpc.ts`: `requestPermission(payload)`,
   `respondPermission(id, decision)`, `cancel()`.
2. `PermissionPrompt` component — modal/inline card with the tool kind, title,
  preview (diff or command), and allow/deny buttons.
3. Permission state machine on the Bun side: queue pending requests, match
  responses by id, apply "always" allowlists per tool kind for the session.
4. Stop button in PromptInput → `session/cancel`; mark the active tool call as
  cancelled in the timeline.
5. Clickable locations → `openFile(path, line)` RPC → Bun shells out to editor.
6. `/commands` dropdown populated from `available_commands_update`; mode pill
  reflecting `current_mode`.

**Definition of done:** agent asks to run a command; user approves/denies from
the UI; the decision reaches the agent and execution proceeds or aborts. User
can mid-stream cancel, and click a file location to open it.

**Open questions / risks:**
- Granularity of "always" allowlists — per path glob? Per command? Keep it
  simple first (per tool kind for the session), refine in M5.
- Permission UX must not block the stream rendering.

---

## M4 — Multi-session, persistence, history

**Goal:** treat this like a real workspace — multiple sessions/projects in the
sidebar, resumable history, and a way to browse past work.

**Scope (in):**
- **Multiple sessions:** `session/new` per project/task; the sidebar (already
  present in the UI) drives session switching. Live sessions stay warm.
- **Resume:** `session/load` for agents that support it; load prior sessions
  and replay their timeline.
- **Persistence:** store session transcripts (the reduced timeline + raw events)
  to local SQLite (Electrobun-friendly) under a data dir. Survive restart.
- **History view:** browse/search past sessions; click to reopen.
- **fs & terminal capabilities (optional):** if the user opts in, implement the
  client-side `fs/read_text_file`, `fs/write_text_file`, `terminal/*` methods
  so the agent operates on the real workspace. Capability-gated.

**Scope (out):** cloud sync, team sharing.

**Tasks:**
1. Data layer: `src/bun/store.ts` — SQLite schema for sessions, entries, raw
  events. Use `bun:sqlite`.
2. Session manager on the Bun side: create/list/load/switch, one active agent
  process per live session.
3. Replay: hydrate a stored timeline into the reducer's output shape so the
  renderer shows past sessions without a live agent.
4. Sidebar wiring: real projects/tasks from the store; active state.
5. (Optional) fs/terminal capability handlers — behind a settings toggle.

**Definition of done:** start a session for project A, switch to project B,
return to A and see its history; restart the app and past sessions are still
there.

**Open questions / risks:**
- How much raw event data to persist (full vs. reduced). Lean toward full
  events + derived timeline, so future renderer changes re-derive cleanly.
- SQLite under Electrobun on all target platforms — verify macOS first (primary).

---

## M5 — Polish, distribution, auto-update

**Goal:** ship a small, fast, signed, auto-updating desktop app.

**Scope (in):**
- **Bundle size:** lazy-load Mermaid diagram types (the biggest chunk today,
  ~1MB eager). Code-split per content renderer.
- **Streaming UX:** token-by-token animation, smooth auto-scroll with "jump to
  bottom", virtualization for long timelines.
- **Theming:** system/light/dark, and expose the `#1a1a1a` tokens as a real
  theme (not hardcoded classes).
- **Accessibility:** keyboard nav through the timeline, focus management on
  permission prompts, screen-reader labels for tool-call status.
- **Settings UI:** agent config, default model/effort, editor command, data dir.
- **Distribution:** Electrobun `build` for macOS (primary), code signing +
  notarization, and the built-in updater for delta updates.
- **Cross-platform smoke:** confirm the system webview path works on Windows
  (WebView2) and Linux; bundleCEF only as a fallback.

**Tasks:**
1. Mermaid lazy loading + dynamic import per diagram type.
2. Virtualized timeline (`@tanstack/react-virtual` or similar).
3. Theme tokens extracted to CSS variables; settings-driven.
4. Settings screen persisted to the data dir.
5. Electrobun build pipeline: signing, notarization, update channel config.
6. Cross-platform CI matrix; smoke test per OS.

**Definition of done:** a signed macOS build under ~15MB (post Mermaid lazy
load), with auto-update wired, that a user can install and that updates itself.

**Open questions / risks:**
- Code-signing certs / notarization credentials needed for distribution.
- WKWebView (macOS) vs WebView2 (Windows) rendering quirks — budget time for
  per-OS CSS/feature testing.

---

## Cross-cutting decisions

- **Render types vs. wire types:** the renderer only ever sees the local types
  in `src/session/types.ts`. The Bun side owns the translation from live ACP.
  This keeps the webview portable and the reducer unit-testable without an agent.
- **Reducer as the contract:** the timeline is always the output of `reduce()`.
  Live streaming, replay, and fixtures all flow through the same reducer, so
  they render identically.
- **Bun vs. Node for ACP:** the official SDK is Node-oriented; Electrobun runs
  Bun. M2 starts by spiking the SDK under Bun and falls back to a hand-rolled
  thin client (the protocol is small JSON-RPC over stdio).
- **Capability-gated features:** fs/terminal/command features are opt-in and
  off by default; surfaced as settings, never silently enabled.

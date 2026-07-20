# Incidents / gotchas

> Soft cap ~2–4k chars. Recurring failures and fixes. Prefer short bullets.

## Template for new entries

```markdown
### Short title (YYYY-MM)
- Symptom:
- Cause:
- Fix / avoid:
```

## Known

### Executable not found for agent
- Symptom: connection error about missing command
- Cause: `agents.json` `command` not on PATH
- Fix: install adapter (e.g. `claude-agent-acp`) or use absolute path

### Single MEMORY.md growth (design)
- Symptom: always-loaded memory becomes huge
- Cause: one-file memory pattern
- Fix: use sharded `docs/memory/` (INDEX + topics + journal) — ADR 0002

### Windows resize click-through after enlarge (2026-07)
- Symptom: after growing the window on Windows, clicks in the new area pass through to windows behind
- Cause: Electrobun `transparent: true` uses layered windows; expanded client area stays non-hittable until/while WebView2 bounds lag
- Fix / avoid: keep `transparent: false` on `win32` (`src/bun/index.ts`); macOS can stay transparent for rounded corners. Prefer `titleBarStyle: "hiddenInset"` on Windows so the frame stays resizable.

### Maximize buries bottom under taskbar (2026-07)
- Symptom: header double-click / traffic-light maximize puts the bottom ~30–40px of the app under the Windows taskbar
- Cause: native `maximize()` on `titleBarStyle: "hiddenInset"` can size to full monitor bounds, not the work area
- Fix / avoid: custom maximize snaps to `Screen.getAllDisplays()` work area (`maximizeToWorkArea` in `src/bun/index.ts`, geometry in `window-geometry.ts`)

### POSIX-only shellouts (pgrep/ps) ENOENT on Windows (2026-07)
- Symptom: `[acp] memory sample failed: ... ENOENT "pgrep"` every poll interval on Windows; memory meter dead
- Cause: `collectDescendantPids` / `sampleProcessTreeRssBytes` (`src/bun/acp-client.ts`) shelled out to `pgrep`/`ps`, absent on win32
- Fix / avoid: branch on `process.platform === "win32"`. Windows uses PowerShell — `Get-CimInstance Win32_Process -Filter 'ParentProcessId=<pid>'` for children, `Get-Process -Id <pids> | Measure-Object WorkingSet64 -Sum` for RSS. Any spawn of a Unix tool needs a Windows branch.

### Windows GUI PATH missing node for npm shims (2026-07)
- Symptom: `[agent:claude-code] '"node"' is not recognized…` then `ACP connection closed` when connecting from packaged/dev desktop build
- Cause: GUI process PATH had `%APPDATA%\npm` (so `claude-agent-acp.cmd` resolved) but not `C:\Program Files\nodejs`, and npm global shims invoke bare `node`
- Fix / avoid: `commonUserBinDirs` on win32 includes official Node install + common version managers; `buildAugmentedPath` case-insensitive dedupe on Windows

### Windows app shows Bun logo (2026-07)
- Symptom: taskbar/exe icon is Bun’s logo instead of AgentDesk
- Cause: Electrobun CLI embeds icons via `require.resolve("rcedit/...")` baked to CI path `D:\a\electrobun\...`; rcedit fails, EXEs keep Bun resources. `build.win.icon` is otherwise correct (`assets/icon.ico`).
- Fix / avoid: `scripts/embed-win-icon.mjs` via electrobun `scripts.postBuild` + `postPackage` in `electrobun.config.ts`. Runtime process is `bun.exe`; launcher also needs embed. Windows icon cache may need rebuild/restart after fixing.

### Timeline jumps while streaming ACP (2026-07)
- Symptom: chat viewport thrash / jump up-down as agent tokens stream
- Cause: dual stick-to-bottom (LegendList `maintainScrollAtEnd` + custom `scrollToEnd` every chunk/`onItemSizeChanged`) raced each other; per-token React updates amplified measure
- Fix / avoid: one pin path only (built-in maintain on dataChange+itemLayout, not parent layout); rAF-batch message chunks in `applyUpdate`

### Memory not updated after agent turn (2026-07)
- Symptom: team lessons from a session never land in `docs/memory/journal/`
- Cause: harness only shipped `.claude/settings.example.json` with a no-op `echo` Stop hook; Claude never loaded it unless manually copied
- Fix / avoid: project-memory apply merges a **prompt-type** Stop gate into `.claude/settings.json` (can block stop until journaled when a durable lesson exists). Re-apply harness or ensure settings contain `PROJECT_MEMORY_STOP_HOOK`.


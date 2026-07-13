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

### POSIX-only shellouts (pgrep/ps) ENOENT on Windows (2026-07)
- Symptom: `[acp] memory sample failed: ... ENOENT "pgrep"` every poll interval on Windows; memory meter dead
- Cause: `collectDescendantPids` / `sampleProcessTreeRssBytes` (`src/bun/acp-client.ts`) shelled out to `pgrep`/`ps`, absent on win32
- Fix / avoid: branch on `process.platform === "win32"`. Windows uses PowerShell — `Get-CimInstance Win32_Process -Filter 'ParentProcessId=<pid>'` for children, `Get-Process -Id <pids> | Measure-Object WorkingSet64 -Sum` for RSS. Any spawn of a Unix tool needs a Windows branch.

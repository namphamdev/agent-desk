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

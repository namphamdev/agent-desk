# 10. Quality requirements

## 10.1 Quality tree (selected)

| Quality | Scenario | Target |
| --- | --- | --- |
| Correctness | ACP stream → timeline | Same reducer path for live and replay |
| Performance | Long sessions | Timeline remains usable (`content-visibility`, lazy Mermaid) |
| Context efficiency | Agent session start | Always-loaded project imports stay small (INDEX + AGENTS) |
| Team sync | Memory/architecture change | Reviewable git diff; no proprietary blob |
| Maintainability | New contributor / agent | arc42 + ADRs explain structure without reading all of `src/` |
| Safety | Shared memory | No secrets; PR review for knowledge files |
| Portability | Agent switch | Markdown + ACP; Claude hooks optional |

## 10.2 Memory-specific quality rules

| Rule | Measure |
| --- | --- |
| INDEX size | Prefer ≤ ~1500 characters |
| Topic cohesion | One primary concern per `topics/*.md` file |
| Journal hygiene | Promote or drop entries within a reasonable period (e.g. monthly) |
| Link not copy | Architecture details link to `docs/architecture/`, not pasted |

## 10.3 Verification (engineering)

```bash
bun run typecheck
bun test
bunx vite build
```

Architecture/memory changes: human review of markdown diffs; no separate test harness required for v1 docs.

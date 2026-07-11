# 11. Risks and technical debt

## 11.1 Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| INDEX grows into a second mega-file | Context bloat | Budget + promote to topics; review in PRs |
| Journal never promoted | Lost lessons / noise | `/memory-promote` command; periodic hygiene |
| Agents ignore topic files | Wrong behavior | Clear INDEX table; skills for recurring workflows |
| Secrets committed to memory | Security incident | Policy in CLAUDE.md/INDEX; code review; future hooks |
| Docs drift from code | Misleading architecture | Update arc42/ADR in same PR as structural changes |
| Claude-only hooks | Uneven multi-agent learning | Accept for v1 (ADR 0001); shared markdown still helps others |
| ACP/agent variance | Features work in CLI not host | Test Claude via `claude-agent-acp` in TR |

## 11.2 Technical debt (product)

| Item | Notes |
| --- | --- |
| M5 distribution | Signing, notarization, auto-update incomplete |
| Memory harness apply | Templates exist; automatic scaffold from TR UI not built yet |
| Memory UI | View/edit/promote still manual / Claude commands |
| Session FTS | Local SQLite search not implemented |
| Multi-agent learning | Explicitly deferred |

## 11.3 Debt we accept

- Markdown over a dedicated knowledge graph for v1
- Human PR as write-approval instead of in-app staging (for now)

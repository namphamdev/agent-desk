# Architecture documentation (arc42)

Canonical architecture for **terminal-react**. Agents and humans should read here for “how the system is built”; use `docs/memory/` for short team lessons only.

| § | Section | File |
| --- | --- | --- |
| 1 | Introduction and goals | [01-introduction-and-goals.md](./01-introduction-and-goals.md) |
| 2 | Constraints | [02-constraints.md](./02-constraints.md) |
| 3 | Context and scope | [03-context-and-scope.md](./03-context-and-scope.md) |
| 4 | Solution strategy | [04-solution-strategy.md](./04-solution-strategy.md) |
| 5 | Building block view | [05-building-block-view.md](./05-building-block-view.md) |
| 6 | Runtime view | [06-runtime-view.md](./06-runtime-view.md) |
| 7 | Deployment view | [07-deployment-view.md](./07-deployment-view.md) |
| 8 | Cross-cutting concepts | [08-crosscutting-concepts.md](./08-crosscutting-concepts.md) |
| 9 | Architecture decisions (ADRs) | [09-architecture-decisions/](./09-architecture-decisions/) |
| 10 | Quality requirements | [10-quality-requirements.md](./10-quality-requirements.md) |
| 11 | Risks and technical debt | [11-risks-and-technical-debt.md](./11-risks-and-technical-debt.md) |
| 12 | Glossary | [12-glossary.md](./12-glossary.md) |

## Related project knowledge

| Store | Path | Purpose |
| --- | --- | --- |
| Memory index | [`docs/memory/INDEX.md`](../memory/INDEX.md) | Always-on catalog of team facts |
| Memory topics | [`docs/memory/topics/`](../memory/topics/) | Sharded durable facts |
| Journal | [`docs/memory/journal/`](../memory/journal/) | Raw lessons (not always loaded) |
| Agent behavior | [`AGENTS.md`](../../AGENTS.md) | Coding guidelines |
| Claude entry | [`CLAUDE.md`](../../CLAUDE.md) | Imports for Claude Code |

## Maintenance

- Prefer a new ADR under `09-architecture-decisions/` over rewriting history in place.
- Update the relevant arc42 section when structure or runtime behavior changes.
- Do **not** copy large architecture prose into memory files — link here instead.

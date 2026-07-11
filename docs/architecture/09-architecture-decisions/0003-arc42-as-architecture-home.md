# ADR 0003: arc42 as architecture home

- **Status:** Accepted
- **Date:** 2026-07-11

## Context

The project needs a durable place for architecture that:

- Humans can navigate
- Agents can open on demand
- Does not bloat every session prompt
- Separates **stable design** from **volatile lessons** (memory) and **procedures** (skills)

## Decision

1. Use **arc42** under `docs/architecture/` as the canonical architecture documentation.
2. Record significant decisions as **ADRs** in `09-architecture-decisions/`.
3. `CLAUDE.md` / memory **point** at arc42; they do not duplicate full sections.
4. When architecture changes, update the relevant arc42 section and/or add an ADR in the same PR when practical.

## Consequences

### Positive

- Shared structure for contributors and agents
- Clear split: arc42 (why/how system) vs memory (lessons) vs skills (how-to)
- Progressive disclosure: load only needed sections

### Negative

- Docs can rot if PRs skip updates (mitigate via review culture + occasional memory pointer)
- Twelve sections can feel heavy — keep sections short; empty detail is OK until needed

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Architecture only in README | Becomes a grab-bag; hard to version decisions |
| C4-only diagrams without prose template | Diagrams help but ADRs/constraints still needed |
| Memory files as architecture | Wrong lifetime and size profile (see ADR 0002) |

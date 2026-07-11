# ADR 0001: Claude Code first for the learning loop

- **Status:** Accepted
- **Date:** 2026-07-11

## Context

We want Hermes-like self-improvement (capture lessons, grow procedural skills) inside the terminal-react ecosystem. terminal-react is an **ACP host**, not an agent runtime. Reimplementing memory tools and background review inside every agent would be expensive and agent-specific.

Claude Code already provides:

- `CLAUDE.md` hierarchy and `@imports`
- Project hooks (lifecycle, PreToolUse, Stop, …)
- Project skills and slash commands / custom prompts
- ACP adapter (`claude-agent-acp`) used by this app

## Decision

1. Implement the **v1 learning loop for Claude Code only**.
2. Prefer **files + hooks + commands** Claude already loads over host-only proprietary stores.
3. terminal-react may later **scaffold and visualize** these files (harness, Memory UI, review promote) without owning the model loop.
4. Other ACP agents can still read `AGENTS.md`, skills, and markdown memory; Claude-specific hooks remain optional for them.

## Consequences

### Positive

- Fast path to real learning without building a second harness
- Same behavior in CLI Claude Code and TR-hosted Claude
- Team gets value from git-synced files regardless of UI maturity

### Negative

- Hook automation is Claude-centric until ported
- Quality of auto-capture still depends on the model following prompts/hooks

## Alternatives considered

| Alternative | Why not (now) |
| --- | --- |
| Host-owned memory tools via MCP only | Requires every agent’s MCP support; still need file layout for git sync |
| Full Hermes clone in-process | Wrong product boundary; huge scope |
| Agent-agnostic auto-review in Bun always | Possible later; v1 uses Claude commands/hooks + optional TR review session |

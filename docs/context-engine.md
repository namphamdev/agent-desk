# Local code-context engine

Comet automatically starts
[`vibervn-context-engine`](https://github.com/nullmastermind/vibervn-context-engine)
when an engine starts. It reuses a server already listening on `127.0.0.1:6699`,
or launches the latest published package through `npx`. Claude Code and Codex
then receive `http://127.0.0.1:6699/mcp` as the `codebase-retrieval` MCP server.

On first use, open <http://127.0.0.1:6699> to configure the embedding provider
and API key required for semantic indexing. Context-engine data is kept under
the engine's own settings path. Comet launches it from
`<comet-data-dir>/context-engine/` and writes process output to
`context-engine.log` there.

The headed app exposes the integration under **Settings → Code context**. The
toggle is persisted locally and takes effect when the Comet engine next starts;
the dashboard action opens the context-engine configuration UI.

The integration is best-effort. Comet continues to run if Node.js, `npx`, or a
supported context-engine binary is unavailable.

Environment overrides:

- `COMET_CONTEXT_ENGINE=off` disables automatic startup and MCP registration.
- `COMET_CONTEXT_ENGINE_EXECUTABLE=/absolute/path/to/vibervn-context-engine`
  uses an existing binary instead of a global install or `npx`.

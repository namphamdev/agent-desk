import { useCallback, useEffect, useState } from "react";
import type { AgentSetupStatus } from "../../../shared/rpc";
import { getRpc } from "../../rpc";
import { StatusDot } from "./StatusDot";

export function ClaudeCodeTab() {
  const [status, setStatus] = useState<AgentSetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedInstall, setCopiedInstall] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await getRpc().request.getAgentSetup();
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ensureConfig = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await getRpc().request.ensureAgentSetup();
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const openConfig = async () => {
    if (!status?.configPath) return;
    setError(null);
    try {
      const res = await getRpc().request.openFile({ path: status.configPath });
      if (!res.ok) {
        setError(res.error ?? "Could not open agents.json");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const copyInstall = async () => {
    const cmd = status?.installCommand;
    if (!cmd) return;
    try {
      await navigator.clipboard?.writeText(cmd);
      setCopiedInstall(true);
      setTimeout(() => setCopiedInstall(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-[11px] leading-relaxed text-gray-500">
        Claude Code is not ACP-native. This app talks to it through the official
        adapter{" "}
        <code className="text-gray-400">claude-agent-acp</code>. Check that the
        binary is on PATH and that{" "}
        <code className="text-gray-400">~/.terminal-react/agents.json</code>{" "}
        points at it.
      </p>

      {error && (
        <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {loading && !status ? (
        <div className="py-8 text-center text-xs text-gray-500">
          Checking setup…
        </div>
      ) : status ? (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[#2e2e2e] bg-[#121212] px-3 py-2.5">
            <StatusDot
              ok={status.ready}
              label={status.ready ? "Ready to connect" : "Setup incomplete"}
            />
            <button
              type="button"
              disabled={loading || busy}
              onClick={() => void refresh()}
              className="ml-auto rounded-md border border-[#333] px-2.5 py-1 text-xs text-gray-300 hover:bg-[#2a2a2a] disabled:opacity-50"
            >
              {loading ? "Checking…" : "Re-check"}
            </button>
          </div>

          <div className="space-y-2">
            <span className="block text-xs font-medium uppercase tracking-wider text-gray-500">
              Prerequisites
            </span>
            <ul className="space-y-2 rounded-lg border border-[#2e2e2e] bg-[#121212] p-3 text-xs">
              <li className="flex flex-col gap-0.5">
                <StatusDot
                  ok={status.claudeAcpOk}
                  label={
                    status.claudeAcpOk
                      ? "claude-agent-acp found"
                      : "claude-agent-acp not found on PATH"
                  }
                />
                {status.claudeAcpPath && (
                  <code className="ml-3.5 break-all font-mono text-[10px] text-gray-500">
                    {status.claudeAcpPath}
                  </code>
                )}
              </li>
              <li className="flex flex-col gap-0.5">
                <StatusDot
                  ok={status.claudeCliOk}
                  label={
                    status.claudeCliOk
                      ? "claude CLI found (optional)"
                      : "claude CLI not found (optional)"
                  }
                />
                {status.claudeCliPath && (
                  <code className="ml-3.5 break-all font-mono text-[10px] text-gray-500">
                    {status.claudeCliPath}
                  </code>
                )}
              </li>
              <li className="flex flex-col gap-0.5">
                <StatusDot
                  ok={status.configExists}
                  label={
                    status.configExists
                      ? "agents.json present"
                      : "agents.json missing"
                  }
                />
                <code className="ml-3.5 break-all font-mono text-[10px] text-gray-500">
                  {status.configPath}
                </code>
              </li>
            </ul>
          </div>

          <div className="space-y-2">
            <span className="block text-xs font-medium uppercase tracking-wider text-gray-500">
              Install adapter
            </span>
            <div className="flex items-stretch gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md border border-[#333] bg-[#121212] px-2.5 py-2 font-mono text-[11px] text-gray-200">
                {status.installCommand}
              </code>
              <button
                type="button"
                onClick={() => void copyInstall()}
                className="shrink-0 rounded-md border border-[#333] bg-[#222] px-3 text-xs text-gray-200 hover:bg-[#2a2a2a]"
              >
                {copiedInstall ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="text-[11px] text-gray-500">
              Run in a terminal, then Re-check. GUI apps may not see shell PATH —
              Homebrew, npm, and bun bins are auto-added.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {!status.configExists && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void ensureConfig()}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {busy ? "Writing…" : "Write default agents.json"}
              </button>
            )}
            {status.configExists && (
              <button
                type="button"
                onClick={() => void openConfig()}
                className="rounded-md border border-[#333] px-3 py-1.5 text-xs text-gray-300 hover:bg-[#2a2a2a]"
              >
                Open agents.json
              </button>
            )}
          </div>

          <div className="space-y-2">
            <span className="block text-xs font-medium uppercase tracking-wider text-gray-500">
              Configured agents
            </span>
            {status.agents.length === 0 ? (
              <p className="rounded-lg border border-dashed border-[#333] px-3 py-4 text-center text-[11px] text-gray-600">
                No agents in config. Write the default file or edit agents.json.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {status.agents.map((a) => (
                  <li
                    key={a.id}
                    className="rounded-lg border border-[#2e2e2e] bg-[#121212] px-3 py-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-xs text-gray-200">
                          <span className="font-medium">{a.name}</span>
                          {a.id === status.defaultAgentId && (
                            <span className="rounded bg-[#2a2a2a] px-1.5 py-0.5 text-[10px] text-gray-400">
                              default
                            </span>
                          )}
                        </div>
                        <code className="mt-0.5 block truncate font-mono text-[10px] text-gray-500">
                          {a.command}
                          {a.args.length > 0 ? ` ${a.args.join(" ")}` : ""}
                        </code>
                        {a.resolvedPath && (
                          <code className="mt-0.5 block break-all font-mono text-[10px] text-gray-600">
                            → {a.resolvedPath}
                          </code>
                        )}
                      </div>
                      <StatusDot ok={a.ok} label={a.ok ? "Found" : "Missing"} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

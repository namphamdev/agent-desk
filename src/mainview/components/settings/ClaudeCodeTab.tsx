/**
 * Settings → Claude Code / Agents: diagnose ACP agent binaries
 * (claude-agent-acp + Grok Build) and agents.json.
 */
import { useCallback, useEffect, useState } from "react";
import type {
  AgentPackageId,
  AgentPackageUpdateStatus,
  AgentSetupStatus,
} from "../../../shared/rpc";
import { getRpc } from "../../rpc";
import { Button } from "@/components/ui/button";
import { StatusDot } from "./StatusDot";

function versionLine(status: AgentPackageUpdateStatus | null | undefined): string {
  if (!status) return "Not checked yet";
  if (status.error && !status.currentVersion && !status.latestVersion) {
    return status.error;
  }
  const cur = status.currentVersion ?? "unknown";
  const latest = status.latestVersion ?? "unknown";
  if (status.updateAvailable) {
    return `Update available: ${cur} → ${latest}`;
  }
  if (status.currentVersion && status.latestVersion) {
    return `Up to date (${cur})`;
  }
  if (status.currentVersion) {
    return `Installed ${cur}`;
  }
  return status.error || "Could not determine version";
}

export function ClaudeCodeTab() {
  const [status, setStatus] = useState<AgentSetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedInstall, setCopiedInstall] = useState<"claude" | "grok" | null>(
    null,
  );
  const [claudeUpdate, setClaudeUpdate] =
    useState<AgentPackageUpdateStatus | null>(null);
  const [grokUpdate, setGrokUpdate] =
    useState<AgentPackageUpdateStatus | null>(null);
  const [checking, setChecking] = useState<AgentPackageId | "all" | null>(null);
  const [updating, setUpdating] = useState<AgentPackageId | null>(null);

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

  const copyInstall = async (kind: "claude" | "grok") => {
    const cmd =
      kind === "claude" ? status?.installCommand : status?.grokInstallCommand;
    if (!cmd) return;
    try {
      await navigator.clipboard?.writeText(cmd);
      setCopiedInstall(kind);
      setTimeout(() => setCopiedInstall(null), 1500);
    } catch {
      /* ignore */
    }
  };

  const checkUpdate = async (pkg: AgentPackageId) => {
    setChecking(pkg);
    setError(null);
    try {
      const next = await getRpc().request.checkAgentPackageUpdate({ package: pkg });
      if (pkg === "claude") setClaudeUpdate(next);
      else setGrokUpdate(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(null);
    }
  };

  const checkAllUpdates = async () => {
    setChecking("all");
    setError(null);
    try {
      const [claude, grok] = await Promise.all([
        getRpc().request.checkAgentPackageUpdate({ package: "claude" }),
        getRpc().request.checkAgentPackageUpdate({ package: "grok" }),
      ]);
      setClaudeUpdate(claude);
      setGrokUpdate(grok);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(null);
    }
  };

  const runUpdate = async (pkg: AgentPackageId) => {
    setUpdating(pkg);
    setError(null);
    try {
      const result = await getRpc().request.updateAgentPackage({ package: pkg });
      if (result.status) {
        if (pkg === "claude") setClaudeUpdate(result.status);
        else setGrokUpdate(result.status);
      }
      if (!result.ok) {
        setError(result.error);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdating(null);
    }
  };

  const actionBusy = busy || checking != null || updating != null;

  return (
    <div className="space-y-4">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        This app is an ACP host. Configure agents in{" "}
        <code className="text-muted-foreground">~/.terminal-react/agents.json</code>.
        Claude Code uses the adapter{" "}
        <code className="text-muted-foreground">claude-agent-acp</code>; Grok Build speaks
        ACP natively via{" "}
        <code className="text-muted-foreground">grok agent stdio</code>.
      </p>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {loading && !status ? (
        <div className="py-8 text-center text-xs text-muted-foreground">
          Checking setup…
        </div>
      ) : status ? (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
            <StatusDot
              ok={status.ready}
              label={status.ready ? "Ready to connect" : "Setup incomplete"}
            />
            <div className="ml-auto flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={actionBusy || loading}
                onClick={() => void checkAllUpdates()}
              >
                {checking === "all" ? "Checking updates…" : "Check updates"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loading || actionBusy}
                onClick={() => void refresh()}
              >
                {loading ? "Checking…" : "Re-check"}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Prerequisites
            </span>
            <ul className="space-y-2 rounded-lg border border-border bg-background p-3 text-xs">
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
                  <code className="ml-3.5 break-all font-mono text-[10px] text-muted-foreground">
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
                  <code className="ml-3.5 break-all font-mono text-[10px] text-muted-foreground">
                    {status.claudeCliPath}
                  </code>
                )}
              </li>
              <li className="flex flex-col gap-0.5">
                <StatusDot
                  ok={status.grokOk}
                  label={
                    status.grokOk
                      ? "grok found"
                      : "grok not found on PATH (~/.grok/bin)"
                  }
                />
                {status.grokPath && (
                  <code className="ml-3.5 break-all font-mono text-[10px] text-muted-foreground">
                    {status.grokPath}
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
                <code className="ml-3.5 break-all font-mono text-[10px] text-muted-foreground">
                  {status.configPath}
                </code>
              </li>
            </ul>
          </div>

          <div className="space-y-2">
            <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Package updates
            </span>
            <ul className="space-y-2 rounded-lg border border-border bg-background p-3 text-xs">
              <li className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="font-medium text-foreground">
                    Claude ACP adapter
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {versionLine(claudeUpdate)}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={actionBusy}
                    onClick={() => void checkUpdate("claude")}
                  >
                    {checking === "claude" ? "Checking…" : "Check"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={
                      actionBusy ||
                      (claudeUpdate != null &&
                        !claudeUpdate.updateAvailable &&
                        claudeUpdate.installed)
                    }
                    onClick={() => void runUpdate("claude")}
                  >
                    {updating === "claude"
                      ? "Updating…"
                      : claudeUpdate?.installed
                        ? "Update"
                        : "Install / update"}
                  </Button>
                </div>
              </li>
              <li className="flex flex-col gap-2 border-t border-border pt-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="font-medium text-foreground">Grok ACP</div>
                  <div className="text-[11px] text-muted-foreground">
                    {versionLine(grokUpdate)}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={actionBusy || !status.grokOk}
                    onClick={() => void checkUpdate("grok")}
                  >
                    {checking === "grok" ? "Checking…" : "Check"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={
                      actionBusy ||
                      !status.grokOk ||
                      (grokUpdate != null && !grokUpdate.updateAvailable)
                    }
                    onClick={() => void runUpdate("grok")}
                  >
                    {updating === "grok" ? "Updating…" : "Update"}
                  </Button>
                </div>
              </li>
            </ul>
            <p className="text-[11px] text-muted-foreground">
              Claude uses{" "}
              <code className="text-muted-foreground">npm i -g …claude-agent-acp</code>
              . Grok uses <code className="text-muted-foreground">grok update</code>.
            </p>
          </div>

          <div className="space-y-2">
            <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Install Claude Code adapter
            </span>
            <div className="flex items-stretch gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[11px] text-foreground">
                {status.installCommand}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void copyInstall("claude")}
                className="shrink-0"
              >
                {copiedInstall === "claude" ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Install Grok Build
            </span>
            <div className="flex items-stretch gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[11px] text-foreground">
                {status.grokInstallCommand}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void copyInstall("grok")}
                className="shrink-0"
              >
                {copiedInstall === "grok" ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Then run <code className="text-muted-foreground">grok login</code> (or set{" "}
              <code className="text-muted-foreground">XAI_API_KEY</code>). ACP command:{" "}
              <code className="text-muted-foreground">grok agent stdio</code>. GUI apps may
              not see shell PATH — ~/.grok/bin is auto-added.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {!status.configExists && (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => void ensureConfig()}
              >
                {busy ? "Writing…" : "Write default agents.json"}
              </Button>
            )}
            {status.configExists && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void openConfig()}
                >
                  Open agents.json
                </Button>
                {!status.agents.some((a) => a.id === "grok-build") && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void ensureConfig()}
                  >
                    {busy ? "Updating…" : "Add Grok Build to agents.json"}
                  </Button>
                )}
              </>
            )}
          </div>

          <div className="space-y-2">
            <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Configured agents
            </span>
            {status.agents.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground">
                No agents in config. Write the default file or edit agents.json.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {status.agents.map((a) => (
                  <li
                    key={a.id}
                    className="rounded-lg border border-border bg-background px-3 py-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-xs text-foreground">
                          <span className="font-medium">{a.name}</span>
                          {a.id === status.defaultAgentId && (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              default
                            </span>
                          )}
                        </div>
                        <code className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
                          {a.command}
                          {a.args.length > 0 ? ` ${a.args.join(" ")}` : ""}
                        </code>
                        {a.resolvedPath && (
                          <code className="mt-0.5 block break-all font-mono text-[10px] text-muted-foreground">
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

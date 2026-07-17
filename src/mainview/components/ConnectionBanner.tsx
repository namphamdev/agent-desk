import type { ConnectionStatePayload } from "../../shared/rpc";

export function ConnectionBanner({
  connection,
}: {
  connection: ConnectionStatePayload;
}) {
  if (connection.status !== "error" && connection.status !== "connecting") {
    return null;
  }

  if (connection.status === "connecting") {
    return (
      <div className="border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-center text-xs text-amber-700 dark:text-amber-200">
        Connecting to {connection.agentName ?? "agent"}…
      </div>
    );
  }

  const error = connection.error ?? "unknown error";
  const looksLikeMissingBinary =
    /Executable not found|not found in \$PATH|agents\.json|ENOENT/i.test(error);

  return (
    <div
      className="border-b border-destructive/40 bg-destructive/10 px-6 py-2 text-center text-xs text-destructive"
      role="alert"
    >
      <strong className="font-semibold">Connection error:</strong> {error}
      {looksLikeMissingBinary ? (
        <span className="ml-2 opacity-80">
          Check ~/.terminal-react/agents.json — use an absolute path if the
          binary is installed but not found from the packaged app.
        </span>
      ) : null}
    </div>
  );
}

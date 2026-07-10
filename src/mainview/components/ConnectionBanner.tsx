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
      <div className="border-b border-amber-900/40 bg-amber-950/40 px-6 py-2 text-center text-xs text-amber-200">
        Connecting to {connection.agentName ?? "agent"}…
      </div>
    );
  }

  return (
    <div
      className="border-b border-red-900/50 bg-red-950/50 px-6 py-2 text-center text-xs text-red-200"
      role="alert"
    >
      <strong className="font-semibold">Connection error:</strong>{" "}
      {connection.error ?? "unknown error"}
      <span className="ml-2 text-red-400/80">
        Check ~/.terminal-react/agents.json — use an absolute path if the binary
        is installed but not found from the packaged app.
      </span>
    </div>
  );
}

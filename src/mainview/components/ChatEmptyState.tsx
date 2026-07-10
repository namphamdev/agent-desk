import type { ConnectionStatePayload, SessionSummary } from "../../shared/rpc";

type Props = {
  sessionLoading: boolean;
  connection: ConnectionStatePayload;
  activeSession: SessionSummary | null;
  onNewSession: () => void;
};

export function ChatEmptyState({
  sessionLoading,
  connection,
  activeSession,
  onNewSession,
}: Props) {
  if (sessionLoading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center text-sm text-gray-500">
        <div
          className="h-5 w-5 animate-spin rounded-full border-2 border-[#444] border-t-gray-300"
          aria-hidden
        />
        <p className="text-gray-400">Loading chat…</p>
      </div>
    );
  }

  if (connection.status === "ready") {
    return (
      <div className="rounded-2xl border border-dashed border-[#333] px-6 py-12 text-center text-sm text-gray-500">
        <p className="mb-2 text-base text-gray-400">
          {activeSession
            ? `Connected to ${connection.agentName ?? "agent"}`
            : "No project open"}
        </p>
        {activeSession ? (
          <>
            <p className="mb-1">
              Working in{" "}
              <span className="font-mono text-gray-400">{activeSession.cwd}</span>
            </p>
            <p>Type a prompt below to start.</p>
          </>
        ) : (
          <>
            <p className="mb-4">
              Choose a project folder to start a coding-agent session.
            </p>
            <button
              type="button"
              onClick={() => void onNewSession()}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
            >
              Open project…
            </button>
          </>
        )}
      </div>
    );
  }

  if (connection.status === "connecting") {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center text-sm text-gray-500">
        <div
          className="h-5 w-5 animate-spin rounded-full border-2 border-[#444] border-t-gray-300"
          aria-hidden
        />
        <p className="text-gray-400">
          Connecting to {connection.agentName ?? "agent"}…
        </p>
      </div>
    );
  }

  return null;
}

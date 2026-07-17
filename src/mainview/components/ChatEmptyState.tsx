import type { ConnectionStatePayload, SessionSummary } from "../../shared/rpc";
import { Button } from "@/components/ui/button";

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
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center text-sm text-muted-foreground">
        <div
          className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-foreground/60"
          aria-hidden
        />
        <p className="text-muted-foreground">Loading chat…</p>
      </div>
    );
  }

  if (connection.status === "ready") {
    return (
      <div className="rounded-2xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
        <p className="mb-2 text-base text-muted-foreground">
          {activeSession
            ? `Connected to ${connection.agentName ?? "agent"}`
            : "No project open"}
        </p>
        {activeSession ? (
          <>
            <p className="mb-1">
              Working in{" "}
              <span className="font-mono text-muted-foreground">{activeSession.cwd}</span>
            </p>
            <p>Type a prompt below to start.</p>
          </>
        ) : (
          <>
            <p className="mb-4">
              Choose a project folder to start a coding-agent session.
            </p>
            <Button type="button" onClick={() => void onNewSession()}>
              Open project…
            </Button>
          </>
        )}
      </div>
    );
  }

  if (connection.status === "connecting") {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center text-sm text-muted-foreground">
        <div
          className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-foreground/60"
          aria-hidden
        />
        <p className="text-muted-foreground">
          Connecting to {connection.agentName ?? "agent"}…
        </p>
      </div>
    );
  }

  return null;
}

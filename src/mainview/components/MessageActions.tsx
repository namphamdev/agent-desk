import { useCallback, useState } from "react";

type Props = {
  /** Raw text to copy / seed a new thread with. */
  rawContent: string;
  onCopy: (text: string) => void | Promise<void>;
  onNewThread: (text: string) => void | Promise<void>;
  /** When false, New thread is hidden (e.g. no project open). */
  canNewThread?: boolean;
};

/**
 * Footer actions for a timeline message: copy raw content, or start a new
 * thread seeded with this message as starting context.
 */
export function MessageActions({
  rawContent,
  onCopy,
  onNewThread,
  canNewThread = true,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!rawContent.trim()) return;
    await onCopy(rawContent);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [onCopy, rawContent]);

  const handleNewThread = useCallback(async () => {
    if (!rawContent.trim() || busy) return;
    setBusy(true);
    try {
      await onNewThread(rawContent);
    } finally {
      setBusy(false);
    }
  }, [busy, onNewThread, rawContent]);

  if (!rawContent.trim()) return null;

  return (
    <div className="mt-2 flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]/50 px-2 py-1 text-[11px] text-[var(--text-muted)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text)]"
        title="Copy raw content"
      >
        <CopyIcon />
        {copied ? "Copied" : "Copy"}
      </button>
      {canNewThread && (
        <button
          type="button"
          onClick={() => void handleNewThread()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]/50 px-2 py-1 text-[11px] text-[var(--text-muted)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text)] disabled:opacity-50"
          title="New thread with this message as starting context"
        >
          <ThreadIcon />
          {busy ? "Starting…" : "New thread"}
        </button>
      )}
    </div>
  );
}

function CopyIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden
    >
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </svg>
  );
}

function ThreadIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden
    >
      <path d="M3 4.5h10M3 8h7M3 11.5h5" strokeLinecap="round" />
      <path d="M11 9.5v4M9 11.5h4" strokeLinecap="round" />
    </svg>
  );
}

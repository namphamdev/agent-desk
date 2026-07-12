import { useCallback, useState } from "react";
import { RiChatNewLine, RiFileCopyLine } from "react-icons/ri";

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
        <RiFileCopyLine className="h-3 w-3" aria-hidden />
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
          <RiChatNewLine className="h-3 w-3" aria-hidden />
          {busy ? "Starting…" : "New thread"}
        </button>
      )}
    </div>
  );
}

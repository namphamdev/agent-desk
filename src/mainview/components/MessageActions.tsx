import { useCallback, useState } from "react";
import { Copy, MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";

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
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() => void handleCopy()}
        className="text-[11px] text-muted-foreground"
        title="Copy raw content"
      >
        <Copy className="size-3" aria-hidden />
        {copied ? "Copied" : "Copy"}
      </Button>
      {canNewThread && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => void handleNewThread()}
          disabled={busy}
          className="text-[11px] text-muted-foreground"
          title="New thread with this message as starting context"
        >
          <MessageSquarePlus className="size-3" aria-hidden />
          {busy ? "Starting…" : "New thread"}
        </Button>
      )}
    </div>
  );
}

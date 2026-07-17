import { useMemo, useState } from "react";
import type { RemoteAccessStatus } from "../../shared/rpc";
import { qrToDataUrl } from "../utils/qrcode";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type ControlsProps = {
  status: RemoteAccessStatus | null;
  loading?: boolean;
  error?: string | null;
  onStart: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
  onRegenerate: () => void | Promise<void>;
};

/** Shared remote-control body (settings tab + standalone modal). */
export function RemoteAccessControls({
  status,
  loading,
  error,
  onStart,
  onStop,
  onRegenerate,
}: ControlsProps) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const url = status?.url ?? status?.urls?.[0] ?? null;
  const running = Boolean(status?.running && url);

  const qrSrc = useMemo(() => {
    if (!url) return null;
    try {
      return qrToDataUrl(url, 5, 2);
    } catch (err) {
      console.warn("[remote-access] QR encode failed:", err);
      return null;
    }
  }, [url]);

  const copyUrl = async () => {
    if (!url) return;
    try {
      await navigator.clipboard?.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const run = async (fn: () => void | Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 text-sm text-foreground/80">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Scan the QR code or open the URL on a phone on the same Wi‑Fi. Anyone
        with the link can view sessions and send messages until you stop remote
        access or rotate the code.
      </p>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {(loading || busy) && !running && (
        <div className="py-8 text-center text-xs text-muted-foreground">
          Starting remote server…
        </div>
      )}

      {running && url && (
        <>
          <div className="flex flex-col items-center gap-3">
            <div className="rounded-xl bg-white p-3 shadow-inner">
              {qrSrc ? (
                <img
                  src={qrSrc}
                  alt="QR code for remote access URL"
                  className="h-44 w-44"
                />
              ) : (
                <div className="flex h-44 w-44 items-center justify-center text-xs text-muted-foreground">
                  QR unavailable
                </div>
              )}
            </div>
            <div className="w-full space-y-1">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Web access URL
              </div>
              <div className="flex items-stretch gap-2">
                <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[11px] leading-snug text-foreground">
                  {url}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void copyUrl()}
                  className="shrink-0"
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              {status?.code && (
                <div className="text-[11px] text-muted-foreground">
                  Access code{" "}
                  <span className="font-mono text-muted-foreground">{status.code}</span>
                  {status.port != null ? ` · port ${status.port}` : ""}
                </div>
              )}
            </div>
            {status && status.urls.length > 1 && (
              <details className="w-full text-xs text-muted-foreground">
                <summary className="cursor-pointer hover:text-foreground">
                  Other network addresses ({status.urls.length - 1})
                </summary>
                <ul className="mt-2 space-y-1 font-mono text-[11px] text-muted-foreground">
                  {status.urls
                    .filter((u) => u !== url)
                    .map((u) => (
                      <li key={u} className="break-all">
                        {u}
                      </li>
                    ))}
                </ul>
              </details>
            )}
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void run(onRegenerate)}
            >
              New code
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void run(onStop)}
              className="border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20"
            >
              Stop access
            </Button>
          </div>
        </>
      )}

      {!running && !loading && !busy && (
        <div className="flex flex-col items-center gap-3 py-4">
          <p className="text-center text-xs text-muted-foreground">
            Remote access is off. Start it to get a QR code and link.
          </p>
          <Button
            type="button"
            size="sm"
            onClick={() => void run(onStart)}
          >
            Start remote access
          </Button>
        </div>
      )}
    </div>
  );
}

type Props = {
  status: RemoteAccessStatus | null;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
  onStart: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
  onRegenerate: () => void | Promise<void>;
};

export function RemoteAccessPanel({
  status,
  loading,
  error,
  onClose,
  onStart,
  onStop,
  onRegenerate,
}: Props) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={true}
        className="w-full max-w-md gap-0 overflow-hidden p-0 sm:max-w-md"
      >
        <DialogHeader className="border-b border-border px-5 py-3 pr-12">
          <DialogTitle id="remote-access-title">Remote access</DialogTitle>
        </DialogHeader>

        <div className="px-5 py-4">
          <RemoteAccessControls
            status={status}
            loading={loading}
            error={error}
            onStart={onStart}
            onStop={onStop}
            onRegenerate={onRegenerate}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

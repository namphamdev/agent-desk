import { useEffect, useMemo, useState } from "react";
import type { RemoteAccessStatus } from "../../shared/rpc";
import { qrToDataUrl } from "../utils/qrcode";

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="remote-access-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-[#333] bg-[#1a1a1a] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#2e2e2e] px-5 py-3">
          <h2
            id="remote-access-title"
            className="text-sm font-semibold text-gray-100"
          >
            Remote access
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded p-1 text-gray-500 hover:bg-[#2a2a2a] hover:text-gray-200 disabled:opacity-50"
            aria-label="Close remote access"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 px-5 py-4 text-sm text-gray-300">
          <p className="text-xs leading-relaxed text-gray-500">
            Scan the QR code or open the URL on a phone on the same Wi‑Fi.
            Anyone with the link can view sessions and send messages until you
            stop remote access or rotate the code.
          </p>

          {error && (
            <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}

          {(loading || busy) && !running && (
            <div className="py-8 text-center text-xs text-gray-500">
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
                    <div className="flex h-44 w-44 items-center justify-center text-xs text-gray-600">
                      QR unavailable
                    </div>
                  )}
                </div>
                <div className="w-full space-y-1">
                  <div className="text-[11px] font-medium uppercase tracking-wider text-gray-500">
                    Web access URL
                  </div>
                  <div className="flex items-stretch gap-2">
                    <code className="min-w-0 flex-1 break-all rounded-md border border-[#333] bg-[#121212] px-2.5 py-2 font-mono text-[11px] leading-snug text-gray-200">
                      {url}
                    </code>
                    <button
                      type="button"
                      onClick={() => void copyUrl()}
                      className="shrink-0 rounded-md border border-[#333] bg-[#222] px-3 text-xs text-gray-200 hover:bg-[#2a2a2a]"
                    >
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  {status?.code && (
                    <div className="text-[11px] text-gray-600">
                      Access code{" "}
                      <span className="font-mono text-gray-400">
                        {status.code}
                      </span>
                      {status.port != null ? ` · port ${status.port}` : ""}
                    </div>
                  )}
                </div>
                {status && status.urls.length > 1 && (
                  <details className="w-full text-xs text-gray-500">
                    <summary className="cursor-pointer hover:text-gray-300">
                      Other network addresses ({status.urls.length - 1})
                    </summary>
                    <ul className="mt-2 space-y-1 font-mono text-[11px] text-gray-400">
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
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(onRegenerate)}
                  className="rounded-md border border-[#333] bg-[#222] px-3 py-1.5 text-xs text-gray-200 hover:bg-[#2a2a2a] disabled:opacity-50"
                >
                  New code
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(onStop)}
                  className="rounded-md border border-red-900/50 bg-red-950/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950/70 disabled:opacity-50"
                >
                  Stop access
                </button>
              </div>
            </>
          )}

          {!running && !loading && !busy && (
            <div className="flex flex-col items-center gap-3 py-4">
              <p className="text-center text-xs text-gray-500">
                Remote access is off. Start it to get a QR code and link.
              </p>
              <button
                type="button"
                onClick={() => void run(onStart)}
                className="rounded-md bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500"
              >
                Start remote access
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Right-side built-in browser panel (per chat session).
 * Desktop (Electrobun): nested <electrobun-webview> OOPIF.
 * Browser mock / remote: sandboxed iframe fallback.
 *
 * Agent MCP tools drive this panel via browserControl RPC (not system Chrome).
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  RefreshCw,
  X,
} from "lucide-react";
import type {
  BrowserControlRequest,
  BrowserControlResponse,
} from "../../shared/browser-control";
import {
  SNAPSHOT_SCRIPT,
  clickScript,
  evaluateScript,
  fillScript,
  parseTrResultHash,
  pressKeyScript,
  typeScript,
} from "../browser/panel-actions";
import { registerBrowserPanel } from "../browser/registry";
import {
  BROWSER_MAX_WIDTH,
  BROWSER_MIN_WIDTH,
} from "../hooks/useBrowserPanelResize";
import { DEFAULT_BROWSER_URL } from "../hooks/useSessionBrowserState";

/** Coerce omnibox input into an http(s) URL. */
export function normalizeBrowserUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^about:/i.test(trimmed)) return trimmed;
  if (/^[^/\s:]+:\d+(?:[/?#]|$)/.test(trimmed)) {
    return `https://${trimmed}`;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return null;
  }
  return `https://${trimmed}`;
}

function isElectrobunHost(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { __electrobunWebviewId?: number })
      .__electrobunWebviewId === "number"
  );
}

type Props = {
  sessionId: string;
  url: string;
  onUrlChange: (url: string) => void;
  width: number;
  isResizing: boolean;
  onResizeStart: (e: ReactMouseEvent) => void;
  onNudge: (delta: number) => void;
  onClose: () => void;
  suppressNative?: boolean;
};

type PendingResult = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function BrowserPanel({
  sessionId,
  url,
  onUrlChange,
  width,
  isResizing,
  onResizeStart,
  onNudge,
  onClose,
  suppressNative = false,
}: Props) {
  const committedUrl = url || DEFAULT_BROWSER_URL;
  const [address, setAddress] = useState(committedUrl);
  const [loading, setLoading] = useState(false);
  const webviewRef = useRef<HTMLElementTagNameMap["electrobun-webview"] | null>(
    null,
  );
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const pendingRef = useRef<PendingResult | null>(null);
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;
  const useNative = isElectrobunHost();

  useEffect(() => {
    setAddress(committedUrl);
  }, [sessionId, committedUrl]);

  const runInPage = useCallback(
    (js: string) => {
      const el = webviewRef.current;
      if (el && typeof el.executeJavascript === "function") {
        el.executeJavascript(js);
        return true;
      }
      // iframe fallback (dev:web) — same-origin only; most sites will fail.
      try {
        const win = iframeRef.current?.contentWindow as
          | (Window & { eval: (code: string) => unknown })
          | null
          | undefined;
        if (win) {
          win.eval(js);
          return true;
        }
      } catch {
        /* cross-origin */
      }
      return false;
    },
    [],
  );

  const waitForTrResult = useCallback((timeoutMs = 8000) => {
    return new Promise<unknown>((resolve, reject) => {
      if (pendingRef.current) {
        clearTimeout(pendingRef.current.timer);
        pendingRef.current.reject(new Error("superseded"));
      }
      const timer = setTimeout(() => {
        pendingRef.current = null;
        reject(new Error("Timed out waiting for page script result"));
      }, timeoutMs);
      pendingRef.current = { resolve, reject, timer };
    });
  }, []);

  const handleTrResultUrl = useCallback((rawUrl: string) => {
    const parsed = parseTrResultHash(rawUrl);
    if (!parsed || !pendingRef.current) return false;
    clearTimeout(pendingRef.current.timer);
    pendingRef.current.resolve(parsed);
    pendingRef.current = null;
    return true;
  }, []);

  const navigate = useCallback(
    async (raw: string): Promise<BrowserControlResponse> => {
      const next = normalizeBrowserUrl(raw);
      if (!next) {
        return { ok: false, error: `Invalid URL: ${raw}` };
      }
      setAddress(next);
      onUrlChangeRef.current(next);
      setLoading(true);
      const el = webviewRef.current;
      if (el && typeof el.loadURL === "function") {
        el.loadURL(next);
      } else if (iframeRef.current) {
        iframeRef.current.src = next;
      }
      // Give the page a moment to start loading.
      await new Promise((r) => setTimeout(r, 400));
      setLoading(false);
      return { ok: true, url: next, message: `Navigated to ${next}` };
    },
    [],
  );

  const handleControl = useCallback(
    async (req: BrowserControlRequest): Promise<BrowserControlResponse> => {
      switch (req.action) {
        case "navigate":
          return navigate(req.url ?? "");
        case "url":
          return { ok: true, url: committedUrl, title: undefined };
        case "back": {
          webviewRef.current?.goBack?.();
          await new Promise((r) => setTimeout(r, 300));
          return { ok: true, url: committedUrl, message: "Went back" };
        }
        case "forward": {
          webviewRef.current?.goForward?.();
          await new Promise((r) => setTimeout(r, 300));
          return { ok: true, url: committedUrl, message: "Went forward" };
        }
        case "reload": {
          webviewRef.current?.reload?.();
          if (iframeRef.current) iframeRef.current.src = committedUrl;
          await new Promise((r) => setTimeout(r, 300));
          return { ok: true, url: committedUrl, message: "Reloaded" };
        }
        case "snapshot": {
          if (!runInPage(SNAPSHOT_SCRIPT)) {
            return {
              ok: false,
              error:
                "Cannot run scripts in this browser surface (open the desktop app).",
            };
          }
          try {
            const result = (await waitForTrResult()) as {
              ok?: boolean;
              url?: string;
              title?: string;
              snapshot?: string;
              error?: string;
            };
            if (result && result.ok === false) {
              return { ok: false, error: result.error ?? "snapshot failed" };
            }
            if (result?.url) {
              // Strip tr-result hash from displayed URL
              const clean = result.url.replace(/#tr-result=.*$/, "");
              setAddress(clean);
              onUrlChangeRef.current(clean);
            }
            return {
              ok: true,
              url: result?.url?.replace(/#tr-result=.*$/, ""),
              title: result?.title,
              snapshot: result?.snapshot,
            };
          } catch (err) {
            return {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }
        case "click": {
          if (!req.ref) return { ok: false, error: "ref required" };
          if (!runInPage(clickScript(req.ref))) {
            return { ok: false, error: "Cannot execute click in page" };
          }
          await new Promise((r) => setTimeout(r, 200));
          return { ok: true, message: `Clicked ${req.ref}` };
        }
        case "type": {
          if (!req.ref) return { ok: false, error: "ref required" };
          if (!runInPage(typeScript(req.ref, req.text ?? "", !!req.submit))) {
            return { ok: false, error: "Cannot type in page" };
          }
          await new Promise((r) => setTimeout(r, 150));
          return { ok: true, message: `Typed into ${req.ref}` };
        }
        case "fill": {
          if (!req.ref) return { ok: false, error: "ref required" };
          if (!runInPage(fillScript(req.ref, req.text ?? ""))) {
            return { ok: false, error: "Cannot fill in page" };
          }
          await new Promise((r) => setTimeout(r, 150));
          return { ok: true, message: `Filled ${req.ref}` };
        }
        case "press": {
          if (!req.key) return { ok: false, error: "key required" };
          if (!runInPage(pressKeyScript(req.key))) {
            return { ok: false, error: "Cannot press key in page" };
          }
          return { ok: true, message: `Pressed ${req.key}` };
        }
        case "evaluate": {
          if (!req.expression?.trim()) {
            return { ok: false, error: "expression required" };
          }
          if (!runInPage(evaluateScript(req.expression))) {
            return {
              ok: false,
              error:
                "Cannot run scripts in this browser surface (open the desktop app).",
            };
          }
          try {
            const result = (await waitForTrResult()) as {
              ok?: boolean;
              url?: string;
              title?: string;
              result?: string;
              error?: string;
            };
            if (result && result.ok === false) {
              return { ok: false, error: result.error ?? "evaluate failed" };
            }
            return {
              ok: true,
              url: result?.url?.replace(/#tr-result=.*$/, ""),
              title: result?.title,
              result: result?.result,
              message: "Evaluated expression",
            };
          } catch (err) {
            return {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }
        case "open":
          // Panel is already mounted if this handler runs.
          return {
            ok: true,
            sessionId,
            panelOpen: true,
            message: "Browser panel is open for this chat.",
          };
        case "session_info":
        case "store_token":
        case "list_tokens":
        case "delete_token":
          // Handled in Bun control server (SQLite / session binding), not the panel.
          return {
            ok: false,
            error: `${req.action} is handled by the app control plane, not the panel`,
          };
        default:
          return { ok: false, error: `Unknown action: ${req.action}` };
      }
    },
    [committedUrl, navigate, runInPage, waitForTrResult],
  );

  // Register so agent MCP can drive this panel.
  useEffect(() => {
    return registerBrowserPanel(sessionId, handleControl);
  }, [sessionId, handleControl]);

  // User address bar submit
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void navigate(address);
  };

  // Sync address from navigations + capture tr-result payloads
  useEffect(() => {
    if (!useNative) return;
    const el = webviewRef.current;
    if (!el || typeof el.on !== "function") return;

    const onNav = (ev: CustomEvent) => {
      const detail = ev.detail as { url?: string } | string | undefined;
      const next =
        typeof detail === "string"
          ? detail
          : detail && typeof detail === "object"
            ? detail.url
            : undefined;
      if (typeof next === "string" && next) {
        if (handleTrResultUrl(next)) return;
        const clean = next.replace(/#tr-result=.*$/, "");
        setAddress(clean);
        onUrlChangeRef.current(clean);
      }
      setLoading(false);
    };
    const onStart = () => setLoading(true);
    const onDone = () => setLoading(false);

    const on = el.on.bind(el) as (
      event: string,
      listener: (event: CustomEvent) => void,
    ) => void;
    const off = el.off?.bind(el) as
      | ((event: string, listener: (event: CustomEvent) => void) => void)
      | undefined;

    on("did-navigate", onNav);
    on("did-navigate-in-page", onNav);
    on("did-commit-navigation", onNav);
    on("load-started", onStart);
    on("load-finished", onDone);
    on("dom-ready", onDone);

    return () => {
      off?.("did-navigate", onNav);
      off?.("did-navigate-in-page", onNav);
      off?.("did-commit-navigation", onNav);
      off?.("load-started", onStart);
      off?.("load-finished", onDone);
      off?.("dom-ready", onDone);
    };
  }, [useNative, sessionId, handleTrResultUrl]);

  useEffect(() => {
    const el = webviewRef.current;
    if (!el || typeof el.toggleHidden !== "function") return;
    el.toggleHidden(suppressNative);
    if (!suppressNative) {
      requestAnimationFrame(() => el.syncDimensions?.(true));
    }
  }, [suppressNative]);

  useEffect(() => {
    const el = webviewRef.current;
    if (!el || suppressNative) return;
    requestAnimationFrame(() => el.syncDimensions?.(true));
  }, [width, suppressNative]);

  const goBack = () => webviewRef.current?.goBack?.();
  const goForward = () => webviewRef.current?.goForward?.();
  const reload = () => {
    if (useNative) webviewRef.current?.reload?.();
    else if (iframeRef.current) {
      setLoading(true);
      iframeRef.current.src = committedUrl;
    }
  };

  const openExternal = () => {
    if (!committedUrl) return;
    window.open(committedUrl, "_blank", "noopener,noreferrer");
  };

  const onHandleKeyDown = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 32 : 16;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onNudge(step);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onNudge(-step);
    }
  };

  const partition = `persist:agent-browser-${sessionId}`;

  return (
    <div
      className="flex h-full min-h-0 shrink-0"
      style={{ width }}
      data-browser-panel
      data-session-id={sessionId}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize browser panel"
        aria-valuenow={width}
        aria-valuemin={BROWSER_MIN_WIDTH}
        aria-valuemax={BROWSER_MAX_WIDTH}
        tabIndex={0}
        onMouseDown={onResizeStart}
        onKeyDown={onHandleKeyDown}
        className={`group relative z-10 w-1 flex-shrink-0 cursor-col-resize touch-none outline-none ${
          isResizing ? "bg-blue-500/60" : "bg-transparent hover:bg-blue-500/40"
        }`}
      >
        <div className="absolute inset-y-0 -left-1 -right-1" />
      </div>

      <aside className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-[#2e2e2e] bg-[#1a1a1a]">
        <div className="electrobun-webkit-app-region-no-drag flex shrink-0 items-center gap-1 border-b border-[#2e2e2e] px-2 py-1.5">
          <button
            type="button"
            className="rounded p-1.5 text-gray-400 hover:bg-[#2a2a2a] hover:text-gray-200 disabled:opacity-40"
            onClick={goBack}
            disabled={!useNative}
            title="Back"
            aria-label="Back"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            className="rounded p-1.5 text-gray-400 hover:bg-[#2a2a2a] hover:text-gray-200 disabled:opacity-40"
            onClick={goForward}
            disabled={!useNative}
            title="Forward"
            aria-label="Forward"
          >
            <ArrowRight className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            className="rounded p-1.5 text-gray-400 hover:bg-[#2a2a2a] hover:text-gray-200"
            onClick={reload}
            title="Reload"
            aria-label="Reload"
          >
            <RefreshCw
              className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
              aria-hidden
            />
          </button>

          <form
            onSubmit={onSubmit}
            className="flex min-w-0 flex-1 items-center gap-1"
          >
            <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-[#333] bg-[#121212] px-2 py-1">
              <Globe
                className="h-3.5 w-3.5 shrink-0 text-gray-500"
                aria-hidden
              />
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="min-w-0 flex-1 bg-transparent text-xs text-gray-200 outline-none placeholder:text-gray-600"
                placeholder="Search or enter URL"
                aria-label="Address bar"
              />
            </div>
          </form>

          <button
            type="button"
            className="rounded p-1.5 text-gray-400 hover:bg-[#2a2a2a] hover:text-gray-200"
            onClick={openExternal}
            title="Open in system browser"
            aria-label="Open in system browser"
          >
            <ExternalLink className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            className="rounded p-1.5 text-gray-400 hover:bg-[#2a2a2a] hover:text-gray-200"
            onClick={onClose}
            title="Close browser panel"
            aria-label="Close browser panel"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="relative min-h-0 flex-1 bg-[#0d0d0d]">
          {useNative ? (
            <electrobun-webview
              key={sessionId}
              ref={webviewRef as never}
              src={committedUrl}
              partition={partition}
              className="block h-full w-full"
              style={{ display: "block", width: "100%", height: "100%" }}
            />
          ) : (
            <iframe
              key={sessionId}
              ref={iframeRef}
              title="Built-in browser"
              src={committedUrl}
              className="h-full w-full border-0 bg-white"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
              onLoad={() => setLoading(false)}
            />
          )}
        </div>
      </aside>
    </div>
  );
}

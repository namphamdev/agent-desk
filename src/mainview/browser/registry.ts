/**
 * In-memory registry of per-session browser panel action handlers.
 * Bun → webview `browserControl` RPC looks up the active panel here.
 */
import type {
  BrowserControlRequest,
  BrowserControlResponse,
} from "../../shared/browser-control";

export type BrowserPanelHandler = (
  req: BrowserControlRequest,
) => Promise<BrowserControlResponse>;

const handlers = new Map<string, BrowserPanelHandler>();

export function registerBrowserPanel(
  sessionId: string,
  handler: BrowserPanelHandler,
): () => void {
  handlers.set(sessionId, handler);
  return () => {
    if (handlers.get(sessionId) === handler) {
      handlers.delete(sessionId);
    }
  };
}

export function getBrowserPanelHandler(
  sessionId: string,
): BrowserPanelHandler | undefined {
  return handlers.get(sessionId);
}

/** Wait for the panel to mount after an open request (agent navigate path). */
export async function waitForBrowserPanel(
  sessionId: string,
  timeoutMs = 8000,
): Promise<BrowserPanelHandler | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const h = handlers.get(sessionId);
    if (h) return h;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

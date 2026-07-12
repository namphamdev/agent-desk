/**
 * Bridge so RPC onBrowserOpen can open the panel without React prop drilling.
 */
type OpenHandler = (sessionId: string, url?: string) => void;

let handler: OpenHandler | null = null;

export function setBrowserOpenHandler(next: OpenHandler | null) {
  handler = next;
}

export function notifyBrowserOpen(sessionId: string, url?: string) {
  handler?.(sessionId, url);
}

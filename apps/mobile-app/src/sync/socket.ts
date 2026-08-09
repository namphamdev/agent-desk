// Thin WebSocket abstraction — RN's built-in WebSocket is event-based (not
// task-based like URLSession). This wraps it in a minimal send/receive API
// that mirrors what RoomClient and DeviceRelayClient need.

/**
 * One framed message — either a UTF-8 string or raw bytes.
 * RN delivers binary as ArrayBuffer; we convert to Uint8Array for the codec.
 */
export type WsMessage =
  | { kind: 'text'; text: string }
  | { kind: 'binary'; bytes: Uint8Array };

export interface RawSocket {
  send(data: string | ArrayBufferLike): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

export interface SocketHandlers {
  onOpen?: () => void;
  onMessage?: (msg: WsMessage) => void;
  onClose?: (ev: CloseEvent) => void;
  onError?: (ev: unknown) => void;
}

/**
 * Open a WebSocket against `url`. Returns the underlying socket plus a
 * promise that resolves on first open. Subsequent messages flow through
 * `handlers`.
 */
export function openSocket(
  url: string,
  handlers: SocketHandlers,
): RawSocket {
  // RN's WebSocket supports binaryType = 'arraybuffer'.
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => handlers.onOpen?.();
  ws.onmessage = (event) => {
    const data = event.data;
    if (typeof data === 'string') {
      handlers.onMessage?.({ kind: 'text', text: data });
    } else if (data instanceof ArrayBuffer) {
      handlers.onMessage?.({ kind: 'binary', bytes: new Uint8Array(data) });
    } else if (data && typeof data === 'object' && 'arraybuffer' in data) {
      // Blob branch — not used (binaryType set above) but defensive.
      data.arraybuffer().then((ab: ArrayBuffer) => {
        handlers.onMessage?.({ kind: 'binary', bytes: new Uint8Array(ab) });
      });
    }
  };
  ws.onclose = (ev) => handlers.onClose?.(ev);
  ws.onerror = (ev) => handlers.onError?.(ev);

  return {
    send(data) {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(data as string | ArrayBuffer);
    },
    close(code, reason) {
      try {
        ws.close(code, reason);
      } catch {
        // close may throw if not yet connected; ignore
      }
    },
    get readyState() {
      return ws.readyState;
    },
  };
}

export const READY_OPEN = 1;

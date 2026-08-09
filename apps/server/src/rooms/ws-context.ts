/**
 * WebSocket context — replaces the Durable Object hibernation API.
 *
 * In the DO model, the runtime managed WebSocket connections and the DO
 * accessed them via `ctx.getWebSockets(tag)`, `ctx.acceptWebSocket(ws)`, etc.
 * In Bun, the server itself manages connections directly. This module provides
 * the per-room bookkeeping that bridges between Bun's raw WebSocket objects
 * and the room classes' expectations.
 *
 * Each room instance owns a `WsContext` that tracks:
 * - All attached sockets (with optional tags for host/client filtering).
 * - Per-socket attachment state (userId, role, joined rooms, etc.).
 * - Auto-response for ping→pong keepalive (no app-level handler needed).
 * - Per-socket last-pong timestamp (for liveness checks in device rooms).
 */

/** Per-socket attachment stored via WeakMap (replaces serializeAttachment).
 * The concrete type is room-specific (SocketState for session/device rooms);
 * callers cast on deserialize. */
export type WsAttachment = unknown;

interface TrackedSocket {
  ws: WebSocket;
  tags: string[];
}

export class WsContext {
  /** All attached sockets, tracked for broadcast and getWebSockets(). */
  private readonly sockets = new Set<TrackedSocket>();
  /** Tag → sockets index for O(1) tag-based lookup. */
  private readonly tagIndex = new Map<string, Set<TrackedSocket>>();
  /** Per-socket attachment state (replaces serializeAttachment). */
  private readonly attachments = new WeakMap<WebSocket, WsAttachment>();
  /** Per-socket last-pong timestamp (replaces getWebSocketAutoResponseTimestamp). */
  private readonly pongTimestamps = new WeakMap<WebSocket, number>();

  /** Accept and track a WebSocket with optional tags. */
  accept(ws: WebSocket, tags: string[] = []): void {
    const entry: TrackedSocket = { ws, tags };
    this.sockets.add(entry);
    for (const tag of tags) {
      let set = this.tagIndex.get(tag);
      if (!set) {
        set = new Set();
        this.tagIndex.set(tag, set);
      }
      set.add(entry);
    }

    // Auto-response: reply "pong" to "ping" without app-level handler.
    ws.addEventListener("message", (event) => {
      if (event.data === "ping") {
        this.pongTimestamps.set(ws, Date.now());
        try {
          ws.send("pong");
        } catch {
          /* socket gone */
        }
      }
    });
  }

  /** Get all sockets, optionally filtered by tag. */
  getWebSockets(tag?: string): WebSocket[] {
    if (!tag) {
      return [...this.sockets].map((s) => s.ws);
    }
    const set = this.tagIndex.get(tag);
    return set ? [...set].map((s) => s.ws) : [];
  }

  /** Serialize (store) attachment state for a socket. */
  serializeAttachment(ws: WebSocket, state: unknown): void {
    this.attachments.set(ws, state);
  }

  /** Deserialize (read) attachment state for a socket. */
  deserializeAttachment(ws: WebSocket): WsAttachment {
    return this.attachments.get(ws) ?? null;
  }

  /** Get the last auto-response (pong) timestamp for a socket. */
  getAutoResponseTimestamp(ws: WebSocket): Date | undefined {
    const ts = this.pongTimestamps.get(ws);
    return ts !== undefined ? new Date(ts) : undefined;
  }

  /** Remove a socket from tracking (on close/error). */
  remove(ws: WebSocket): void {
    for (const entry of this.sockets) {
      if (entry.ws === ws) {
        this.sockets.delete(entry);
        for (const tag of entry.tags) {
          this.tagIndex.get(tag)?.delete(entry);
        }
        this.attachments.delete(ws);
        this.pongTimestamps.delete(ws);
        break;
      }
    }
  }
}

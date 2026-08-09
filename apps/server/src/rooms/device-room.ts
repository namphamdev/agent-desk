/**
 * DeviceRoom — ported from edge/src/device-room.ts. A frame relay for
 * interactive RPC + terminal streams. The host keeps one outbound WebSocket;
 * clients multiplex over `{streamId, kind, bytes}` frames.
 *
 * Frame encoding (binary): uleb128 header-length | UTF-8 JSON header | payload.
 * Header: { s: streamId, k: kind, to?: connId, from?: connId }.
 * - client → room: room stamps `from = connId` and forwards to the host.
 * - host → room: must carry `to = connId`; room strips routing keys and delivers.
 *
 * Same DO→Bun substitutions as SessionRoom. All relay logic, liveness,
 * nudge queue, and sidecar slots are preserved 100%.
 */
import { BytesReader, BytesWriter } from "loro-protocol";
import {
  createRoomBlobStore,
  getJsonBlob,
  putJsonBlob,
  type RoomBlobStore
} from "./room-blob-store";
import { WsContext } from "./ws-context";
import type { SqliteStore } from "../storage/sqlite-store";

const DEVICE_SCHEMA_VERSION = "1";

export interface DeviceFrameHeader {
  s: string;
  k: string;
  to?: string;
  from?: string;
}

export const encodeDeviceFrame = (header: DeviceFrameHeader, payload: Uint8Array): Uint8Array => {
  const writer = new BytesWriter();
  writer.pushVarString(JSON.stringify(header));
  writer.pushBytes(payload);
  return writer.finalize();
};

export const decodeDeviceFrame = (
  bytes: Uint8Array
): { header: DeviceFrameHeader; payload: Uint8Array } => {
  const reader = new BytesReader(bytes);
  const header = JSON.parse(reader.readVarString()) as DeviceFrameHeader;
  const payload = reader.readBytes(reader.remaining);
  return { header, payload };
};

interface SocketState {
  userId: string;
  role: "host" | "client";
  connId: string;
  joinedAt?: number;
}

const HOST_TAG = "host";
const clientTag = (connId: string) => `client:${connId}`;

const HOST_LIVENESS_MS = 75_000;
const RELAY_KIND = " relay";

export const NUDGE_KIND = "nudge";
const NUDGE_MAX_PENDING = 256;
const CHAT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class DeviceRoom {
  private readonly db: SqliteStore;
  private readonly blobs: RoomBlobStore;
  private readonly wsCtx = new WsContext();

  constructor(db: SqliteStore) {
    this.db = db;
    let schemaReady = false;
    try {
      const rows = [...db.exec("SELECT value FROM meta WHERE key = '__schema__'")];
      schemaReady = (rows[0]?.value as string) === DEVICE_SCHEMA_VERSION;
    } catch {
      // First-ever instantiation.
    }
    if (schemaReady) {
      this.blobs = createRoomBlobStore(db, { skipInit: true });
    } else {
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec(
        "CREATE TABLE IF NOT EXISTS pending_nudges (chat_id TEXT PRIMARY KEY, queued_at INTEGER NOT NULL)"
      );
      this.blobs = createRoomBlobStore(db);
      db.exec(
        "INSERT INTO meta (key, value) VALUES ('__schema__', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        DEVICE_SCHEMA_VERSION
      );
    }
  }

  private getMeta(key: string): string | undefined {
    const rows = [...this.db.exec("SELECT value FROM meta WHERE key = ?", key)];
    return rows[0]?.value as string | undefined;
  }

  private setMeta(key: string, value: string): void {
    this.db.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value
    );
  }

  /** The host socket to route to: the freshest one that has proven itself
   * alive within HOST_LIVENESS_MS. */
  private liveHost(exclude?: WebSocket): WebSocket | undefined {
    return pickLiveHost(
      this.wsCtx.getWebSockets(HOST_TAG).map((ws) => ({
        ws,
        lastSeenAt: Math.max(
          this.wsCtx.getAutoResponseTimestamp(ws)?.getTime() ?? 0,
          (this.wsCtx.deserializeAttachment(ws) as SocketState | null)?.joinedAt ?? 0
        )
      })),
      Date.now(),
      exclude
    );
  }

  // ── WebSocket management ──────────────────────────────────────────────────

  /** Attach a new WebSocket for this device room. */
  attachSocket(
    ws: WebSocket,
    userId: string,
    role: "host" | "client",
    connId: string
  ): Response | null {
    const owner = this.getMeta("owner");
    if (role === "host") {
      if (!owner) this.setMeta("owner", userId);
      else if (owner !== userId) return new Response("forbidden", { status: 403 });
    } else {
      if (!owner || owner !== userId) return new Response("forbidden", { status: 403 });
    }

    if (role === "host") {
      // Close any predecessor (backend restart).
      for (const stale of this.wsCtx.getWebSockets(HOST_TAG)) {
        try {
          stale.close(4409, "superseded by new host connection");
        } catch {
          /* already gone */
        }
      }
      this.wsCtx.accept(ws, [HOST_TAG]);
      this.replayNudges(ws);
    } else {
      this.wsCtx.accept(ws, [clientTag(connId)]);
    }

    const state: SocketState = { userId, role, connId, joinedAt: Date.now() };
    this.wsCtx.serializeAttachment(ws, state);
    return null; // success
  }

  // ── HTTP surface ──────────────────────────────────────────────────────────

  async handleRequest(
    method: string,
    pathname: string,
    request: Request,
    userId: string
  ): Promise<Response> {
    const owner = this.getMeta("owner");

    // Sidecar slots.
    const sidecar = pathname.match(/^\/sidecar\/([a-z0-9-]{1,64})$/);
    if (sidecar) {
      const name = sidecar[1]!;
      if (!owner || owner !== userId)
        return json({ error: "forbidden" }, owner ? 403 : 404);
      if (method === "GET") {
        const value = getJsonBlob<unknown>(this.blobs, `sidecar:${name}`);
        return value === undefined ? json({ error: "not_found" }, 404) : json(value);
      }
      if (method === "POST") {
        const rawBody = await request.arrayBuffer();
        const jsonBody = rawBody.byteLength > 0 ? JSON.parse(new TextDecoder().decode(rawBody)) : null;
        putJsonBlob(this.blobs, `sidecar:${name}`, jsonBody);
        return json({ ok: true });
      }
    }

    if (pathname === "/status" && method === "GET") {
      if (!owner || owner !== userId)
        return json({ error: "forbidden" }, owner ? 403 : 404);
      return json({
        hostConnected: this.liveHost() !== undefined,
        hostSockets: this.wsCtx.getWebSockets(HOST_TAG).length
      });
    }

    if (pathname === "/nudge" && method === "POST") {
      if (!owner || owner !== userId)
        return json({ error: "forbidden" }, owner ? 403 : 404);
      const rawBody = await request.arrayBuffer();
      const parsed = rawBody.byteLength > 0 ? JSON.parse(new TextDecoder().decode(rawBody)) : null;
      const chatId = (parsed as { chatId?: string } | null)?.chatId;
      if (!chatId || !CHAT_ID_RE.test(chatId)) return json({ error: "bad_chat_id" }, 400);
      const host = this.liveHost();
      if (host) {
        this.deliver(
          host,
          { s: chatId, k: NUDGE_KIND },
          new TextEncoder().encode(JSON.stringify({ chatId }))
        );
        return json({ delivered: true });
      }
      this.db.exec(
        "INSERT INTO pending_nudges (chat_id, queued_at) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET queued_at = excluded.queued_at",
        chatId,
        Date.now()
      );
      this.db.exec(
        "DELETE FROM pending_nudges WHERE chat_id NOT IN (SELECT chat_id FROM pending_nudges ORDER BY queued_at DESC LIMIT ?)",
        NUDGE_MAX_PENDING
      );
      return json({ delivered: false, queued: true });
    }

    return json({ error: "not_found" }, 404);
  }

  private replayNudges(host: WebSocket): void {
    const rows = [
      ...this.db.exec("SELECT chat_id FROM pending_nudges ORDER BY queued_at ASC")
    ] as Array<{ chat_id: string }>;
    if (rows.length === 0) return;
    for (const row of rows) {
      this.deliver(
        host,
        { s: row.chat_id, k: NUDGE_KIND },
        new TextEncoder().encode(JSON.stringify({ chatId: row.chat_id }))
      );
    }
    this.db.exec("DELETE FROM pending_nudges");
  }

  // ── WebSocket handlers ────────────────────────────────────────────────────

  onMessage(ws: WebSocket, message: ArrayBuffer | string): void {
    if (typeof message === "string") return; // ping/pong auto-response
    const state = this.wsCtx.deserializeAttachment(ws) as SocketState | null;
    if (!state) return;
    let frame: { header: DeviceFrameHeader; payload: Uint8Array };
    try {
      frame = decodeDeviceFrame(new Uint8Array(message));
    } catch {
      ws.close(1002, "Frame error");
      return;
    }
    if (state.role === "client") {
      const host = this.liveHost();
      if (!host) {
        this.deliver(ws, { s: frame.header.s, k: RELAY_KIND }, encodeRelayError("host_offline"));
        return;
      }
      this.deliver(
        host,
        { s: frame.header.s, k: frame.header.k, from: state.connId },
        frame.payload
      );
      return;
    }
    // Host frame: route by `to`.
    const to = frame.header.to;
    if (!to) return;
    const target = this.wsCtx.getWebSockets(clientTag(to))[0];
    if (!target) {
      this.deliver(ws, { s: frame.header.s, k: RELAY_KIND, to }, encodeRelayError("client_gone"));
      return;
    }
    this.deliver(target, { s: frame.header.s, k: frame.header.k }, frame.payload);
  }

  onClose(ws: WebSocket): void {
    const state = this.wsCtx.deserializeAttachment(ws) as SocketState | null;
    this.wsCtx.remove(ws);
    if (!state) return;
    if (state.role === "client") {
      const host = this.liveHost();
      if (host) {
        this.deliver(
          host,
          { s: "", k: RELAY_KIND, from: state.connId },
          encodeRelayError("client_closed")
        );
      }
      return;
    }
    if (this.liveHost(ws)) return;
    for (const client of this.wsCtx.getWebSockets()) {
      const cs = this.wsCtx.deserializeAttachment(client) as SocketState | null;
      if (cs?.role !== "client") continue;
      this.deliver(client, { s: "", k: RELAY_KIND }, encodeRelayError("host_closed"));
    }
  }

  onError(ws: WebSocket): void {
    this.onClose(ws);
  }

  private deliver(ws: WebSocket, header: DeviceFrameHeader, payload: Uint8Array): void {
    try {
      ws.send(encodeDeviceFrame(header, payload));
    } catch {
      /* stale socket */
    }
  }

  async destroy(): Promise<void> {
    // Nothing pending to flush — device room writes are synchronous.
  }
}

/** Freshest host socket that has proven itself alive inside the liveness
 * window. Pure function, testable without a room. */
export const pickLiveHost = <T>(
  hosts: ReadonlyArray<{ ws: T; lastSeenAt: number }>,
  now: number,
  exclude?: T
): T | undefined => {
  let best: { ws: T; lastSeenAt: number } | undefined;
  for (const host of hosts) {
    if (host.ws === exclude) continue;
    if (!best || host.lastSeenAt > best.lastSeenAt) best = host;
  }
  return best && now - best.lastSeenAt <= HOST_LIVENESS_MS ? best.ws : undefined;
};

const encodeRelayError = (code: string): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ error: code }));

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });

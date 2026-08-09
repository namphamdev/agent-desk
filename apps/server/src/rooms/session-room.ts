/**
 * SessionRoom — ported from edge/src/session-room.ts. One instance per doc
 * room, speaking loro-protocol over WebSockets. Two doc kinds share this
 * class: chat session docs and workspace docs (org-membership authz enforced
 * by the router; the room sees the ROOM_KIND_HEADER stamp and skips
 * ownership).
 *
 * Changes from the Durable Object original:
 * - No `implements DurableObject`; plain class.
 * - Constructor takes (roomId, db, blobs, env) instead of (ctx, env).
 * - `ctx.storage.sql.exec()` → `db.exec()` (SqliteStore mirrors the interface).
 * - `ctx.storage.sync()` → no-op (WAL auto-syncs).
 * - `ctx.acceptWebSocket(ws)` → `wsCtx.accept(ws)`.
 * - `ctx.getWebSockets(tag?)` → `wsCtx.getWebSockets(tag?)`.
 * - `ctx.setWebSocketAutoResponse("ping", "pong")` → handled in WsContext.
 * - `ctx.storage.setAlarm(ts)` → `setTimeout(() => alarm(), delay)`.
 * - `ws.serializeAttachment(s)` / `ws.deserializeAttachment()` → WsContext.
 * - `ctx.getWebSocketAutoResponseTimestamp(ws)` → WsContext.
 * - HTTP: Bun WebSocket upgrade returns the server-side socket directly.
 *
 * 100% of the protocol, compaction, trim, wedge-detection, and backup logic
 * is preserved.
 */
import { LoroDoc, EphemeralStore, VersionVector } from "loro-crdt";
import {
  CrdtType,
  JoinErrorCode,
  MAX_MESSAGE_SIZE,
  MessageType,
  UpdateStatusCode,
  bytesToHex,
  decode,
  encode,
  type DocUpdate,
  type DocUpdateFragmentHeader,
  type JoinRequest,
  type ProtocolMessage
} from "loro-protocol";
import {
  COMPACT_LOG_BYTES,
  COMPACT_LOG_ROWS,
  DO_FLUSH_MS,
  RETAIN_DAYS,
  materializeTail
} from "../session-doc";
import {
  createRoomBlobStore,
  getJsonBlob,
  putJsonBlob,
  type RoomBlobStore
} from "./room-blob-store";
import { WsContext } from "./ws-context";
import type { SqliteStore } from "../storage/sqlite-store";

const SCHEMA_VERSION = "1";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETAIN_MS = RETAIN_DAYS * DAY_MS;
const REPLAY_CRASH_LIMIT = 3;
const FRAGMENT_BYTES = 200_000;
const MAX_CHECKPOINTS = 36;

interface SocketState {
  userId: string;
  rooms: string[];
  workspace?: boolean;
}

interface FragmentBatch {
  parts: Uint8Array[];
  received: number;
  totalSize: number;
  header: DocUpdateFragmentHeader;
}

interface FrontierCheckpoint {
  at: number;
  frontiers: { peer: string; counter: number }[];
}

export interface SessionRoomOptions {
  workspace?: boolean;
  blobsRootDir: string;
}

export class SessionRoom {
  private readonly db: SqliteStore;
  private readonly blobs: RoomBlobStore;
  /** Blob store for R2 backups (filesystem, shared across rooms). */
  private readonly backupBlobsRoot: string;
  private readonly wsCtx = new WsContext();
  private doc: LoroDoc | undefined;
  private eph: EphemeralStore | undefined;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private alarmTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly metaCache = new Map<string, string>();
  private metaLoaded = false;
  private metaDirty = false;
  private readonly metaDirtyKeys = new Set<string>();
  private logBytesCached = 0;
  private alarmArmed = false;
  private readonly fragments = new Map<WebSocket, Map<string, FragmentBatch>>();
  private readonly _workspace: boolean;

  constructor(
    db: SqliteStore,
    opts: SessionRoomOptions
  ) {
    this.db = db;
    this.backupBlobsRoot = opts.blobsRootDir;
    this._workspace = opts.workspace ?? false;

    let schemaReady = false;
    try {
      const rows = [...db.exec("SELECT value FROM meta WHERE key = '__schema__'")];
      schemaReady = (rows[0]?.value as string) === SCHEMA_VERSION;
    } catch {
      // First-ever instantiation.
    }
    if (schemaReady) {
      this.blobs = createRoomBlobStore(db, { skipInit: true });
    } else {
      db.exec(
        "CREATE TABLE IF NOT EXISTS updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, bytes BLOB NOT NULL, received_at INTEGER NOT NULL)"
      );
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      this.blobs = createRoomBlobStore(db);
      db.exec(
        "INSERT INTO meta (key, value) VALUES ('__schema__', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        SCHEMA_VERSION
      );
    }
  }

  // ── meta helpers ──────────────────────────────────────────────────────────

  private loadMeta(): void {
    if (this.metaLoaded) return;
    this.metaLoaded = true;
    for (const row of this.db.exec("SELECT key, value FROM meta")) {
      this.metaCache.set(row.key as string, row.value as string);
    }
  }

  private getMeta(key: string): string | undefined {
    this.loadMeta();
    return this.metaCache.get(key);
  }

  private setMeta(key: string, value: string): void {
    this.loadMeta();
    if (this.metaCache.get(key) === value) return;
    this.metaCache.set(key, value);
    this.metaDirty = true;
    this.metaDirtyKeys.add(key);
  }

  private async flushMeta(): Promise<void> {
    if (!this.metaDirty) return;
    this.metaDirty = false;
    for (const key of this.metaDirtyKeys) {
      const value = this.metaCache.get(key);
      if (value === undefined) continue;
      this.db.exec(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        key,
        value
      );
    }
    this.metaDirtyKeys.clear();
    await this.db.sync();
  }

  // ── WebSocket management ──────────────────────────────────────────────────

  /** Called by the Bun WS handler when a new socket connects for this room.
   * Returns the server-side WebSocket for the caller to use. */
  attachSocket(ws: WebSocket, userId: string): void {
    this.wsCtx.accept(ws);
    const state: SocketState = {
      userId,
      rooms: [],
      ...(this._workspace ? { workspace: true } : {})
    };
    this.wsCtx.serializeAttachment(ws, state);
  }

  /** Handle an incoming binary/text message from a WebSocket. */
  async onMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message === "string") return; // ping/pong handled by WsContext
    let decoded: ProtocolMessage;
    try {
      decoded = decode(new Uint8Array(message));
    } catch {
      ws.close(1002, "Protocol error");
      return;
    }
    const state = this.wsCtx.deserializeAttachment(ws) as SocketState;
    if (!state) return;
    switch (decoded.type) {
      case MessageType.JoinRequest:
        await this.handleJoin(ws, state, decoded);
        break;
      case MessageType.DocUpdate:
        await this.handleDocUpdate(ws, state, decoded);
        break;
      case MessageType.DocUpdateFragmentHeader:
        this.handleFragmentHeader(ws, state, decoded);
        break;
      case MessageType.DocUpdateFragment:
        await this.handleFragment(ws, decoded);
        break;
      case MessageType.Leave:
        state.rooms = state.rooms.filter((r) => r !== decoded.crdt);
        this.wsCtx.serializeAttachment(ws, state);
        break;
      case MessageType.Ack:
      case MessageType.RoomError:
        break;
      default:
        ws.close(1002, "Unsupported message");
    }
  }

  async onClose(ws: WebSocket): Promise<void> {
    this.fragments.delete(ws);
    this.wsCtx.remove(ws);
    await this.flush();
  }

  async onError(ws: WebSocket): Promise<void> {
    this.fragments.delete(ws);
    this.wsCtx.remove(ws);
    await this.flush();
  }

  // ── HTTP surface ──────────────────────────────────────────────────────────

  /** Handle a non-WS HTTP request routed to this room.
   * Accepts the raw Hono Request — extracts method, path, body internally. */
  async handleRequest(
    method: string,
    pathname: string,
    request: Request,
    userId: string,
    workspace: boolean
  ): Promise<Response> {
    if (pathname === "/ws") {
      // WS upgrade is handled by the Bun server directly.
      return json({ error: "use websocket upgrade" }, 426);
    }

    const owner = this.getMeta("owner");

    if (pathname === "/stats" && method === "GET") {
      if (!workspace) {
        if (!owner) return json({ error: "not_found" }, 404);
        if (owner !== userId) return json({ error: "forbidden" }, 403);
      }
      await this.flush();
      const updateRows = [...this.db.exec("SELECT COUNT(*) AS n FROM updates")][0]?.n as number;
      const snapshot = this.blobs.get("snapshot");
      return json({
        chatId: this.getMeta("chatId") ?? null,
        connectedSockets: this.wsCtx.getWebSockets().length,
        updateRows,
        updateLogBytes: Number(this.getMeta("updateBytes") ?? "0"),
        snapshotBytes: snapshot?.length ?? 0,
        lastReplayMs: Number(this.getMeta("lastReplayMs") ?? "0"),
        lastReplayRows: Number(this.getMeta("lastReplayRows") ?? "0"),
        postReset: this.getMeta("postReset") === "1",
        tailCached: this.getMeta("tailDirty") !== "1" && this.blobs.get("tail") !== undefined,
        diffPublished: this.blobs.get("diff") !== undefined,
        checkpoints: (JSON.parse(this.getMeta("checkpoints") ?? "[]") as unknown[]).length,
        lastTrimAt: this.getMeta("lastTrimAt") ?? null,
        backupDirty: this.getMeta("backupDirty") === "1",
        replayAttempts: Number(this.getMeta("replayAttempts") ?? "0")
      });
    }

    if (pathname === "/tail" && method === "GET") {
      if (!workspace) {
        if (!owner) return json({ error: "not_found" }, 404);
        if (owner !== userId) return json({ error: "forbidden" }, 403);
      }
      return json(await this.currentTail());
    }

    if (pathname === "/diff" && method === "GET") {
      if (!workspace) {
        if (!owner) return json({ error: "not_found" }, 404);
        if (owner !== userId) return json({ error: "forbidden" }, 403);
      }
      const diff = getJsonBlob<unknown>(this.blobs, "diff");
      return diff === undefined ? json({ error: "not_found" }, 404) : json(diff);
    }

    if (pathname === "/diff" && method === "POST") {
      let claimed = false;
      if (!workspace) {
        if (!owner) {
          this.setMeta("owner", userId);
          claimed = true;
        } else if (owner !== userId) {
          return json({ error: "forbidden" }, 403);
        }
      }
      const rawBody = await request.arrayBuffer();
      const jsonBody = rawBody.byteLength > 0 ? JSON.parse(new TextDecoder().decode(rawBody)) : null;
      putJsonBlob(this.blobs, "diff", jsonBody);
      if (claimed) await this.flushMeta();
      return json({ ok: true });
    }

    if (pathname === "/snapshot" && method === "GET") {
      if (!workspace) {
        if (!owner) return json({ error: "not_found" }, 404);
        if (owner !== userId) return json({ error: "forbidden" }, 403);
      }
      await this.flush();
      const doc = await this.ensureDoc();
      const bytes = doc.export({ mode: "snapshot" });
      return new Response(bytes, {
        headers: { "content-type": "application/octet-stream" }
      });
    }

    if (pathname === "/append" && method === "POST") {
      if (!workspace) {
        if (!owner) return json({ error: "not_found" }, 404);
        if (owner !== userId) return json({ error: "forbidden" }, 403);
      }
      const rawAppend = await request.arrayBuffer();
      const updateBytes = new Uint8Array(rawAppend);
      const doc = await this.ensureDoc();
      try {
        if (updateBytes.length > 0) doc.import(updateBytes);
      } catch {
        return json({ error: "invalid_update" }, 400);
      }
      this.recordLoroUpdates([updateBytes]);
      const roomId = this.getMeta("chatId") ?? "";
      for (const ws of this.wsCtx.getWebSockets()) {
        const state = this.wsCtx.deserializeAttachment(ws) as SocketState | null;
        if (!state?.rooms.includes(CrdtType.Loro)) continue;
        this.sendUpdates(ws, CrdtType.Loro, roomId, [updateBytes]);
      }
      return json({ ok: true });
    }

    if (pathname === "/reset-log" && method === "POST") {
      if (!workspace) {
        if (!owner) return json({ error: "not_found" }, 404);
        if (owner !== userId) return json({ error: "forbidden" }, 403);
      }
      const before = [...this.db.exec("SELECT COUNT(*) AS n FROM updates")][0]?.n as
        | number
        | undefined;
      this.dropLog();
      this.doc = undefined;
      await this.flushMeta();
      for (const sock of this.wsCtx.getWebSockets()) {
        try {
          sock.close(4410, "room reset");
        } catch {
          /* already gone */
        }
      }
      return json({ ok: true, clearedUpdateRows: before ?? 0 });
    }

    return json({ error: "not_found" }, 404);
  }

  // ── Protocol handlers ─────────────────────────────────────────────────────

  private async handleJoin(ws: WebSocket, state: SocketState, message: JoinRequest): Promise<void> {
    if (!state.workspace) {
      const owner = this.getMeta("owner");
      if (!owner) this.setMeta("owner", state.userId);
      else if (owner !== state.userId) {
        this.send(ws, {
          type: MessageType.JoinError,
          crdt: message.crdt,
          roomId: message.roomId,
          code: JoinErrorCode.AuthFailed,
          message: "not the room owner"
        });
        return;
      }
    }
    if (!this.getMeta("chatId") && message.roomId) this.setMeta("chatId", message.roomId);

    if (message.crdt === CrdtType.Loro) {
      const doc = await this.ensureDoc();
      if (!state.rooms.includes(message.crdt)) state.rooms.push(message.crdt);
      this.wsCtx.serializeAttachment(ws, state);
      this.send(ws, {
        type: MessageType.JoinResponseOk,
        crdt: message.crdt,
        roomId: message.roomId,
        permission: "write",
        version: doc.version().encode()
      });
      let backfill: Uint8Array;
      if (message.version.length > 0) {
        try {
          backfill = doc.export({ mode: "update", from: VersionVector.decode(message.version) });
        } catch {
          backfill = doc.export({ mode: "snapshot" });
        }
      } else {
        backfill = doc.export({ mode: "snapshot" });
      }
      if (backfill.length > 0) {
        this.sendUpdates(ws, message.crdt, message.roomId, [backfill]);
      }
      return;
    }

    if (message.crdt === CrdtType.LoroEphemeralStore) {
      const eph = this.ensureEph();
      if (!state.rooms.includes(message.crdt)) state.rooms.push(message.crdt);
      this.wsCtx.serializeAttachment(ws, state);
      this.send(ws, {
        type: MessageType.JoinResponseOk,
        crdt: message.crdt,
        roomId: message.roomId,
        permission: "write",
        version: new Uint8Array()
      });
      const all = eph.encodeAll();
      if (all.length > 0) this.sendUpdates(ws, message.crdt, message.roomId, [all]);
      return;
    }

    this.send(ws, {
      type: MessageType.JoinError,
      crdt: message.crdt,
      roomId: message.roomId,
      code: JoinErrorCode.Unknown,
      message: "unsupported crdt"
    });
  }

  private async handleDocUpdate(
    ws: WebSocket,
    state: SocketState,
    message: DocUpdate
  ): Promise<void> {
    if (message.updates.some((u) => u.length > MAX_MESSAGE_SIZE)) {
      this.ack(ws, message, UpdateStatusCode.PayloadTooLarge);
      return;
    }
    if (!state.rooms.includes(message.crdt)) {
      this.ack(ws, message, UpdateStatusCode.PermissionDenied);
      return;
    }
    await this.applyUpdates(ws, message.crdt, message.roomId, message.batchId, message.updates);
  }

  private async applyUpdates(
    ws: WebSocket,
    crdt: CrdtType,
    roomId: string,
    batchId: `0x${string}`,
    updates: Uint8Array[]
  ): Promise<void> {
    if (crdt === CrdtType.Loro) {
      const doc = await this.ensureDoc();
      try {
        for (const update of updates) if (update.length > 0) doc.import(update);
      } catch {
        this.ack(ws, { crdt, roomId }, UpdateStatusCode.InvalidUpdate, batchId);
        return;
      }
      this.recordLoroUpdates(updates);
      this.ack(ws, { crdt, roomId }, UpdateStatusCode.Ok, batchId);
      this.broadcast(ws, crdt, {
        type: MessageType.DocUpdate,
        crdt,
        roomId,
        updates,
        batchId
      });
      return;
    }
    if (crdt === CrdtType.LoroEphemeralStore) {
      const eph = this.ensureEph();
      try {
        for (const update of updates) if (update.length > 0) eph.apply(update);
      } catch {
        this.ack(ws, { crdt, roomId }, UpdateStatusCode.InvalidUpdate, batchId);
        return;
      }
      this.ack(ws, { crdt, roomId }, UpdateStatusCode.Ok, batchId);
      this.broadcast(ws, crdt, {
        type: MessageType.DocUpdate,
        crdt,
        roomId,
        updates,
        batchId
      });
      return;
    }
    this.ack(ws, { crdt, roomId }, UpdateStatusCode.Unknown, batchId);
  }

  private recordLoroUpdates(updates: Uint8Array[]): void {
    let real = false;
    for (const update of updates) {
      if (update.length === 0) continue;
      real = true;
      this.pending.push(update);
      this.pendingBytes += update.length;
    }
    if (!real) return;
    this.setMeta("tailDirty", "1");
    this.setMeta("backupDirty", "1");
    this.setMeta("postReset", "0");
    this.scheduleFlush();
    this.markActivity();
  }

  private handleFragmentHeader(
    ws: WebSocket,
    state: SocketState,
    message: DocUpdateFragmentHeader
  ): void {
    if (!state.rooms.includes(message.crdt)) {
      this.ack(ws, message, UpdateStatusCode.PermissionDenied, message.batchId);
      return;
    }
    let batches = this.fragments.get(ws);
    if (!batches) {
      batches = new Map();
      this.fragments.set(ws, batches);
    }
    batches.set(message.batchId, {
      parts: Array.from({ length: message.fragmentCount }, () => new Uint8Array()),
      received: 0,
      totalSize: message.totalSizeBytes,
      header: message
    });
  }

  private async handleFragment(
    ws: WebSocket,
    message: { crdt: CrdtType; roomId: string; batchId: `0x${string}`; index: number; fragment: Uint8Array }
  ): Promise<void> {
    const batch = this.fragments.get(ws)?.get(message.batchId);
    if (!batch) {
      this.ack(ws, message, UpdateStatusCode.FragmentTimeout, message.batchId);
      return;
    }
    batch.parts[message.index] = message.fragment;
    batch.received++;
    if (batch.received < batch.parts.length) return;
    this.fragments.get(ws)?.delete(message.batchId);
    const total = new Uint8Array(batch.totalSize);
    let off = 0;
    for (const part of batch.parts) {
      total.set(part, off);
      off += part.length;
    }
    await this.applyUpdates(ws, message.crdt, message.roomId, message.batchId, [total]);
  }

  // ── doc/ephemeral materialization ────────────────────────────────────────

  private async ensureDoc(): Promise<LoroDoc> {
    if (this.doc) return this.doc;
    const attempts = Number(this.getMeta("replayAttempts") ?? "0");
    if (attempts >= REPLAY_CRASH_LIMIT) this.dropLog();
    this.setMeta("replayAttempts", String(attempts + 1));
    await this.flushMeta();
    await this.db.sync();
    const started = Date.now();
    const doc = new LoroDoc();
    const snapshot = this.blobs.get("snapshot");
    if (snapshot && snapshot.length > 0) doc.import(snapshot);
    let rows = 0;
    for (const row of this.db.exec("SELECT bytes FROM updates ORDER BY seq")) {
      rows++;
      const combined = new Uint8Array(row.bytes as ArrayBuffer);
      for (const update of this.splitCombinedUpdates(combined)) {
        try {
          doc.import(update);
        } catch {
          /* skip poisoned update */
        }
      }
    }
    this.logBytesCached = Number(this.getMeta("updateBytes") ?? "0");
    for (const update of this.pending) {
      try {
        doc.import(update);
      } catch {
        /* same */
      }
    }
    this.setMeta("replayAttempts", "0");
    await this.flushMeta();
    await this.db.sync();
    const replayMs = Date.now() - started;
    this.setMeta("lastReplayMs", String(replayMs));
    this.setMeta("lastReplayRows", String(rows));
    console.log(
      `cold replay: ${replayMs}ms, ${rows} rows, snapshot ${snapshot?.length ?? 0}B, attempt ${attempts + 1}`
    );
    this.doc = doc;
    return doc;
  }

  private dropLog(): void {
    this.db.exec("DELETE FROM updates");
    this.blobs.delete("snapshot");
    this.setMeta("updateBytes", "0");
    this.setMeta("checkpoints", "[]");
    this.setMeta("lastTrimAt", "");
    this.logBytesCached = 0;
    this.pending = [];
    this.pendingBytes = 0;
    this.setMeta("postReset", "1");
  }

  private ensureEph(): EphemeralStore {
    if (!this.eph) this.eph = new EphemeralStore(30_000);
    return this.eph;
  }

  // ── durability: flush, compaction, backups ───────────────────────────────

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, DO_FLUSH_MS);
  }

  private async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flushMeta();
    if (this.pending.length === 0) return;
    const now = Date.now();
    const combined = this.combinePendingUpdates();
    this.db.exec("INSERT INTO updates (bytes, received_at) VALUES (?, ?)", combined, now);
    this.logBytesCached += this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
    this.setMeta("updateBytes", String(this.logBytesCached));
    await this.flushMeta();
    if (this.logBytesCached > COMPACT_LOG_BYTES) {
      await this.foldLog();
      return;
    }
    const rows = [...this.db.exec("SELECT COUNT(*) AS n FROM updates")][0]?.n as
      | number
      | undefined;
    if ((rows ?? 0) > COMPACT_LOG_ROWS) await this.foldLog();
  }

  private combinePendingUpdates(): ArrayBuffer {
    const headerSize = 4;
    const totalSize = this.pending.reduce(
      (sum, u) => sum + headerSize + u.byteLength,
      0
    );
    const out = new Uint8Array(totalSize);
    const dv = new DataView(out.buffer);
    let off = 0;
    for (const update of this.pending) {
      dv.setUint32(off, update.byteLength);
      off += headerSize;
      out.set(update, off);
      off += update.byteLength;
    }
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  }

  private splitCombinedUpdates(bytes: Uint8Array): Uint8Array[] {
    const updates: Uint8Array[] = [];
    let off = 0;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (off + 4 <= bytes.byteLength) {
      const len = dv.getUint32(off);
      off += 4;
      if (off + len > bytes.byteLength) break;
      updates.push(bytes.subarray(off, off + len));
      off += len;
    }
    return updates;
  }

  private async foldLog(): Promise<void> {
    const doc = await this.ensureDoc();
    this.blobs.put("snapshot", doc.export({ mode: "snapshot" }));
    this.db.exec("DELETE FROM updates");
    this.setMeta("updateBytes", "0");
    this.logBytesCached = 0;
    await this.flushMeta();
  }

  /** Daily alarm: frontier checkpoint, history trim, backup. */
  async alarm(): Promise<void> {
    this.alarmArmed = false;
    await this.flush();
    if (this.getMeta("backupDirty") !== "1") return;
    const doc = await this.ensureDoc();
    const now = Date.now();

    // 1. Record today's frontier checkpoint.
    const checkpoints = JSON.parse(this.getMeta("checkpoints") ?? "[]") as FrontierCheckpoint[];
    checkpoints.push({
      at: now,
      frontiers: doc.frontiers().map((f) => ({ peer: String(f.peer), counter: f.counter }))
    });
    while (checkpoints.length > MAX_CHECKPOINTS) checkpoints.shift();

    // 2. HISTORY TRIM: shallow snapshot at the newest checkpoint older than RETAIN_DAYS.
    const cutoff = checkpoints.filter((c) => now - c.at >= RETAIN_MS).pop();
    if (cutoff && !(doc.isShallow() && this.getMeta("lastTrimAt") === String(cutoff.at))) {
      try {
        const shallow = doc.export({
          mode: "shallow-snapshot",
          frontiers: cutoff.frontiers.map((f) => ({
            peer: f.peer as `${number}`,
            counter: f.counter
          }))
        });
        this.blobs.put("snapshot", shallow);
        this.db.exec("DELETE FROM updates");
        this.setMeta("updateBytes", "0");
        this.logBytesCached = 0;
        this.setMeta("lastTrimAt", String(cutoff.at));
        const fresh = new LoroDoc();
        fresh.import(shallow);
        this.doc = fresh;
      } catch {
        /* trim is best-effort */
      }
    }
    this.setMeta("checkpoints", JSON.stringify(checkpoints));

    // 3. Nightly backup — full current snapshot to filesystem.
    const chatId = this.getMeta("chatId");
    if (chatId && this.getMeta("postReset") !== "1") {
      const current = this.doc ?? doc;
      const prevVV = this.getMeta("backupVV");
      let advances = true;
      if (prevVV) {
        try {
          const prev = VersionVector.decode(
            Uint8Array.from(atob(prevVV), (c) => c.charCodeAt(0))
          );
          const cmp = current.version().compare(prev);
          advances = cmp !== undefined && cmp >= 0;
        } catch {
          /* unreadable meta: allow the put */
        }
      }
      if (advances) {
        const snapshot = current.export({ mode: "snapshot" });
        this.writeBackup(chatId, snapshot);
        this.setMeta(
          "backupVV",
          btoa(String.fromCharCode(...current.version().encode()))
        );
        this.setMeta("backupDirty", "0");
      }
    }
    await this.flushMeta();
  }

  /** Write a backup snapshot to the filesystem blob store. */
  private writeBackup(chatId: string, bytes: Uint8Array): void {
    try {
      const { createFilesystemBlobStore } = require("../storage/blob-store") as typeof import("../storage/blob-store");
      const store = createFilesystemBlobStore(this.backupBlobsRoot);
      store.put(`backup/${chatId}/latest.loro`, bytes);
    } catch (e) {
      console.error("[backup] write failed:", e);
    }
  }

  private markActivity(): void {
    if (this.alarmArmed) return;
    this.alarmArmed = true;
    if (this.alarmTimer) return;
    const delay = DAY_MS;
    this.alarmTimer = setTimeout(() => {
      this.alarmTimer = undefined;
      void this.alarm();
    }, delay);
  }

  private async currentTail(): Promise<unknown> {
    await this.flush();
    if (this.getMeta("tailDirty") !== "1") {
      const cached = getJsonBlob<unknown>(this.blobs, "tail");
      if (cached !== undefined) return cached;
    }
    const doc = await this.ensureDoc();
    const tail = materializeTail(doc, Date.now());
    putJsonBlob(this.blobs, "tail", tail);
    this.setMeta("tailDirty", "0");
    return tail;
  }

  // ── wire helpers ─────────────────────────────────────────────────────────

  private send(ws: WebSocket, message: ProtocolMessage): void {
    try {
      ws.send(encode(message));
    } catch {
      /* socket gone */
    }
  }

  private sendUpdates(
    ws: WebSocket,
    crdt: CrdtType,
    roomId: string,
    updates: Uint8Array[]
  ): void {
    const small = updates.filter((u) => u.length <= MAX_MESSAGE_SIZE);
    if (small.length > 0) {
      this.send(ws, {
        type: MessageType.DocUpdate,
        crdt,
        roomId,
        updates: small,
        batchId: this.newBatchId()
      });
    }
    for (const update of updates) {
      if (update.length <= MAX_MESSAGE_SIZE) continue;
      const batchId = this.newBatchId();
      const fragmentCount = Math.ceil(update.length / FRAGMENT_BYTES);
      this.send(ws, {
        type: MessageType.DocUpdateFragmentHeader,
        crdt,
        roomId,
        batchId,
        fragmentCount,
        totalSizeBytes: update.length
      });
      for (let i = 0; i < fragmentCount; i++) {
        this.send(ws, {
          type: MessageType.DocUpdateFragment,
          crdt,
          roomId,
          batchId,
          index: i,
          fragment: update.subarray(
            i * FRAGMENT_BYTES,
            Math.min((i + 1) * FRAGMENT_BYTES, update.length)
          )
        });
      }
    }
  }

  private broadcast(from: WebSocket, crdt: CrdtType, message: ProtocolMessage): void {
    const bytes = encode(message);
    for (const ws of this.wsCtx.getWebSockets()) {
      if (ws === from) continue;
      const state = this.wsCtx.deserializeAttachment(ws) as SocketState | null;
      if (!state?.rooms.includes(crdt)) continue;
      try {
        ws.send(bytes);
      } catch {
        /* stale socket */
      }
    }
  }

  private ack(
    ws: WebSocket,
    message: { crdt: CrdtType; roomId: string; batchId?: `0x${string}` },
    status: UpdateStatusCode,
    refId?: `0x${string}`
  ): void {
    this.send(ws, {
      type: MessageType.Ack,
      crdt: message.crdt,
      roomId: message.roomId,
      refId: refId ?? message.batchId ?? "0x0000000000000000",
      status
    });
  }

  private newBatchId(): `0x${string}` {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Flush + close DB handle (called by RoomManager on eviction/shutdown). */
  async destroy(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    await this.flush();
  }
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });

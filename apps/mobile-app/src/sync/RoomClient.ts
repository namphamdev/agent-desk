// Loro room client — TS port of RoomClient.swift (crates/sync/src/room.rs).
//
// One client per room (workspace doc or session doc), one WebSocket carrying
// two sub-rooms: the %LOR doc room and the %EPH presence room. Joins with the
// local oplog VV, imports the server's backfill, resubmits anything the
// server lacks, relays local commits as DocUpdate batches until acked.
//
// Loro's native React Native binding exposes the same document model without
// requiring a browser WebAssembly loader.

import { EphemeralStore, LoroDoc, VersionVector } from 'loro-react-native';

import { AppConfig } from '../app/AppConfig';
import {
  batchIdsEqual,
  CrdtType,
  JoinErrorCode,
  LoroWire,
  MAX_MESSAGE_SIZE,
  newBatchId,
  ProtocolMessage,
  RoomErrorCode,
  UpdateStatusCode,
} from './LoroProtocol';
import { openSocket, READY_OPEN, RawSocket, WsMessage } from './socket';

// Constants mirrored from room.rs / RoomClient.swift.
const FRAGMENT_BYTES = 200_000;
const PING_INTERVAL_MS = 30_000;
const SILENCE_LEASE_MS = 45_000;
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 30_000;
const MAX_INVALID_REJOINS = 3;
const MAX_FRAGMENT_COUNT = 4096;
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const JOIN_DEADLINE_MS = 15_000;
const ROOM_PROBE_AFTER_MS = 900_000;
const ROOM_PROBE_MAX_MS = 4 * 3_600_000;
const PROBE_REPLY_GRACE_MS = 30_000;
const LIVENESS_TICK_MS = 5_000;

export type RoomEvent =
  | 'connected'
  | 'disconnected'
  | 'remoteUpdate'
  | 'ephemeralUpdate';

interface FragmentBuffer {
  crdt: CrdtType;
  parts: Array<Uint8Array | null>;
  received: number;
  totalSize: number;
}

interface LocalPendingBatch {
  updates: Uint8Array[][];
}

/**
 * The room client. Plain class — no actor isolation in JS; the runtime is
 * single-threaded so all mutations happen on the JS thread.
 */
export class RoomClient {
  readonly eph = new EphemeralStore(30_000n);
  private socket: RawSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private pending = new Map<string, LocalPendingBatch>();
  private fragments = new Map<string, FragmentBuffer>();
  private joinedLor = false;
  private invalidRejoins = 0;
  private fullResyncRequested = false;
  private backoffMs = BACKOFF_BASE_MS;
  private lastInboundAt = Date.now();
  private closed = false;
  private generation = 0;
  private joinSentAt: number | null = null;
  private joinIsProbe = false;
  private lastLorRx = Date.now();
  private probeIntervalMs = ROOM_PROBE_AFTER_MS;
  private lastProbeAt: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    public readonly roomId: string,
    public readonly doc: LoroDoc,
    private readonly urlProvider: () => Promise<string | null>,
    private readonly events: (event: RoomEvent) => void,
  ) {}

  // MARK: Lifecycle

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.generation += 1;
    this.cleanupTimers();
    if (this.socket) {
      try {
        this.socket.close(1001, 'going away');
      } catch {
        // ignore
      }
      this.socket = null;
    }
    this.joinedLor = false;
  }

  private cleanupTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private connect = async (): Promise<void> => {
    if (this.closed) return;
    this.generation += 1;
    const gen = this.generation;
    this.joinedLor = false;
    this.fullResyncRequested = false;
    this.fragments.clear();
    this.joinSentAt = null;
    this.joinIsProbe = false;
    this.lastLorRx = Date.now();
    this.probeIntervalMs = ROOM_PROBE_AFTER_MS;
    this.lastProbeAt = null;

    const url = await this.urlProvider();
    if (!url) {
      console.warn(`[room ${this.roomId}] no socket URL; backing off`);
      this.scheduleReconnect(gen);
      return;
    }
    this.openSocket(url, gen);
  };

  private openSocket(url: string, gen: number): void {
    if (gen !== this.generation || this.closed) return;
    const socket = openSocket(url, {
      onOpen: () => {
        if (gen !== this.generation) return;
        this.lastInboundAt = Date.now();
        this.armTimers(gen);
        // Join the doc room with our local VV (empty VV asks for snapshot).
        void this.sendJoinLoro(this.localVersionBytes());
      },
      onMessage: (msg) => {
        if (gen !== this.generation) return;
        this.lastInboundAt = Date.now();
        this.handleInbound(msg, gen);
      },
      onClose: (ev) => {
        if (gen !== this.generation) return;
        console.warn(`[room ${this.roomId}] close code=${ev?.code} wasJoined=${this.joinedLor}`);
        this.onSocketError(gen);
      },
      onError: (ev) => {
        if (gen !== this.generation) return;
        console.warn(`[room ${this.roomId}] socket error`, ev);
        this.onSocketError(gen);
      },
    });
    this.socket = socket;
  }

  private armTimers(gen: number): void {
    this.pingTimer = setInterval(() => this.pingTick(gen), PING_INTERVAL_MS);
    this.livenessTimer = setInterval(() => void this.livenessTick(gen), LIVENESS_TICK_MS);
  }

  private onSocketError(gen: number): void {
    if (gen !== this.generation || this.closed) return;
    this.events('disconnected');
    this.scheduleReconnect(gen);
  }

  private scheduleReconnect(gen: number): void {
    if (gen !== this.generation || this.closed) return;
    if (this.socket) {
      try {
        this.socket.close(1006, 'abnormal');
      } catch {
        // ignore
      }
      this.socket = null;
    }
    this.cleanupTimers();
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_CAP_MS);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private pingTick(gen: number): void {
    if (gen !== this.generation || !this.socket) return;
    const silence = Date.now() - this.lastInboundAt;
    if (silence > SILENCE_LEASE_MS) {
      console.warn(`[room ${this.roomId}] socket silent past lease; treating as dead`);
      this.onSocketError(gen);
      return;
    }
    if (this.socket.readyState === READY_OPEN) {
      this.socket.send('ping');
    }
  }

  private async livenessTick(gen: number): Promise<void> {
    if (gen !== this.generation || !this.socket || this.closed) return;
    const now = Date.now();
    if (this.joinSentAt !== null) {
      const base = Math.max(this.joinSentAt, this.lastLorRx);
      if (now - base > JOIN_DEADLINE_MS) {
        console.warn(`[room ${this.roomId}] no JoinResponseOk within deadline; redialing`);
        this.onSocketError(gen);
      }
      return;
    }
    if (now - this.lastLorRx > this.probeIntervalMs) {
      this.joinSentAt = now;
      this.joinIsProbe = true;
      this.lastProbeAt = now;
      this.probeIntervalMs = Math.min(this.probeIntervalMs * 2, ROOM_PROBE_MAX_MS);
      await this.send({
        kind: 'joinRequest',
        crdt: 'loro',
        roomId: this.roomId,
        auth: new Uint8Array(),
        version: this.localVersionBytes(),
      });
    }
  }

  // MARK: Inbound

  private handleInbound(message: WsMessage, gen: number): void {
    if (message.kind === 'text') return; // pong — lease already refreshed
    const frame = LoroWire.decode(message.bytes);
    if (!frame) return;
    this.handleFrame(frame, gen);
  }

  private handleFrame(frame: ProtocolMessage, gen: number): void {
    if (crdtOf(frame) === 'loro') {
      this.lastLorRx = Date.now();
      if (
        this.lastProbeAt !== null &&
        Date.now() - this.lastProbeAt <= PROBE_REPLY_GRACE_MS
      ) {
        // Probe's own reply — leave the backoff decaying.
      } else {
        this.probeIntervalMs = ROOM_PROBE_AFTER_MS;
      }
    }
    switch (frame.kind) {
      case 'joinResponseOk':
        void this.onJoinOk(frame.crdt, frame.version);
        break;
      case 'joinError':
        console.error(
          `[room ${this.roomId}] join error ${JoinErrorCode[frame.code]}: ${frame.message}`,
        );
        if (frame.crdt === 'loro') {
          if (frame.code === JoinErrorCode.VersionUnknown) {
            void this.sendJoinLoro(new Uint8Array());
          } else {
            this.onSocketError(gen);
          }
        }
        break;
      case 'docUpdate':
        this.applyRemote(frame.crdt, frame.updates);
        break;
      case 'docUpdateFragmentHeader':
        if (
          frame.fragmentCount > 0 &&
          frame.fragmentCount <= MAX_FRAGMENT_COUNT &&
          frame.totalSizeBytes <= MAX_REASSEMBLED_BYTES
        ) {
          this.fragments.set(batchKey(frame.batchId), {
            crdt: frame.crdt,
            parts: new Array(frame.fragmentCount).fill(null),
            received: 0,
            totalSize: frame.totalSizeBytes,
          });
        }
        break;
      case 'docUpdateFragment':
        this.onFragment(frame.batchId, frame.index, frame.fragment);
        break;
      case 'ack':
        void this.onAck(frame.crdt, frame.refId, frame.status);
        break;
      case 'roomError':
        if (frame.code === RoomErrorCode.Evicted) {
          this.onSocketError(gen);
        } else {
          void this.sendJoinLoro(this.localVersionBytes());
        }
        break;
      case 'joinRequest':
      case 'leave':
        return;
    }
  }

  private async onJoinOk(crdt: CrdtType, version: Uint8Array): Promise<void> {
    if (crdt === 'loro') {
      this.joinSentAt = null;
      const wasProbe = this.joinIsProbe;
      this.joinIsProbe = false;
      this.joinedLor = true;
      this.backoffMs = BACKOFF_BASE_MS;
      // Resubmit-from-VV: push everything the server lacks.
      if (this.invalidRejoins < MAX_INVALID_REJOINS) {
        const localVv = this.doc.oplogVersion();
        if (!isVvEmpty(localVv)) {
          const serverVersion = version.length === 0
            ? new VersionVector()
            : VersionVector.decode(
                version.buffer.slice(
                  version.byteOffset,
                  version.byteOffset + version.byteLength,
                ) as ArrayBuffer,
              ) as VersionVector;
          if (!serverVersion.includesVv(localVv)) {
            try {
              const missing = this.doc.export({ mode: "updates", from: serverVersion });
              if (missing.byteLength > 0) {
                await this.sendLoroUpdates([new Uint8Array(missing)]);
              }
            } catch (err) {
              console.warn(`[room ${this.roomId}] resubmit export failed`, err);
            }
          }
        }
      }
      if (wasProbe) {
        return; // probe answers only prove liveness
      }
      await this.send({
        kind: 'joinRequest',
        crdt: 'loroEphemeral',
        roomId: this.roomId,
        auth: new Uint8Array(),
        version: new Uint8Array(),
      });
      this.events('connected');
    } else if (crdt === 'loroEphemeral') {
      const all = this.eph.encodeAll();
      if (all.byteLength > 0) {
        await this.send({
          kind: 'docUpdate',
          crdt: 'loroEphemeral',
          roomId: this.roomId,
          updates: [new Uint8Array(all)],
          batchId: newBatchId(),
        });
      }
    }
  }

  private applyRemote(crdt: CrdtType, updates: Uint8Array[]): void {
    if (crdt === 'loro') {
      let imported = false;
      for (const update of updates) {
        if (update.length === 0) continue;
        try {
          this.doc.import_(update.buffer.slice(update.byteOffset, update.byteOffset + update.byteLength) as ArrayBuffer);
          imported = true;
        } catch (err) {
          if (!this.fullResyncRequested) {
            this.fullResyncRequested = true;
            console.error(`[room ${this.roomId}] remote update failed to import; requesting full snapshot resync`, err);
            void this.sendJoinLoro(new Uint8Array());
          }
        }
      }
      if (imported) this.events('remoteUpdate');
    } else if (crdt === 'loroEphemeral') {
      let applied = false;
      for (const update of updates) {
        if (update.length === 0) continue;
        try {
          this.eph.apply(
            update.buffer.slice(
              update.byteOffset,
              update.byteOffset + update.byteLength,
            ) as ArrayBuffer,
          );
          applied = true;
        } catch (err) {
          console.warn(`[room ${this.roomId}] ephemeral update failed to apply`, err);
        }
      }
      if (applied) {
        this.events('ephemeralUpdate');
      }
    }
  }

  private onFragment(batchId: Uint8Array, index: number, fragment: Uint8Array): void {
    const key = batchKey(batchId);
    const buf = this.fragments.get(key);
    if (!buf) return;
    if (index >= buf.parts.length) {
      this.fragments.delete(key);
      return;
    }
    if (buf.parts[index] === null) buf.received += 1;
    buf.parts[index] = fragment;
    if (buf.received < buf.parts.length) {
      this.fragments.set(key, buf);
      return;
    }
    this.fragments.delete(key);
    const total = new Uint8Array(buf.totalSize);
    let off = 0;
    for (const part of buf.parts) {
      const p = part ?? new Uint8Array();
      total.set(p, off);
      off += p.length;
    }
    this.applyRemote(buf.crdt, [total]);
  }

  private async onAck(crdt: CrdtType, refId: Uint8Array, status: UpdateStatusCode): Promise<void> {
    const key = batchKey(refId);
    switch (status) {
      case UpdateStatusCode.Ok:
        this.pending.delete(key);
        break;
      case UpdateStatusCode.FragmentTimeout: {
        const batch = this.pending.get(key);
        this.pending.delete(key);
        if (batch) {
          for (const u of batch.updates) await this.sendLoroUpdates(u);
        }
        break;
      }
      case UpdateStatusCode.InvalidUpdate:
      case UpdateStatusCode.PermissionDenied: {
        console.warn(`[room ${this.roomId}] update rejected (${UpdateStatusCode[status]}); rejoining (${this.invalidRejoins}/${MAX_INVALID_REJOINS})`);
        this.pending.delete(key);
        if (crdt === 'loro' && this.invalidRejoins < MAX_INVALID_REJOINS) {
          this.invalidRejoins += 1;
          await this.sendJoinLoro(this.localVersionBytes());
        }
        break;
      }
      default:
        console.warn(`[room ${this.roomId}] ack status ${UpdateStatusCode[status]}`);
        this.pending.delete(key);
    }
  }

  // MARK: Outbound

  /** Local commit hook — relays the bytes through the room. */
  async sendLocalUpdate(update: Uint8Array): Promise<void> {
    if (!this.joinedLor) {
      console.warn(`[room ${this.roomId}] local update (${update.length}B) deferred — not joined; will resubmit on join`);
      return;
    }
    await this.sendLoroUpdates([update]);
  }

  private async sendJoinLoro(version: Uint8Array): Promise<void> {
    this.joinSentAt = Date.now();
    this.joinIsProbe = false;
    await this.send({
      kind: 'joinRequest',
      crdt: 'loro',
      roomId: this.roomId,
      auth: new Uint8Array(),
      version,
    });
  }

  private async sendLoroUpdates(updates: Uint8Array[]): Promise<void> {
    const small: Uint8Array[] = [];
    let smallBytes = 0;
    for (const update of updates) {
      if (update.length === 0) continue;
      if (update.length > FRAGMENT_BYTES) {
        await this.sendFragmented(update);
        continue;
      }
      if (smallBytes + update.length > FRAGMENT_BYTES) {
        await this.sendBatch(small);
        small.length = 0;
        smallBytes = 0;
      }
      small.push(update);
      smallBytes += update.length;
    }
    if (small.length > 0) await this.sendBatch(small);
  }

  private async sendBatch(updates: Uint8Array[]): Promise<void> {
    if (updates.length === 0) return;
    const batchId = newBatchId();
    this.pending.set(batchKey(batchId), { updates: [updates] });
    await this.send({
      kind: 'docUpdate',
      crdt: 'loro',
      roomId: this.roomId,
      updates,
      batchId,
    });
  }

  private async sendFragmented(update: Uint8Array): Promise<void> {
    const batchId = newBatchId();
    this.pending.set(batchKey(batchId), { updates: [[update]] });
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < update.length; i += FRAGMENT_BYTES) {
      const end = Math.min(i + FRAGMENT_BYTES, update.length);
      chunks.push(update.subarray(i, end));
    }
    await this.send({
      kind: 'docUpdateFragmentHeader',
      crdt: 'loro',
      roomId: this.roomId,
      batchId,
      fragmentCount: chunks.length,
      totalSizeBytes: update.length,
    });
    for (let i = 0; i < chunks.length; i++) {
      await this.send({
        kind: 'docUpdateFragment',
        crdt: 'loro',
        roomId: this.roomId,
        batchId,
        index: i,
        fragment: chunks[i],
      });
    }
  }

  private async send(msg: ProtocolMessage): Promise<void> {
    if (!this.socket || this.socket.readyState !== READY_OPEN) return;
    const data = LoroWire.encode(msg);
    if (!data || data.length > MAX_MESSAGE_SIZE) return;
    // RN WebSocket accepts ArrayBuffer for binary frames.
    this.socket.send(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }

  private localVersionBytes(): Uint8Array {
    const vv = this.doc.oplogVersion();
    if (isVvEmpty(vv)) return new Uint8Array();
    try {
      // Export a snapshot of the current version vector for join requests.
      // The server uses this to determine what updates to send back.
      const encoded = (vv as unknown as { encode?: () => ArrayBuffer }).encode?.();
      return encoded ? new Uint8Array(encoded) : new Uint8Array();
    } catch {
      return new Uint8Array();
    }
  }
}

function crdtOf(frame: ProtocolMessage): CrdtType {
  return frame.crdt;
}

function batchKey(id: Uint8Array): string {
  let s = '';
  for (let i = 0; i < id.length; i++) s += id[i].toString(16).padStart(2, '0');
  return s;
}

function isVvEmpty(vv: unknown): boolean {
  if (!vv) return true;
  if (typeof (vv as { toHashmap?: () => Map<unknown, unknown> }).toHashmap === 'function') {
    return (vv as { toHashmap: () => Map<unknown, unknown> }).toHashmap().size === 0;
  }
  if (vv instanceof Map) return vv.size === 0;
  if (typeof vv === 'object') return Object.keys(vv as Record<string, unknown>).length === 0;
  return true;
}

// Unused export kept for parity / future re-export path.
export const RoomClientInternals = { batchIdsEqual };

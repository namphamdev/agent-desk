// Device-room relay RPC client — TS port of DeviceRelayClient.swift.
//
// Frame codec (binary WS messages): uleb128(headerLen) ‖ headerJSON ‖ payload.
// Header key order MUST be {"s","k","to","from"} (byte parity with both
// implementations); clients never set `to`/`from` — the DO stamps `from`.
// RPC payloads are ndjson ControlRpc frames: {id, method, params} out,
// {id, ok|err|item|done} back.

import { AppConfig } from '../app/AppConfig';
import { openSocket, READY_OPEN, RawSocket, WsMessage } from './socket';

export type RelayErrorKind =
  | 'notConnected'
  | 'hostOffline'
  | 'rpc'
  | 'timeout';

export class RelayError extends Error {
  constructor(public kind: RelayErrorKind, message?: string) {
    super(message ?? kind);
    this.name = 'RelayError';
  }
}

interface PendingCall {
  resolve: (data: Uint8Array) => void;
  reject: (err: RelayError) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface FrameHeader {
  s?: string;
  k?: string;
  to?: string;
  from?: string;
}

export class DeviceRelayClient {
  static readonly rpcKind = 'rpc';
  static readonly relayKind = ' relay'; // leading space intentional

  private socket: RawSocket | null = null;
  private connected = false;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly connId: string;

  constructor(
    public readonly deviceId: string,
    private readonly config: AppConfig,
  ) {
    this.connId = makeUuid();
  }

  // MARK: RPC

  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.callOnce<T>(method, params);
      } catch (err) {
        if (!(err instanceof RelayError)) throw err;
        if (attempt >= 2) throw err;
        if (err.kind === 'hostOffline' || err.kind === 'notConnected') {
          this.teardown(err.kind);
          await delay((attempt + 1) * 250);
        } else {
          throw err;
        }
      }
    }
    throw new RelayError('notConnected');
  }

  close(): void {
    this.teardown('notConnected');
  }

  private async callOnce<T>(method: string, params: Record<string, unknown>): Promise<T> {
    await this.connect();
    const id = this.nextId++;
    const frame = JSON.stringify({ id, method, params });
    const payload = new TextEncoder().encode(frame);
    const data = encodeFrame('{"s":"rpc","k":"rpc"}', payload);

    const result = await new Promise<Uint8Array>((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        timer: setTimeout(() => this.timeoutCall(id), 10_000),
      });
      this.send(data, id);
    });

    const text = new TextDecoder('utf-8').decode(result);
    const parsed = JSON.parse(text) as { ok?: unknown; err?: string };
    if (parsed.err) throw new RelayError('rpc', parsed.err);
    return parsed.ok as T;
  }

  private async connect(): Promise<void> {
    if (this.connected && this.socket) return;
    const url = await this.config.deviceRelaySocketURL(this.deviceId, makeUuid());
    if (!url) throw new RelayError('notConnected');

    await new Promise<void>((resolve, reject) => {
      const socket = openSocket(url, {
        onOpen: () => {
          this.connected = true;
          this.armPing();
          resolve();
        },
        onMessage: (msg) => this.handleInbound(msg),
        onClose: () => {
          this.teardown('hostOffline');
          if (!this.connected) reject(new RelayError('hostOffline'));
        },
        onError: () => {
          this.teardown('hostOffline');
          if (!this.connected) reject(new RelayError('hostOffline'));
        },
      });
      this.socket = socket;
    });
  }

  private armPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.socket?.readyState === READY_OPEN) this.socket.send('ping');
    }, 30_000);
  }

  private teardown(kind: RelayErrorKind): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close(1001);
      } catch {
        // ignore
      }
      this.socket = null;
    }
    this.connected = false;
    const waiting = this.pending;
    this.pending = new Map();
    for (const [, p] of waiting) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new RelayError(kind));
    }
  }

  private send(data: Uint8Array, id: number): void {
    if (!this.socket || this.socket.readyState !== READY_OPEN) {
      this.failCall(id, new RelayError('notConnected'));
      return;
    }
    try {
      this.socket.send(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    } catch {
      this.failCall(id, new RelayError('notConnected'));
      this.teardown('notConnected');
    }
  }

  private failCall(id: number, err: RelayError): void {
    const p = this.pending.get(id);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(id);
    p.reject(err);
  }

  private timeoutCall(id: number): void {
    this.failCall(id, new RelayError('timeout'));
  }

  private handleInbound(message: WsMessage): void {
    if (message.kind === 'text') return; // pong
    const decoded = decodeFrame(message.bytes);
    if (!decoded) return;
    const { header, payload } = decoded;
    if (header.k === DeviceRelayClient.rpcKind) {
      this.handleRpcPayload(payload);
    } else if (header.k === DeviceRelayClient.relayKind) {
      this.teardown('hostOffline');
    }
  }

  private handleRpcPayload(payload: Uint8Array): void {
    const text = new TextDecoder('utf-8').decode(payload);
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      let obj: { id?: number; ok?: unknown; err?: string };
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const id = obj.id;
      if (typeof id !== 'number') continue;
      const p = this.pending.get(id);
      if (!p) continue;
      if (p.timer) clearTimeout(p.timer);
      this.pending.delete(id);
      if (obj.err) {
        p.reject(new RelayError('rpc', obj.err));
      } else {
        p.resolve(new TextEncoder().encode(JSON.stringify({ ok: obj.ok ?? null })));
      }
    }
  }
}

// ---- Frame codec ----

function encodeFrame(header: string, payload: Uint8Array): Uint8Array {
  const headerBytes = new TextEncoder().encode(header);
  // uleb128 length prefix
  let len = headerBytes.length;
  const lenBytes: number[] = [];
  do {
    let b = len & 0x7f;
    len = Math.floor(len / 128);
    if (len !== 0) b |= 0x80;
    lenBytes.push(b);
  } while (len !== 0);

  const out = new Uint8Array(lenBytes.length + headerBytes.length + payload.length);
  out.set(lenBytes, 0);
  out.set(headerBytes, lenBytes.length);
  out.set(payload, lenBytes.length + headerBytes.length);
  return out;
}

function decodeFrame(data: Uint8Array): { header: FrameHeader; payload: Uint8Array } | null {
  let offset = 0;
  let length = 0;
  let shift = 0;
  while (offset < data.length) {
    const byte = data[offset++];
    length |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 28) return null;
  }
  if (offset + length > data.length) return null;
  const headerBytes = data.subarray(offset, offset + length);
  let header: FrameHeader;
  try {
    header = JSON.parse(new TextDecoder('utf-8').decode(headerBytes)) as FrameHeader;
  } catch {
    return null;
  }
  const payload = data.subarray(offset + length);
  return { header, payload };
}

function makeUuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // RFC4122 v4 fallback (sufficient for relay connId uniqueness).
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else if (i === 19) out += hex[(Math.random() * 4) | 8];
    else out += hex[(Math.random() * 16) | 0];
  }
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

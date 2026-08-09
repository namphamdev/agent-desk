// loro-protocol 0.3 wire codec — TS port of LoroProtocol.swift (and the
// loro-protocol crate's encoding.rs), byte-compatible with the Rust engine
// and the TS edge.
//
// Frame layout: [4-byte CRDT magic][varBytes room_id][1-byte type][payload].
// Varints are ULEB128; varBytes/varString are length-prefixed; batch ids are
// 8 raw bytes. Max message 256 KiB.

import { ByteReader, ByteWriter, randomBatchId } from './bytes';

export type CrdtType = 'loro' | 'loroEphemeral';

const MAGIC_LORO = encodeAscii('%LOR');
const MAGIC_EPH = encodeAscii('%EPH');

function encodeAscii(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function crdtFromMagic(bytes: Uint8Array): CrdtType | null {
  if (bytesEqual(bytes, MAGIC_LORO)) return 'loro';
  if (bytesEqual(bytes, MAGIC_EPH)) return 'loroEphemeral';
  return null;
}

export function crdtMagic(crdt: CrdtType): Uint8Array {
  return crdt === 'loro' ? MAGIC_LORO : MAGIC_EPH;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export enum JoinErrorCode {
  Unknown = 0x00,
  VersionUnknown = 0x01,
  AuthFailed = 0x02,
  AppError = 0x7f,
}

export enum UpdateStatusCode {
  Ok = 0x00,
  Unknown = 0x01,
  PermissionDenied = 0x03,
  InvalidUpdate = 0x04,
  PayloadTooLarge = 0x05,
  RateLimited = 0x06,
  FragmentTimeout = 0x07,
  AppError = 0x7f,
}

export enum RoomErrorCode {
  RejoinSuggested = 0x01,
  Evicted = 0x02,
  Unknown = 0x7f,
}

export type ProtocolMessage =
  | { kind: 'joinRequest'; crdt: CrdtType; roomId: string; auth: Uint8Array; version: Uint8Array }
  | { kind: 'joinResponseOk'; crdt: CrdtType; roomId: string; permission: string; version: Uint8Array; extra: Uint8Array }
  | { kind: 'joinError'; crdt: CrdtType; roomId: string; code: JoinErrorCode; message: string }
  | { kind: 'docUpdate'; crdt: CrdtType; roomId: string; updates: Uint8Array[]; batchId: Uint8Array }
  | { kind: 'docUpdateFragmentHeader'; crdt: CrdtType; roomId: string; batchId: Uint8Array; fragmentCount: number; totalSizeBytes: number }
  | { kind: 'docUpdateFragment'; crdt: CrdtType; roomId: string; batchId: Uint8Array; index: number; fragment: Uint8Array }
  | { kind: 'roomError'; crdt: CrdtType; roomId: string; code: RoomErrorCode; message: string }
  | { kind: 'ack'; crdt: CrdtType; roomId: string; refId: Uint8Array; status: UpdateStatusCode }
  | { kind: 'leave'; crdt: CrdtType; roomId: string };

function typeByteFor(msg: ProtocolMessage): number {
  switch (msg.kind) {
    case 'joinRequest': return 0x00;
    case 'joinResponseOk': return 0x01;
    case 'joinError': return 0x02;
    case 'docUpdate': return 0x03;
    case 'docUpdateFragmentHeader': return 0x04;
    case 'docUpdateFragment': return 0x05;
    case 'roomError': return 0x06;
    case 'leave': return 0x07;
    case 'ack': return 0x08;
  }
}

export const MAX_MESSAGE_SIZE = 256 * 1024;
export const FRAGMENT_BYTES = 200_000;

export const LoroWire = {
  encode(msg: ProtocolMessage): Uint8Array | null {
    const w = new ByteWriter();
    const type = typeByteFor(msg);
    // header
    w.raw(crdtMagic(msg.crdt));
    w.varBytes(new TextEncoder().encode(msg.roomId));
    w.byte(type);

    switch (msg.kind) {
      case 'joinRequest':
        w.varBytes(msg.auth);
        w.varBytes(msg.version);
        break;
      case 'joinResponseOk':
        w.varString(msg.permission);
        w.varBytes(msg.version);
        w.varBytes(msg.extra);
        break;
      case 'joinError':
        w.byte(msg.code);
        w.varString(msg.message);
        break;
      case 'docUpdate':
        w.uleb128(msg.updates.length);
        for (const u of msg.updates) w.varBytes(u);
        w.raw(msg.batchId);
        break;
      case 'docUpdateFragmentHeader':
        w.raw(msg.batchId);
        w.uleb128(msg.fragmentCount);
        w.uleb128(msg.totalSizeBytes);
        break;
      case 'docUpdateFragment':
        w.raw(msg.batchId);
        w.uleb128(msg.index);
        w.varBytes(msg.fragment);
        break;
      case 'roomError':
        w.byte(msg.code);
        w.varString(msg.message);
        break;
      case 'ack':
        w.raw(msg.refId);
        w.byte(msg.status);
        break;
      case 'leave':
        break;
    }
    if (w.length > MAX_MESSAGE_SIZE) return null;
    return w.bytes;
  },

  decode(data: Uint8Array): ProtocolMessage | null {
    const r = new ByteReader(data);
    const magic = r.read(4);
    if (!magic) return null;
    const crdt = crdtFromMagic(magic);
    if (!crdt) return null;
    const roomBytes = r.varBytes(128);
    if (!roomBytes) return null;
    const roomId = new TextDecoder('utf-8').decode(roomBytes);
    const type = r.readByte();
    if (type === null) return null;

    switch (type) {
      case 0x00: {
        const auth = r.varBytes();
        const version = r.varBytes();
        if (!auth || !version) return null;
        return { kind: 'joinRequest', crdt, roomId, auth, version };
      }
      case 0x01: {
        const perm = r.varString();
        if (perm === null) return null;
        const version = r.varBytes();
        if (!version) return null;
        const extra = r.varBytes() ?? new Uint8Array();
        return { kind: 'joinResponseOk', crdt, roomId, permission: perm, version, extra };
      }
      case 0x02: {
        const codeByte = r.readByte();
        const msg = r.varString();
        if (codeByte === null || msg === null) return null;
        const code = codeByte in JoinErrorCode ? (codeByte as JoinErrorCode) : JoinErrorCode.Unknown;
        return { kind: 'joinError', crdt, roomId, code, message: msg };
      }
      case 0x03: {
        const count = r.uleb128();
        if (count === null) return null;
        const updates: Uint8Array[] = [];
        for (let i = 0; i < count; i++) {
          const u = r.varBytes();
          if (!u) return null;
          updates.push(u);
        }
        const id = r.read(8);
        if (!id) return null;
        return { kind: 'docUpdate', crdt, roomId, updates, batchId: copyBytes(id) };
      }
      case 0x04: {
        const id = r.read(8);
        const count = r.uleb128();
        const total = r.uleb128();
        if (!id || count === null || total === null) return null;
        return {
          kind: 'docUpdateFragmentHeader',
          crdt, roomId, batchId: copyBytes(id),
          fragmentCount: count, totalSizeBytes: total,
        };
      }
      case 0x05: {
        const id = r.read(8);
        const index = r.uleb128();
        const fragment = r.varBytes();
        if (!id || index === null || !fragment) return null;
        return {
          kind: 'docUpdateFragment',
          crdt, roomId, batchId: copyBytes(id), index, fragment,
        };
      }
      case 0x06: {
        const codeByte = r.readByte();
        const msg = r.varString();
        if (codeByte === null || msg === null) return null;
        const code = codeByte in RoomErrorCode ? (codeByte as RoomErrorCode) : RoomErrorCode.Unknown;
        return { kind: 'roomError', crdt, roomId, code, message: msg };
      }
      case 0x08: {
        const id = r.read(8);
        const statusByte = r.readByte();
        if (!id || statusByte === null) return null;
        const status = statusByte in UpdateStatusCode
          ? (statusByte as UpdateStatusCode)
          : UpdateStatusCode.Unknown;
        return { kind: 'ack', crdt, roomId, refId: copyBytes(id), status };
      }
      case 0x07:
        return { kind: 'leave', crdt, roomId };
      default:
        return null;
    }
  },
};

/** Generate a fresh 8-byte batch id (caller-side convenience). */
export function newBatchId(): Uint8Array {
  return randomBatchId();
}

function copyBytes(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length);
  out.set(src);
  return out;
}

/** BatchId equality helper (callers compare stored ids). */
export function batchIdsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

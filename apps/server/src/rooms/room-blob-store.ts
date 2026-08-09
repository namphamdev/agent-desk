/**
 * Chunked blob storage over a room's SQLite DB. Durable Object SQL caps
 * individual values at ~2MB; session snapshots and diff sidecars can exceed
 * that, so named blobs are stored as ordered chunk rows.
 *
 * This is the same logic as the edge/ BlobStore but operates on the
 * SqliteStore (which mirrors the SqlStorage interface).
 */

const CHUNK_BYTES = 1_500_000;

export interface RoomBlobStore {
  put(name: string, bytes: Uint8Array): void;
  get(name: string): Uint8Array | undefined;
  delete(name: string): void;
}

export interface CreateRoomBlobStoreOptions {
  skipInit?: boolean;
}

import type { SqliteStore } from "../storage/sqlite-store";

export const createRoomBlobStore = (
  sql: SqliteStore,
  opts?: CreateRoomBlobStoreOptions
): RoomBlobStore => {
  if (!opts?.skipInit) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS blobs (name TEXT NOT NULL, idx INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (name, idx))"
    );
  }

  return {
    put(name: string, bytes: Uint8Array): void {
      sql.exec("DELETE FROM blobs WHERE name = ?", name);
      for (let i = 0, idx = 0; i === 0 || i < bytes.length; i += CHUNK_BYTES, idx++) {
        const chunk = bytes.subarray(i, Math.min(i + CHUNK_BYTES, bytes.length));
        sql.exec("INSERT INTO blobs (name, idx, bytes) VALUES (?, ?, ?)", name, idx, chunk);
      }
    },

    get(name: string): Uint8Array | undefined {
      const rows = [...sql.exec("SELECT bytes FROM blobs WHERE name = ? ORDER BY idx", name)];
      if (rows.length === 0) return undefined;
      const parts = rows.map((r) => new Uint8Array(r.bytes as ArrayBuffer));
      const total = parts.reduce((a, p) => a + p.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const p of parts) {
        out.set(p, off);
        off += p.length;
      }
      return out;
    },

    delete(name: string): void {
      sql.exec("DELETE FROM blobs WHERE name = ?", name);
    }
  };
};

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();

export const putJsonBlob = <T>(store: RoomBlobStore, name: string, value: T): void =>
  store.put(name, textEncoder.encode(JSON.stringify(value)));

export const getJsonBlob = <T>(store: RoomBlobStore, name: string): T | undefined => {
  const bytes = store.get(name);
  if (!bytes) return undefined;
  try {
    return JSON.parse(textDecoder.decode(bytes)) as T;
  } catch {
    return undefined;
  }
};

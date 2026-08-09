/**
 * Filesystem blob store — mirrors the in-DO chunked BlobStore interface but
 * persists to the filesystem under `{DATA_DIR}/blobs/`. Used for:
 * - Room-internal named blobs (snapshots, tails, diffs) via a per-room prefix.
 * - Content-addressed attachment uploads (`att/{userId}/{sha256}`).
 * - Encrypted account settings (`settings/{userId}`).
 * - Nightly backups (`backup/{chatId}/latest.loro`).
 *
 * Atomic writes: write to a temp file, then rename (POSIX atomic).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

export interface BlobStore {
  /** Store bytes under a name. Overwrites if exists. */
  put(name: string, bytes: Uint8Array): void;
  /** Read bytes for a name, or undefined if not found. */
  get(name: string): Uint8Array | undefined;
  /** Check existence. */
  head(name: string): boolean;
  /** Delete by name. No-op if not found. */
  delete(name: string): void;
}

export const createFilesystemBlobStore = (rootDir: string): BlobStore => {
  const resolvePath = (name: string): string => join(rootDir, ...name.split("/"));

  return {
    put(name: string, bytes: Uint8Array): void {
      const path = resolvePath(name);
      mkdirSync(dirname(path), { recursive: true });
      // Atomic write: tmp file + rename.
      const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, path);
    },

    get(name: string): Uint8Array | undefined {
      const path = resolvePath(name);
      if (!existsSync(path)) return undefined;
      return new Uint8Array(readFileSync(path));
    },

    head(name: string): boolean {
      return existsSync(resolvePath(name));
    },

    delete(name: string): void {
      const path = resolvePath(name);
      try {
        unlinkSync(path);
      } catch {
        /* already gone */
      }
    }
  };
};

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();

export const putJsonBlob = (store: BlobStore, name: string, value: unknown): void =>
  store.put(name, textEncoder.encode(JSON.stringify(value)));

export const getJsonBlob = <T>(store: BlobStore, name: string): T | undefined => {
  const bytes = store.get(name);
  if (!bytes) return undefined;
  try {
    return JSON.parse(textDecoder.decode(bytes)) as T;
  } catch {
    return undefined;
  }
};

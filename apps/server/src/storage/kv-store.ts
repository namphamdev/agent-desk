/**
 * Filesystem JSON KV store — replaces Cloudflare KVNamespace for push tokens.
 * All keys and values are stored in a single JSON file, atomically rewritten
 * on each put/delete. Fine for low-churn data (push tokens).
 *
 * Key layout: `push:{userId}` → Expo push token string.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const createFilesystemKvStore = (dataDir: string): KvStore => {
  const kvPath = join(dataDir, "push-tokens.json");
  let cache: Map<string, string> | undefined;

  const load = (): Map<string, string> => {
    if (cache) return cache;
    if (!existsSync(kvPath)) {
      cache = new Map();
      return cache;
    }
    try {
      const raw = readFileSync(kvPath, "utf-8");
      const obj = JSON.parse(raw) as Record<string, string>;
      cache = new Map(Object.entries(obj));
    } catch {
      cache = new Map();
    }
    return cache;
  };

  const persist = (): void => {
    const m = load();
    const obj: Record<string, string> = {};
    for (const [k, v] of m) obj[k] = v;
    mkdirSync(dirname(kvPath), { recursive: true });
    const tmp = `${kvPath}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, kvPath);
  };

  return {
    async get(key: string): Promise<string | null> {
      return load().get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      load().set(key, value);
      persist();
    },
    async delete(key: string): Promise<void> {
      load().delete(key);
      persist();
    }
  };
};

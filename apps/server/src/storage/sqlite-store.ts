/**
 * SQLite wrapper around bun:sqlite. Mirrors the SqlStorage interface from
 * Cloudflare Durable Objects so the room classes can use the same
 * `sql.exec(sql, ...params)` calling convention.
 *
 * Each room gets its own DB file at `{DATA_DIR}/rooms/{roomId}.db`, opened
 * lazily and kept as a long-lived handle inside the RoomManager.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** One row from a query. Values are typed as unknown — callers cast. */
export type SqlRow = Record<string, unknown>;

export interface SqlResultIterator {
  [Symbol.iterator](): IterableIterator<SqlRow>;
}

/** Subset of the Cloudflare SqlStorage statement interface that the rooms
 * actually use: an iterable of rows plus direct property access. */
export interface SqlStatement {
  [Symbol.iterator](): IterableIterator<SqlRow>;
  /** Return rows as an array (for spread or indexing). */
  toArray?(): SqlRow[];
}

/** Drop-in for the DO `ctx.storage.sql` surface. */
export class SqliteStore {
  private readonly db: Database;
  readonly #roomId: string;

  constructor(dbPath: string, roomId: string) {
    this.#roomId = roomId;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    // WAL mode: concurrent reads during writes, durable on each exec.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
  }

  /** Factory: open (or create) a DB file for a room id. */
  static open(dataDir: string, roomId: string): SqliteStore {
    return new SqliteStore(join(dataDir, "rooms", `${roomId}.db`), roomId);
  }

  get roomId(): string {
    return this.#roomId;
  }

  /** Execute SQL with bind parameters. Returns an iterable of rows (mirrors
   * `ctx.storage.sql.exec()`). */
  exec(sql: string, ...params: unknown[]): SqlStatement {
    const stmt = this.db.prepare(sql);
    try {
      const result = stmt.all(...(params as never[]));
      return result as unknown as SqlStatement;
    } finally {
      stmt.finalize();
    }
  }

  /** No-op: WAL auto-syncs. Kept for API parity with DO `ctx.storage.sync()`. */
  async sync(): Promise<void> {
    // WAL mode handles durability; no explicit sync needed.
  }

  /** Close the DB handle (called on room eviction or shutdown). */
  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

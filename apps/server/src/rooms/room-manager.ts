/**
 * RoomManager — replaces Durable Object instance-per-id routing.
 *
 * In the DO model, Cloudflare automatically routed requests to the right DO
 * instance by name. Here, the RoomManager holds a Map<roomId, RoomInstance>
 * and ensures a single in-process instance per room id. Lazy loading: a room
 * is instantiated on first access, its SQLite DB opened on demand.
 *
 * Eviction: LRU when the cache exceeds maxCached rooms. Idle rooms (no access
 * for > idleTimeoutMs) are also evicted by a periodic sweep. Eviction flushes
 * and closes the DB handle; the DB file persists on disk.
 *
 * On process shutdown: flush all rooms and close their DB handles.
 */
import { SessionRoom } from "./session-room";
import { DeviceRoom } from "./device-room";
import { SqliteStore } from "../storage/sqlite-store";
import type { Env } from "../env";

type RoomKind = "session" | "device" | "session-workspace";

interface RoomEntry {
  room: SessionRoom | DeviceRoom;
  kind: RoomKind;
  db: SqliteStore;
  lastAccess: number;
}

const MAX_CACHED = 100;
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class RoomManager {
  private readonly rooms = new Map<string, RoomEntry>();
  private readonly env: Env;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(env: Env) {
    this.env = env;
    // Periodic idle sweep.
    this.sweepTimer = setInterval(() => this.sweepIdle(), SWEEP_INTERVAL_MS);
  }

  /** Get or create a session room (chat doc). */
  getSession(roomId: string): SessionRoom {
    return this.getOrCreate(roomId, "session") as SessionRoom;
  }

  /** Get or create a workspace room (per-user workspace doc). */
  getWorkspace(roomId: string): SessionRoom {
    return this.getOrCreate(roomId, "session-workspace") as SessionRoom;
  }

  /** Get or create a device room. */
  getDevice(roomId: string): DeviceRoom {
    return this.getOrCreate(roomId, "device") as DeviceRoom;
  }

  private getOrCreate(roomId: string, kind: RoomKind): SessionRoom | DeviceRoom {
    const existing = this.rooms.get(roomId);
    if (existing) {
      existing.lastAccess = Date.now();
      return existing.room;
    }

    // Open SQLite for this room.
    const db = SqliteStore.open(this.env.DATA_DIR, roomId);

    let room: SessionRoom | DeviceRoom;
    if (kind === "device") {
      room = new DeviceRoom(db);
    } else {
      room = new SessionRoom(db, {
        workspace: kind === "session-workspace",
        blobsRootDir: this.env.DATA_DIR + "/blobs"
      });
    }

    this.rooms.set(roomId, { room, kind, db, lastAccess: Date.now() });
    this.maybeEvict();
    return room;
  }

  /** Evict LRU if over capacity. */
  private maybeEvict(): void {
    if (this.rooms.size <= MAX_CACHED) return;
    // Find the least-recently-accessed entry.
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, entry] of this.rooms) {
      if (entry.lastAccess < oldestTime) {
        oldestTime = entry.lastAccess;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.evict(oldestKey);
    }
  }

  /** Evict idle rooms (no access for > IDLE_TIMEOUT_MS). */
  private sweepIdle(): void {
    const now = Date.now();
    for (const [key, entry] of this.rooms) {
      if (now - entry.lastAccess > IDLE_TIMEOUT_MS) {
        this.evict(key);
      }
    }
  }

  private evict(key: string): void {
    const entry = this.rooms.get(key);
    if (!entry) return;
    this.rooms.delete(key);
    void entry.room.destroy().then(() => entry.db.close());
  }

  /** Flush all rooms and close DB handles (graceful shutdown). */
  async shutdown(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    const entries = [...this.rooms.values()];
    this.rooms.clear();
    await Promise.all(
      entries.map(async (entry) => {
        try {
          await entry.room.destroy();
        } catch {
          /* best-effort */
        }
        entry.db.close();
      })
    );
  }
}

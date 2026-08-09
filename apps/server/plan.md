# apps/server — Self-host edge server

Thay thế `edge/` (Cloudflare Worker + Durable Objects) bằng server self-host, giải quyết giới hạn 100K rows_written/ngày của DO free tier. Giữ nguyên 100% protocol và API contract để Rust client (`crates/sync`) và mobile app (`apps/mobile-app`) không phải đổi.

## Stack

- **Runtime**: Bun 1.2+ (native WebSocket, native SQLite, TypeScript native)
- **Web framework**: Hono (cùng họ với Worker, port `index.ts` gần như 1:1)
- **CRDT**: `loro-crdt` (cùng npm package đang dùng ở `edge/`)
- **Protocol codec**: `loro-protocol` (binary frames giữ nguyên)
- **Storage**: `bun:sqlite` (native, WAL mode, một DB file per room)
- **Blobs**: filesystem (mirror R2 key structure) + optional MinIO sau
- **KV**: filesystem JSON (cho push tokens)
- **Auth**: `jose` (JWKS verify, thay Web Crypto API)
- **Deploy**: Docker + Docker Compose (Caddy/Traefik làm TLS terminator tuỳ chọn)

## Cấu trúc thư mục

```
apps/server/
├── package.json              # bun, hono, loro-crdt, loro-protocol, jose, nanoid
├── tsconfig.json
├── README.md                 # deploy guide
├── Dockerfile                # build Bun binary, chạy production
├── docker-compose.yml        # compose template (volume + env + restart)
├── .dockerignore
├── .env.example              # env vars reference
├── src/
│   ├── server.ts             # Bun.serve entry, Hono router, WebSocket handler
│   ├── env.ts                # Env interface (port từ edge/src/env.ts, bỏ R2/DO types)
│   ├── auth/
│   │   ├── authenticate.ts   # JWKS verify (port từ edge/src/auth.ts)
│   │   └── auth-routes.ts    # WorkOS exchange/refresh/orgs (port từ edge/src/auth-routes.ts)
│   ├── rooms/
│   │   ├── room-manager.ts   # Map<roomId, RoomInstance>, lazy load, LRU evict
│   │   ├── session-room.ts   # class SessionRoom (port từ DO, dùng bun:sqlite)
│   │   ├── device-room.ts    # class DeviceRoom (port từ DO)
│   │   └── ws-handler.ts     # ws upgrade handler, route tới đúng room
│   ├── storage/
│   │   ├── sqlite-store.ts   # wrapper quanh bun:sqlite, mirror ctx.storage.sql API
│   │   ├── blob-store.ts     # filesystem blob store (mirror R2 interface)
│   │   └── kv-store.ts       # filesystem JSON (mirror KV interface)
│   ├── routes/
│   │   ├── session.ts        # /session/:chatId/ws, /tail, /diff, /snapshot, /append, /stats
│   │   ├── workspace.ts      # /workspace/:orgId/ws, /tail, /stats, /reset-log
│   │   ├── device.ts         # /device/:deviceId/ws, /sidecar, /status, /nudge
│   │   ├── attachments.ts    # /attachments/:sha256 PUT/GET/HEAD
│   │   ├── account-settings.ts
│   │   ├── push.ts           # /push/register, /push/send
│   │   ├── releases.ts       # /releases/* static serving
│   │   └── install-sh.ts     # /install.sh
│   └── utils/
│       ├── schema.ts         # SCHEMA_VERSION constants
│       └── crypto.ts         # crypto helpers (Bun native crypto.subtle)
└── data/                     # gitignored, runtime storage (Docker volume mount)
    ├── rooms/                # SQLite files: rooms/{roomId}.db
    ├── blobs/                # mirror R2 keys: blobs/att/{userId}/{sha256}
    ├── releases/             # release artifacts
    └── push-tokens.json      # KV replacement
```

## Dockerfile (multi-stage)

```dockerfile
# Build stage
FROM oven/bun:1.2 AS build
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun build src/server.ts --target bun --outdir dist

# Runtime stage
FROM oven/bun:1.2-debian
WORKDIR /app
COPY --from=build /app/dist/server.js ./server.js
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src/install.sh ./install.sh

# Data volume mount point
VOLUME ["/app/data"]
ENV DATA_DIR=/app/data
ENV PORT=3000
EXPOSE 3000

# Bun native WebSocket + HTTP server
CMD ["bun", "run", "server.js"]
```

## docker-compose.yml (template)

```yaml
version: "3.9"
services:
  comet-server:
    build: .
    container_name: comet-server
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
      - ./install.sh:/app/install.sh:ro  # hoặc để build copy
    env_file:
      - .env
    healthcheck:
      test: ["CMD", "bun", "-e", "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3

  # Optional: auto TLS + reverse proxy
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - comet-server

volumes:
  caddy_data:
  caddy_config:
```

Caddyfile tối giản (chỉ khi cần TLS, nếu chạy sau Cloudflare/Load Balancer thì bỏ):

```
comet-server.yourdomain.com {
  reverse_proxy comet-server:3000
}
```

## Plan thực hiện (8 phase)

### Phase 1: Scaffolding + env (2 giờ)
- Khởi tạo `apps/server/` với `bun init`
- Dependencies: `hono`, `loro-crdt`, `loro-protocol`, `jose`, `nanoid`
- Port `edge/src/env.ts`: bỏ `DurableObjectNamespace`, `R2Bucket`, `KVNamespace`. Thay bằng config interface:
  ```ts
  interface Env {
    DATA_DIR: string;        // default /app/data
    PORT: number;            // default 3000
    WORKOS_CLIENT_ID: string;
    AUTH_MODE: "workos" | "dev";
    WORKOS_ISSUER?: string;
    WORKOS_JWKS_URL?: string;
    WORKOS_API_KEY?: string;
    SETTINGS_ENCRYPTION_KEY?: string;
    PUSH_INTERNAL_SECRET?: string;
  }
  ```
- `server.ts` skeleton: `Bun.serve({ port, fetch: app.fetch, websocket: handler })`
- `.env.example` với tất cả env vars
- `.dockerignore` (loại trừ `data/`, `node_modules`, `.git`)

### Phase 2: Storage layer (3 giờ)
- `sqlite-store.ts`: wrapper quanh `bun:sqlite`
  - `exec(sql, ...params)`: mirror `ctx.storage.sql.exec()` interface
  - `sync()`: no-op (WAL auto-sync)
  - Mỗi room 1 DB file: `data/rooms/{roomId}.db`, mở lazy, giữ handle trong Map
  - `close()`: đóng handle (gọi khi RoomManager evict)
- `blob-store.ts`: filesystem implementation
  - `get(key) → ArrayBuffer | null`
  - `put(key, body, opts) → void`
  - `head(key) → boolean`
  - `delete(key) → void`
  - Path: `data/blobs/{key}` (key đã có prefix `att/{userId}/{sha256}`)
  - Atomic write: write to tmp file + rename
- `kv-store.ts`: filesystem JSON
  - `get(key) → string | null`
  - `put(key, value) → void`
  - Atomic write (tmp + rename)
  - Dùng cho push tokens (`push:{userId}` → Expo token)

### Phase 3: Port session-room.ts (6 giờ, phần khó nhất)
- Đổi `class SessionRoom implements DurableObject` → `class SessionRoom`
- Constructor mới:
  ```ts
  constructor(
    roomId: string,
    db: SqliteStore,           // đã mở DB file cho room này
    blobs: BlobStore,
    env: Env
  )
  ```
- Substitutions (search & replace):

  | DO API | Bun equivalent |
  |---|---|
  | `ctx.storage.sql.exec(sql, ...params)` | `db.exec(sql, ...params)` (interface giữ nguyên) |
  | `ctx.storage.sync()` | no-op (WAL) |
  | `ctx.acceptWebSocket(ws)` | `ws` object từ Bun handler trực tiếp |
  | `ctx.getWebSockets(tag?)` | internal `Set<WebSocket>` + tag map |
  | `ctx.setWebSocketAutoResponse("ping", "pong")` | handle `"ping"` string trong `webSocketMessage`, reply `ws.send("pong")` |
  | `ctx.storage.setAlarm(ts)` | `setTimeout(() => this.alarm(), ts - Date.now())`, track bằng `alarmTimer` |
  | `ctx.storage.getAlarm()` | check `alarmTimer !== undefined` |
  | `ws.serializeAttachment(state)` | `WeakMap<WebSocket, SocketState>` |
  | `ws.deserializeAttachment()` | `WeakMap.get(ws)` |
  | `ctx.getWebSocketAutoResponseTimestamp(ws)` | `WeakMap<ws, lastPongAt>`, stamp khi nhận pong |

- **Giữ nguyên 100% logic**:
  - Protocol handler (JoinRequest, DocUpdate, Fragment, Ack, Leave)
  - LOG FOLD compaction (8MB threshold)
  - HISTORY TRIM (daily alarm, RETAIN_DAYS=30)
  - Fragment reassembly (`FragmentBatch`, header/parts reassembly)
  - Command ledger rules (append-only, host-only outcomes)
  - Wedge detection (`replayAttempts`, `REPLAY_CRASH_LIMIT=3`, auto-reset-log)
  - Tail materialization (`materializeTail`, lazy recompute khi dirty)
  - Backup monotonic VV gate (R2 → filesystem blob)
  - Schema version guard (`SCHEMA_VERSION`, defensive-only vì constructor chạy 1 lần)
  - Meta caching pattern (`metaCache`, `metaDirty`, `metaDirtyKeys`, `flushMeta`)
  - Pending updates batching (`combinePendingUpdates`, `splitCombinedUpdates`)
  - `recordLoroUpdates` write-efficiency pattern

- HTTP endpoints (port từ `session-room.ts fetch handler`): `/ws`, `/stats`, `/tail`, `/diff` GET/POST, `/snapshot`, `/append`, `/reset-log`

### Phase 4: Port device-room.ts (2 giờ)
- Đổi `class DeviceRoom implements DurableObject` → `class DeviceRoom`
- Cùng substitutions như Phase 3
- **Giữ nguyên 100%**:
  - Frame encoding (`encodeDeviceFrame`, `decodeDeviceFrame`, uleb128 header)
  - Relay logic (client→host stamp `from`, host→client route by `to`)
  - Host liveness window (`HOST_LIVENESS_MS=75_000`)
  - `liveHost(exclude?)` selection logic
  - Nudge queue (`pending_nudges` table, `NUDGE_MAX_PENDING=256`, overflow drop oldest)
  - `pickLiveHost` pure function (testable)
  - Sidecar slots (`/sidecar/:name` GET/POST)
  - `replayNudges` on host join
  - WebSocket close/error handlers (host_closed, client_closed, client_gone)

### Phase 5: Port routes (3 giờ)
- `routes/session.ts`: port từ `edge/src/index.ts`
  - `/session/:chatId/ws` (WS upgrade)
  - `/tail/:chatId`, `/diff/:chatId` GET/POST, `/snapshot/:chatId`, `/append/:chatId`, `/stats/:chatId`
  - Room namespace `s2/{chatId}` (giữ nguyên identity break prefix)
- `routes/workspace.ts`:
  - `/workspace/:orgId/ws` (WS upgrade, org-membership check)
  - `/workspace/:orgId/tail`, `/stats`, `/reset-log`
  - Room namespace `ws3/{orgId}/{userId}` (giữ nguyên privacy break prefix)
  - Stamp `ROOM_KIND_HEADER=workspace` khi forward internal
- `routes/device.ts`:
  - `/device/:deviceId/ws?role=host|client`
  - `/device/:deviceId/sidecar/:name` GET/POST
  - `/device/:deviceId/status`, `/nudge`
  - Room namespace `d2/{deviceId}`
- `routes/attachments.ts`:
  - `/attachments/:sha256` PUT/GET/HEAD
  - SHA-256 verify server-side (giữ nguyên `crypto.subtle.digest`)
  - Max 32MB, key `att/{userId}/{sha256}`
- `routes/account-settings.ts`: port từ `edge/src/account-settings.ts`
- `routes/push.ts`: `/push/register`, `/push/send` (giữ nguyên Expo API)
- `routes/releases.ts`: `/releases/*` static serving từ filesystem
- `routes/install-sh.ts`: serve `install.sh`

**Forwarding thay đổi**:
- `env.SESSION_ROOMS.get(idFromName(name)).fetch(req)` → `roomManager.getOrCreate(name).handleRequest(req)`
- Hono router thay Worker `fetch` switch

### Phase 6: Auth (2 giờ)
- `authenticate.ts`: port từ `edge/src/auth.ts`
  - `jose` thay Web Crypto API (`jwtVerify`, `createRemoteJWKSet`)
  - `AUTH_MODE=dev`: bearer == userId (giữ nguyên)
  - `AUTH_MODE=workos`: verify JWT, extract `sub` (userId), `org_id` (orgId)
  - Trả `{ userId, orgId }` (giữ contract)
- `auth-routes.ts`: port từ `edge/src/auth-routes.ts`
  - `/auth/exchange`: WorkOS code → tokens (gọi WorkOS API bằng `fetch`)
  - `/auth/refresh`: refresh token → fresh tokens
  - `/auth/orgs`: list/create org memberships
  - `/auth/cli/callback`: paste-code page (headless sign-in)
- Stamp `AUTH_USER_HEADER` + `ROOM_KIND_HEADER` trong internal forward (giữ nguyên header names)

### Phase 7: Room manager + lifecycle (2 giờ)
- `RoomManager`:
  ```ts
  class RoomManager {
    private rooms = new Map<string, SessionRoom | DeviceRoom>();
    private lastAccess = new Map<string, number>();
    private readonly maxCached = 100;

    getOrCreate(
      roomId: string,
      kind: "session" | "device"
    ): SessionRoom | DeviceRoom {
      // 1. Lookup trong Map
      // 2. Cache miss: mở SQLite file, instantiate Room
      // 3. Update lastAccess
      // 4. Evict nếu vượt maxCached: flush() + close() DB handle
    }

    // Periodic cleanup (setInterval mỗi 5 phút):
    // - Evict rooms idle > 1 giờ (flush + close DB)
  }
  ```
- DO single-instance-per-ID guarantee → RoomManager đảm bảo bằng Map (một roomId luôn map về cùng instance)
- Evict policy: LRU khi vượt 100 rooms cached. Data persist trong SQLite file nên reopen không mất gì.
- Trên process shutdown: `SIGTERM` handler flush tất cả rooms rồi exit gracefully.

### Phase 8: Deploy + test (3 giờ)
- Build image:
  ```bash
  docker build -t comet-server ./apps/server
  ```
- Run local test:
  ```bash
  docker compose up
  ```
- Test endpoints thủ công:
  ```bash
  curl http://localhost:3000/health
  # AUTH_MODE=dev: test WS với bearer==userId
  ```
- Test e2e với Rust client:
  - Trỏ `EDGE_URL` env sang `ws://localhost:3000`
  - Chạy `scripts/e2e-smoke.sh` (đã có cho M4): 2 Rust peers converge qua server mới
- Test với mobile app:
  - Đổi `AppConfig.EDGE_URL` thành server mới
  - Verify kết nối WS + sync doc
- Deploy production:
  ```bash
  # Trên VPS
  git clone <repo>
  cd comet/apps/server
  cp .env.example .env  # fill WORKOS_*, SETTINGS_ENCRYPTION_KEY
  docker compose up -d
  ```
- Backup: cron job trên host
  ```bash
  0 3 * * * docker exec comet-server bun -e "
    const fs = require('fs');
    const dir = '/app/data/rooms';
    for (const f of fs.readdirSync(dir)) {
      // SQLite online backup via .backup command
    }
  " && rsync -av /var/comet/data/ backup@storage:/backup/
  ```

## API contract (giữ 100% để client không đổi)

Routes mới **giống hệt** `edge/src/index.ts`:

```
GET  /health
POST /auth/exchange               — WorkOS code → tokens
POST /auth/refresh                — WorkOS refresh → fresh tokens
GET  /auth/orgs                   — active org memberships
POST /auth/orgs                   — create org + admin membership
GET  /auth/cli/callback           — paste-code page (headless)

GET  /session/:chatId/ws          — loro-protocol room (ws upgrade)
GET  /tail/:chatId                — L2 instant-open tail JSON
GET  /diff/:chatId                — latest working-tree diff
POST /diff/:chatId                — host publishes diff sidecar
GET  /snapshot/:chatId            — repair: full snapshot bytes
POST /append/:chatId              — repair: merge-import update
GET  /stats/:chatId               — observability

GET  /workspace/:orgId/ws         — workspace-doc room (ws upgrade)
GET  /workspace/:orgId/tail
GET  /workspace/:orgId/stats
POST /workspace/:orgId/reset-log  — operator wedge-break

GET  /device/:deviceId/ws?role=   — device-room byte pipe
GET  /device/:deviceId/sidecar/:name
POST /device/:deviceId/sidecar/:name
GET  /device/:deviceId/status
POST /device/:deviceId/nudge

PUT  /attachments/:sha256         — content-addressed upload (SHA-256 verified)
GET  /attachments/:sha256
HEAD /attachments/:sha256

GET  /account-settings
PUT  /account-settings

POST /push/register               — mobile app registers Expo token
POST /push/send                   — engine triggers push (shared secret)

GET  /install.sh                  — curl-install
GET  /releases/*                  — release artifacts
```

### Clients cần đổi
- **Rust engine** (`crates/engine`): biến `EDGE_URL` env (đã có sẵn)
- **Mobile app** (`apps/mobile-app/src/app/AppConfig.ts`): `EDGE_URL` (1 dòng)

## Những gì giữ nguyên 100% (không đụng)

- `loro-protocol` binary codec (dùng npm package)
- Session-doc schema (định nghĩa ở Rust `crates/doc/`, server chỉ là dumb relay)
- Workspace-doc schema (per-user privacy: `ws3/{orgId}/{userId}`)
- Command ledger rules (Rust engine enforce, server chỉ persist)
- Compaction rules (logic port nguyên sang Bun)
- Loro CRDT conflict resolution (library)
- Device frame encoding (`{s, k, to?, from?}`)
- Room identity prefixes (`s2/`, `ws3/`, `d2/`)
- Auth header names (`x-comet-auth-user`, `x-comet-room-kind`)

## DO API → Bun API mapping (cheat sheet)

| Durable Object API | Bun equivalent |
|---|---|
| `class X implements DurableObject` | `class X` (plain) |
| `ctx.storage.sql.exec(sql, params)` | `db.exec(sql, params)` (bun:sqlite) |
| `ctx.storage.sync()` | no-op (WAL mode) |
| `ctx.storage.setAlarm(ts)` | `setTimeout(() => alarm(), ts - Date.now())` |
| `ctx.storage.getAlarm()` | check `alarmTimer` |
| `ctx.acceptWebSocket(ws)` | direct `ws` object |
| `ctx.getWebSockets(tag?)` | `Set<WebSocket>` + tag maps |
| `ctx.setWebSocketAutoResponse(pair)` | handle string `"ping"` trong message handler |
| `ctx.getWebSocketAutoResponseTimestamp(ws)` | `WeakMap<ws, lastPongAt>` |
| `ws.serializeAttachment(obj)` | `WeakMap<ws, obj>.set(ws, obj)` |
| `ws.deserializeAttachment()` | `WeakMap.get(ws)` |
| `env.SESSION_ROOMS.get(id).fetch(req)` | `roomManager.getOrCreate(id).handleRequest(req)` |
| `env.BLOBS.put(key, body)` | `blobStore.put(key, body)` (filesystem) |
| `env.KV.put(key, val)` | `kvStore.put(key, val)` (filesystem JSON) |
| DO instance per ID (auto-routing) | `RoomManager` Map + lazy load |
| DO hibernation | không cần (process sống liên tục, WS persistent) |
| DO CPU limit / wedge | không có (process unlimited CPU) |

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Single-region latency | Chọn Singapore VPS; RTT từ VN ~40ms |
| Process crash | Docker `restart: unless-stopped` + SQLite WAL |
| Room DB file growth | Compaction logic giữ nguyên (8MB fold, daily trim) |
| Memory khi nhiều rooms | LRU evict 100 rooms; DB handle reopen rẻ |
| WS connection limit | Bun handle ~10K concurrent WS; vertical scale đủ |
| Backup | Cron daily SQLite `.backup` + rsync sang object storage |
| Volume data loss | Docker volume mount `./data:/app/data`, backup ra ngoài host |

## Ước tính effort

| Phase | Giờ |
|---|---|
| 1. Scaffolding + env | 2 |
| 2. Storage layer | 3 |
| 3. Port session-room.ts | 6 |
| 4. Port device-room.ts | 2 |
| 5. Port routes | 3 |
| 6. Auth | 2 |
| 7. Room manager | 2 |
| 8. Deploy + test | 3 |
| Debug buffer | 4 |
| **Tổng** | **~27 giờ (3.5 ngày)** |

## Chi phí vận hành

- VPS Vultr Singapore (1 vCPU, 1GB RAM, 25GB SSD): **$6/mo**
- Hoặc Hetzner CX22 (2 vCPU, 4GB RAM, 40GB NVMe, EU): **$4.5/mo**
- Domain + TLS: free (Caddy + Let's Encrypt, hoặc Cloudflare proxy)
- Backup storage: rsync sang Cloudflare R2 ($0.015/GB, free egress)
- **Tổng: ~$5-7/mo, không giới hạn rows_written**

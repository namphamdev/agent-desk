/**
 * Comet self-hosted edge server entry point.
 *
 * Bun.serve with a Hono router for HTTP, native WebSocket handler for WS
 * upgrades. Replaces the Cloudflare Worker + Durable Objects architecture
 * with a single-process server using bun:sqlite for room persistence and the
 * filesystem for blobs/KV.
 *
 * The API contract is 100% identical to the Worker — clients (Rust engine,
 * mobile app) only change their EDGE_URL.
 */
import { Hono } from "hono";
import { loadEnv } from "./env";

/** Hono context variables for authenticated routes. */
interface AppVariables {
  userId: string;
  orgId: string | undefined;
}
import { RoomManager } from "./rooms/room-manager";
import { SessionRoom } from "./rooms/session-room";
import { DeviceRoom } from "./rooms/device-room";
import { authenticate } from "./auth/authenticate";
import { mountAuthRoutes } from "./auth/auth-routes";
import { handleAccountSettings } from "./routes/account-settings";
import { handlePushRegister, handlePushSend } from "./routes/push";
import { serveInstallSh, serveRelease, setInstallSh } from "./routes/releases";
import { createFilesystemBlobStore } from "./storage/blob-store";
import { createFilesystemKvStore } from "./storage/kv-store";
import type { WsUpgradeData } from "./rooms/ws-upgrade-data";
import installShRaw from "./install.sh";

// ── Initialization ───────────────────────────────────────────────────────────
const env = loadEnv();
const app = new Hono<{ Variables: AppVariables }>();
const roomManager = new RoomManager(env);
const kvStore = createFilesystemKvStore(env.DATA_DIR);

setInstallSh(installShRaw);

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

// ── Public routes (no auth) ──────────────────────────────────────────────────
app.get("/health", (c) =>
  c.json({ ok: true, auth: env.AUTH_MODE === "dev" ? "dev" : "workos" })
);

app.get("/install.sh", (c) => serveInstallSh(c.req.method));
app.on("HEAD", "/install.sh", (c) => serveInstallSh(c.req.method));

app.get("/releases/*", (c) => {
  const key = decodeURIComponent(new URL(c.req.url).pathname.slice("/releases/".length));
  return serveRelease(c.req.method, key, env);
});
app.on("HEAD", "/releases/*", (c) => {
  const key = decodeURIComponent(new URL(c.req.url).pathname.slice("/releases/".length));
  return serveRelease(c.req.method, key, env);
});

mountAuthRoutes(app as unknown as Hono, env);

// ── Push routes ──────────────────────────────────────────────────────────────
app.post("/push/register", async (c) => {
  const auth = await authenticate(env, c.req.raw.headers, new URL(c.req.url));
  if (!auth) return c.json({ error: "unauthenticated" }, 401);
  return handlePushRegister(c.req.method, await c.req.raw.arrayBuffer(), kvStore, auth.userId);
});

app.post("/push/send", async (c) => {
  return handlePushSend(
    c.req.method,
    c.req.raw.headers,
    await c.req.raw.arrayBuffer(),
    env,
    kvStore
  );
});

// ── Auth middleware for all remaining routes ─────────────────────────────────
app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  // Skip already-handled public routes.
  if (
    path === "/health" ||
    path === "/install.sh" ||
    path.startsWith("/releases/") ||
    path.startsWith("/auth/") ||
    (path === "/push/register" && c.req.method === "POST") ||
    (path === "/push/send" && c.req.method === "POST")
  ) {
    return next();
  }
  const auth = await authenticate(env, c.req.raw.headers, new URL(c.req.url));
  if (!auth) return c.json({ error: "unauthenticated" }, 401);
  c.set("userId", auth.userId);
  c.set("orgId", auth.orgId);
  await next();
});

// ── Session room HTTP routes ─────────────────────────────────────────────────
app.get("/tail/:chatId", async (c) => {
  const chatId = c.req.param("chatId");
  if (!ID_RE.test(chatId)) return c.json({ error: "not_found" }, 404);
  const userId = c.get("userId") as string;
  const room = roomManager.getSession(`s2/${chatId}`);
  return room.handleRequest("GET", "/tail", c.req.raw, userId, false);
});

app.get("/stats/:chatId", async (c) => {
  const chatId = c.req.param("chatId");
  if (!ID_RE.test(chatId)) return c.json({ error: "not_found" }, 404);
  const userId = c.get("userId") as string;
  const room = roomManager.getSession(`s2/${chatId}`);
  return room.handleRequest("GET", "/stats", c.req.raw, userId, false);
});

app.get("/diff/:chatId", async (c) => {
  const chatId = c.req.param("chatId");
  if (!ID_RE.test(chatId)) return c.json({ error: "not_found" }, 404);
  const userId = c.get("userId") as string;
  const room = roomManager.getSession(`s2/${chatId}`);
  return room.handleRequest("GET", "/diff", c.req.raw, userId, false);
});

app.post("/diff/:chatId", async (c) => {
  const chatId = c.req.param("chatId");
  if (!ID_RE.test(chatId)) return c.json({ error: "not_found" }, 404);
  const userId = c.get("userId") as string;
  const room = roomManager.getSession(`s2/${chatId}`);
  return room.handleRequest("POST", "/diff", c.req.raw, userId, false);
});

app.get("/snapshot/:chatId", async (c) => {
  const chatId = c.req.param("chatId");
  if (!ID_RE.test(chatId)) return c.json({ error: "not_found" }, 404);
  const userId = c.get("userId") as string;
  const room = roomManager.getSession(`s2/${chatId}`);
  return room.handleRequest("GET", "/snapshot", c.req.raw, userId, false);
});

app.post("/append/:chatId", async (c) => {
  const chatId = c.req.param("chatId");
  if (!ID_RE.test(chatId)) return c.json({ error: "not_found" }, 404);
  const userId = c.get("userId") as string;
  const room = roomManager.getSession(`s2/${chatId}`);
  return room.handleRequest("POST", "/append", c.req.raw, userId, false);
});

// ── Workspace room HTTP routes ───────────────────────────────────────────────
app.get("/workspace/:orgId/tail", async (c) => {
  const orgId = c.req.param("orgId");
  if (!ID_RE.test(orgId)) return c.json({ error: "not_found" }, 404);
  const userId = c.get("userId") as string;
  const callerOrg = c.get("orgId") as string | undefined;
  if (callerOrg !== orgId) return c.json({ error: "forbidden" }, 403);
  const room = roomManager.getWorkspace(`ws3/${orgId}/${userId}`);
  return room.handleRequest("GET", "/tail", c.req.raw, userId, true);
});

app.get("/workspace/:orgId/stats", async (c) => {
  const orgId = c.req.param("orgId");
  if (!ID_RE.test(orgId)) return c.json({ error: "not_found" }, 404);
  const userId = c.get("userId") as string;
  const callerOrg = c.get("orgId") as string | undefined;
  if (callerOrg !== orgId) return c.json({ error: "forbidden" }, 403);
  const room = roomManager.getWorkspace(`ws3/${orgId}/${userId}`);
  return room.handleRequest("GET", "/stats", c.req.raw, userId, true);
});

app.post("/workspace/:orgId/reset-log", async (c) => {
  const orgId = c.req.param("orgId");
  if (!ID_RE.test(orgId)) return c.json({ error: "not_found" }, 404);
  const userId = c.get("userId") as string;
  const callerOrg = c.get("orgId") as string | undefined;
  if (callerOrg !== orgId) return c.json({ error: "forbidden" }, 403);
  const room = roomManager.getWorkspace(`ws3/${orgId}/${userId}`);
  return room.handleRequest("POST", "/reset-log", c.req.raw, userId, true);
});

// ── Device room HTTP routes ──────────────────────────────────────────────────
app.get("/device/:deviceId/status", async (c) => {
  const deviceId = c.req.param("deviceId");
  if (!ID_RE.test(deviceId)) return c.json({ error: "not_found" }, 404);
  const userId = c.get("userId") as string;
  const room = roomManager.getDevice(`d2/${deviceId}`);
  return room.handleRequest("GET", "/status", c.req.raw, userId);
});

app.post("/device/:deviceId/nudge", async (c) => {
  const deviceId = c.req.param("deviceId");
  if (!ID_RE.test(deviceId)) return c.json({ error: "not_found" }, 404);
  const userId = c.get("userId") as string;
  const room = roomManager.getDevice(`d2/${deviceId}`);
  return room.handleRequest("POST", "/nudge", c.req.raw, userId);
});

app.get("/device/:deviceId/sidecar/:name", async (c) => {
  const deviceId = c.req.param("deviceId");
  if (!ID_RE.test(deviceId)) return c.json({ error: "not_found" }, 404);
  const userId = c.get("userId") as string;
  const room = roomManager.getDevice(`d2/${deviceId}`);
  return room.handleRequest("GET", `/sidecar/${c.req.param("name")}`, c.req.raw, userId);
});

app.post("/device/:deviceId/sidecar/:name", async (c) => {
  const deviceId = c.req.param("deviceId");
  if (!ID_RE.test(deviceId)) return c.json({ error: "not_found" }, 404);
  const userId = c.get("userId") as string;
  const room = roomManager.getDevice(`d2/${deviceId}`);
  return room.handleRequest("POST", `/sidecar/${c.req.param("name")}`, c.req.raw, userId);
});

// ── Attachments ──────────────────────────────────────────────────────────────
app.put("/attachments/:sha256", async (c) => {
  const sha256 = c.req.param("sha256");
  if (!SHA256_RE.test(sha256)) return c.json({ error: "not_found" }, 404);
  const userId = c.get("userId") as string;
  const body = await c.req.raw.arrayBuffer();
  if (body.byteLength > MAX_ATTACHMENT_BYTES) return c.json({ error: "too_large" }, 413);
  const digest = await crypto.subtle.digest("SHA-256", body);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (hex !== sha256) return c.json({ error: "hash_mismatch" }, 400);
  const store = createFilesystemBlobStore(`${env.DATA_DIR}/blobs`);
  store.put(`att/${userId}/${sha256}`, new Uint8Array(body));
  return c.json({ ok: true, hash: hex, bytes: body.byteLength });
});

app.get("/attachments/:sha256", async (c) => {
  const sha256 = c.req.param("sha256");
  if (!SHA256_RE.test(sha256)) return c.json({ error: "not_found" }, 404);
  const userId = c.get("userId") as string;
  const store = createFilesystemBlobStore(`${env.DATA_DIR}/blobs`);
  const bytes = store.get(`att/${userId}/${sha256}`);
  if (!bytes) return c.json({ error: "not_found" }, 404);
  return new Response(bytes, {
    headers: { "cache-control": "private, max-age=31536000, immutable" }
  });
});

app.on("HEAD", "/attachments/:sha256", (c) => {
  const sha256 = c.req.param("sha256");
  if (!SHA256_RE.test(sha256)) return c.json({ error: "not_found" }, 404);
  const userId = c.get("userId") as string;
  const store = createFilesystemBlobStore(`${env.DATA_DIR}/blobs`);
  if (!store.head(`att/${userId}/${sha256}`)) return c.json({ error: "not_found" }, 404);
  return new Response(null, {
    headers: { "cache-control": "private, max-age=31536000, immutable" }
  });
});

// ── Account settings ─────────────────────────────────────────────────────────
app.get("/account-settings", async (c) => {
  const userId = c.get("userId") as string;
  return handleAccountSettings(
    "GET",
    c.req.raw.headers,
    await c.req.raw.arrayBuffer().catch(() => null),
    env,
    userId
  );
});

app.put("/account-settings", async (c) => {
  const userId = c.get("userId") as string;
  return handleAccountSettings(
    "PUT",
    c.req.raw.headers,
    await c.req.raw.arrayBuffer(),
    env,
    userId
  );
});

app.all("*", (c) => c.json({ error: "not_found" }, 404));

// ── Bun.serve with WebSocket ─────────────────────────────────────────────────
const server = Bun.serve<WsUpgradeData>({
  port: env.PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // ── WebSocket upgrades ──────────────────────────────────────────────────
    if (
      parts.length >= 3 &&
      parts[0] === "session" &&
      ID_RE.test(parts[1]) &&
      parts[2] === "ws"
    ) {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response(JSON.stringify({ error: "expected websocket" }), {
          status: 426,
          headers: { "content-type": "application/json" }
        });
      }
      const auth = await authenticate(env, req.headers, url);
      if (!auth) {
        return new Response(JSON.stringify({ error: "unauthenticated" }), {
          status: 401,
          headers: { "content-type": "application/json" }
        });
      }
      const data: WsUpgradeData = {
        roomId: `s2/${parts[1]}`,
        roomKind: "session",
        userId: auth.userId
      };
      if (srv.upgrade(req, { data })) return;
      return new Response("Upgrade failed", { status: 500 });
    }

    if (
      parts.length >= 3 &&
      parts[0] === "workspace" &&
      ID_RE.test(parts[1]) &&
      parts[2] === "ws"
    ) {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response(JSON.stringify({ error: "expected websocket" }), {
          status: 426,
          headers: { "content-type": "application/json" }
        });
      }
      const auth = await authenticate(env, req.headers, url);
      if (!auth) {
        return new Response(JSON.stringify({ error: "unauthenticated" }), {
          status: 401,
          headers: { "content-type": "application/json" }
        });
      }
      if (auth.orgId !== parts[1]) {
        return new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" }
        });
      }
      const data: WsUpgradeData = {
        roomId: `ws3/${parts[1]}/${auth.userId}`,
        roomKind: "session-workspace",
        userId: auth.userId
      };
      if (srv.upgrade(req, { data })) return;
      return new Response("Upgrade failed", { status: 500 });
    }

    if (
      parts.length >= 3 &&
      parts[0] === "device" &&
      ID_RE.test(parts[1]) &&
      parts[2] === "ws"
    ) {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response(JSON.stringify({ error: "expected websocket" }), {
          status: 426,
          headers: { "content-type": "application/json" }
        });
      }
      const auth = await authenticate(env, req.headers, url);
      if (!auth) {
        return new Response(JSON.stringify({ error: "unauthenticated" }), {
          status: 401,
          headers: { "content-type": "application/json" }
        });
      }
      const role = url.searchParams.get("role") === "host" ? "host" : "client";
      const connId = url.searchParams.get("connId") ?? crypto.randomUUID();
      const data: WsUpgradeData = {
        roomId: `d2/${parts[1]}`,
        roomKind: "device",
        userId: auth.userId,
        role,
        connId
      };
      if (srv.upgrade(req, { data })) return;
      return new Response("Upgrade failed", { status: 500 });
    }

    // ── Regular HTTP ────────────────────────────────────────────────────────
    return app.fetch(req);
  },

  websocket: {
    open(ws) {
      const { roomId, roomKind, userId, role, connId } = ws.data;
      if (roomKind === "device") {
        const room = roomManager.getDevice(roomId) as DeviceRoom;
        const err = room.attachSocket(
          ws as unknown as WebSocket,
          userId,
          (role ?? "client") as "host" | "client",
          connId ?? crypto.randomUUID()
        );
        if (err) {
          ws.close(1008, "forbidden");
        }
      } else {
        const room =
          roomKind === "session-workspace"
            ? (roomManager.getWorkspace(roomId) as SessionRoom)
            : (roomManager.getSession(roomId) as SessionRoom);
        room.attachSocket(ws as unknown as WebSocket, userId);
      }
    },

    async message(ws, message) {
      const { roomId, roomKind } = ws.data;
      // Convert Bun message format to what rooms expect.
      let msg: ArrayBuffer | string;
      if (typeof message === "string") {
        msg = message;
      } else {
        // Buffer — convert to ArrayBuffer.
        msg = message.buffer.slice(
          message.byteOffset,
          message.byteOffset + message.byteLength
        ) as ArrayBuffer;
      }

      if (roomKind === "device") {
        const room = roomManager.getDevice(roomId) as DeviceRoom;
        room.onMessage(ws as unknown as WebSocket, msg);
      } else {
        const room =
          roomKind === "session-workspace"
            ? (roomManager.getWorkspace(roomId) as SessionRoom)
            : (roomManager.getSession(roomId) as SessionRoom);
        await room.onMessage(ws as unknown as WebSocket, msg);
      }
    },

    close(ws) {
      const { roomId, roomKind } = ws.data;
      if (roomKind === "device") {
        const room = roomManager.getDevice(roomId) as DeviceRoom;
        room.onClose(ws as unknown as WebSocket);
      } else {
        const room =
          roomKind === "session-workspace"
            ? (roomManager.getWorkspace(roomId) as SessionRoom)
            : (roomManager.getSession(roomId) as SessionRoom);
        void room.onClose(ws as unknown as WebSocket);
      }
    }
  }
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
const shutdown = async (signal: string) => {
  console.log(`[server] ${signal} received, shutting down...`);
  await roomManager.shutdown();
  server.stop();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log(`[server] Comet edge server listening on http://localhost:${env.PORT}`);

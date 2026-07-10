/**
 * Local LAN remote-access server: phone/browser clients mirror the desktop UI.
 * Auth is a random code in the URL path (`/r/<code>`). Real-time updates go over
 * WebSocket; actions reuse SessionManager via injected handlers.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join, normalize, extname, dirname } from "node:path";
import type {
  AgentInfo,
  AppSettings,
  AvailableCommand,
  ConnectionStatePayload,
  PermissionRequest,
  RecentProject,
  SessionConfigOption,
  SessionListPayload,
  SessionLoadedPayload,
  SessionSummary,
  SessionUsage,
  SkillInfo,
  TurnEndPayload,
} from "../shared/rpc";
import type { SessionUpdate } from "../session/types";

export type RemoteAccessStatus = {
  running: boolean;
  code: string | null;
  port: number | null;
  /** Preferred LAN URL (first non-internal IPv4). */
  url: string | null;
  /** All candidate URLs (every non-internal IPv4). */
  urls: string[];
  lanIps: string[];
};

export type RemoteAccessHandlers = {
  sendPrompt: (
    text: string,
    sessionId?: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  cancel: (sessionId?: string) => Promise<{ ok: boolean }>;
  listAgents: () => { agents: AgentInfo[] };
  listSessions: () => SessionListPayload;
  createSession: (params: {
    title?: string;
    project?: string;
    cwd?: string;
    agentId?: string;
    seedContext?: {
      text: string;
      role?: "user" | "agent" | "thought";
      purpose?: "continue" | "review";
    };
  }) => Promise<
    | { ok: true; session: SessionSummary }
    | { ok: false; error: string }
  >;
  switchSession: (
    sessionId: string,
  ) => Promise<
    { ok: true; session: SessionSummary } | { ok: false; error: string }
  >;
  deleteSession: (sessionId: string) => Promise<{ ok: boolean }>;
  offloadSession: (
    sessionId: string,
  ) => Promise<
    { ok: true; killed: boolean } | { ok: false; error: string }
  >;
  respondPermission: (
    requestId: string,
    optionId: string,
  ) => Promise<{ ok: boolean }>;
  openFile: (
    path: string,
    line?: number,
  ) => Promise<{ ok: boolean; error?: string }>;
  getSettings: () => AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => AppSettings;
  getConnectionState: () => ConnectionStatePayload;
  connectAgent: (
    agentId?: string,
    cwd?: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  listRecentProjects: () => { projects: RecentProject[] };
  removeRecentProject: (
    cwd: string,
  ) => { ok: true; projects: RecentProject[] };
  getGitBranch: (cwd: string) => Promise<{ branch: string | null }>;
  setConfigOption: (
    configId: string,
    value: string | boolean,
    sessionId?: string,
  ) => Promise<
    | { ok: true; configOptions: SessionConfigOption[] }
    | { ok: false; error: string }
  >;
  writeClipboard: (
    text: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  readClipboard: () => Promise<
    { ok: true; text: string } | { ok: false; error: string }
  >;
  listSkills: (projectCwd?: string | null) => { skills: SkillInfo[] };
  installSkill: (
    packageSpec: string,
  ) => Promise<
    { ok: true; skills: SkillInfo[] } | { ok: false; error: string }
  >;
  setSkillEnabled: (
    skillId: string,
    enabled: boolean,
  ) =>
    | { ok: true; skill: SkillInfo; skills: SkillInfo[] }
    | { ok: false; error: string };
  uninstallSkill: (
    skillId: string,
  ) => { ok: true; skills: SkillInfo[] } | { ok: false; error: string };
};

type WsClient = {
  send: (data: string) => void;
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/** Default port; 0 = pick a free port (Bun assigns). */
const DEFAULT_PORT = Number(process.env.TERMINAL_REACT_REMOTE_PORT || 8743);

export function generateAccessCode(bytes = 6): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

export function listLanIpv4(): string[] {
  const nets = networkInterfaces();
  const ips: string[] = [];
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const e of entries) {
      if (e.family === "IPv4" && !e.internal) ips.push(e.address);
    }
  }
  // Prefer common private ranges first.
  ips.sort((a, b) => scoreLan(b) - scoreLan(a));
  return ips;
}

function scoreLan(ip: string): number {
  if (ip.startsWith("192.168.")) return 3;
  if (ip.startsWith("10.")) return 2;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 1;
  return 0;
}

export function buildRemoteUrls(
  port: number,
  code: string,
  ips = listLanIpv4(),
): { url: string | null; urls: string[]; lanIps: string[] } {
  const urls = ips.map((ip) => `http://${ip}:${port}/r/${code}`);
  // Always include localhost for same-machine browsers.
  const local = `http://127.0.0.1:${port}/r/${code}`;
  if (!urls.includes(local)) urls.push(local);
  return {
    url: urls[0] ?? local,
    urls,
    lanIps: ips.length ? ips : ["127.0.0.1"],
  };
}

/** Candidate directories that may hold the built SPA (index.html + assets/). */
export function resolveStaticRoots(): string[] {
  const roots: string[] = [];
  const cwd = process.cwd();
  roots.push(join(cwd, "dist"));
  roots.push(join(cwd, "views", "mainview"));
  // Electrobun app bundle (dev/prod): .../Resources/app/views/mainview
  try {
    const execDir = dirname(process.execPath);
    roots.push(join(execDir, "..", "Resources", "app", "views", "mainview"));
    roots.push(join(execDir, "Resources", "app", "views", "mainview"));
  } catch {
    /* ignore */
  }
  if (process.env.TERMINAL_REACT_WEBROOT) {
    roots.unshift(process.env.TERMINAL_REACT_WEBROOT);
  }
  // Unique existing dirs that contain index.html
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of roots) {
    const n = normalize(r);
    if (seen.has(n)) continue;
    seen.add(n);
    if (existsSync(join(n, "index.html"))) out.push(n);
  }
  return out;
}

function safeJoin(root: string, rel: string): string | null {
  const cleaned = rel.replace(/^\/+/, "").replace(/\0/g, "");
  const full = normalize(join(root, cleaned));
  if (!full.startsWith(normalize(root))) return null;
  return full;
}

function rewriteIndexHtml(html: string, accessCode: string): string {
  // Force absolute asset paths so /r/<code> does not resolve ./assets relative
  // to the path segment. Inject the access code for the webview RPC client.
  let out = html
    .replace(/(src|href)="\.\/assets\//g, '$1="/assets/')
    .replace(/(src|href)="assets\//g, '$1="/assets/');
  const inject = `<style>html,body{background:#1a1a1a!important}</style>
<script>window.__TERMINAL_REACT_REMOTE__=${JSON.stringify({
    code: accessCode,
  })};</script>`;
  if (out.includes("</head>")) {
    out = out.replace("</head>", `${inject}</head>`);
  } else {
    out = inject + out;
  }
  // Drop desktop-only chrome transparency classes if present.
  out = out.replace(/bg-transparent/g, "bg-[#1a1a1a]");
  return out;
}

export class RemoteAccessServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private code: string | null = null;
  private port: number | null = null;
  private clients = new Set<WsClient>();
  private handlers: RemoteAccessHandlers;

  constructor(handlers: RemoteAccessHandlers) {
    this.handlers = handlers;
  }

  getStatus(): RemoteAccessStatus {
    if (!this.server || !this.code || this.port == null) {
      return {
        running: false,
        code: null,
        port: null,
        url: null,
        urls: [],
        lanIps: listLanIpv4(),
      };
    }
    const built = buildRemoteUrls(this.port, this.code);
    return {
      running: true,
      code: this.code,
      port: this.port,
      url: built.url,
      urls: built.urls,
      lanIps: built.lanIps,
    };
  }

  async start(opts?: { port?: number; code?: string }): Promise<RemoteAccessStatus> {
    if (this.server) return this.getStatus();

    const code = opts?.code ?? generateAccessCode();
    const preferredPort = opts?.port ?? DEFAULT_PORT;
    this.code = code;

    const self = this;
    try {
      this.server = Bun.serve({
        hostname: "0.0.0.0",
        port: preferredPort,
        fetch(req, server) {
          return self.handleFetch(req, server);
        },
        websocket: {
          open(ws) {
            self.clients.add(ws);
          },
          close(ws) {
            self.clients.delete(ws);
          },
          async message(ws, message) {
            await self.handleWsMessage(ws, message);
          },
        },
      });
    } catch (err) {
      // Port busy — try an ephemeral port.
      console.warn(
        "[remote-access] preferred port unavailable, trying free port:",
        err instanceof Error ? err.message : err,
      );
      this.server = Bun.serve({
        hostname: "0.0.0.0",
        port: 0,
        fetch(req, server) {
          return self.handleFetch(req, server);
        },
        websocket: {
          open(ws) {
            self.clients.add(ws);
          },
          close(ws) {
            self.clients.delete(ws);
          },
          async message(ws, message) {
            await self.handleWsMessage(ws, message);
          },
        },
      });
    }

    this.port = this.server.port ?? preferredPort;
    const status = this.getStatus();
    console.log(
      `[remote-access] listening on 0.0.0.0:${this.port} code=${code}`,
    );
    if (status.url) console.log(`[remote-access] ${status.url}`);
    return status;
  }

  stop(): RemoteAccessStatus {
    if (this.server) {
      try {
        this.server.stop(true);
      } catch (err) {
        console.warn("[remote-access] stop error:", err);
      }
      this.server = null;
    }
    this.clients.clear();
    this.code = null;
    this.port = null;
    console.log("[remote-access] stopped");
    return this.getStatus();
  }

  /** Rotate access code; existing WS clients are dropped (code mismatch). */
  async regenerate(): Promise<RemoteAccessStatus> {
    const port = this.port ?? DEFAULT_PORT;
    const wasRunning = !!this.server;
    if (wasRunning) this.stop();
    if (!wasRunning) {
      // Not running — just return idle status with a preview code? start instead.
      return this.start({ port, code: generateAccessCode() });
    }
    return this.start({ port, code: generateAccessCode() });
  }

  /** Fan-out a webview-side message to all remote WS clients. */
  broadcast(name: string, params: unknown) {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify({ type: "message", name, params });
    for (const c of this.clients) {
      try {
        c.send(payload);
      } catch {
        /* drop broken socket */
      }
    }
  }

  // Convenience wrappers matching SessionManager event names
  onUpdate(sessionId: string, update: SessionUpdate) {
    this.broadcast("onUpdate", { sessionId, update });
  }
  onTurnEnd(payload: TurnEndPayload) {
    this.broadcast("onTurnEnd", payload);
  }
  onConnectionState(state: ConnectionStatePayload) {
    this.broadcast("onConnectionState", state);
  }
  onPermissionRequest(req: PermissionRequest) {
    this.broadcast("onPermissionRequest", req);
  }
  onSessionList(payload: SessionListPayload) {
    this.broadcast("onSessionList", payload);
  }
  onSessionLoaded(payload: SessionLoadedPayload) {
    this.broadcast("onSessionLoaded", payload);
  }
  onCommands(sessionId: string, commands: AvailableCommand[]) {
    this.broadcast("onCommands", { sessionId, commands });
  }
  onMode(sessionId: string, mode: string) {
    this.broadcast("onMode", { sessionId, mode });
  }
  onConfigOptions(sessionId: string, configOptions: SessionConfigOption[]) {
    this.broadcast("onConfigOptions", { sessionId, configOptions });
  }
  onUsage(sessionId: string, usage: SessionUsage) {
    this.broadcast("onUsage", { sessionId, usage });
  }

  private codeFromPath(pathname: string): string | null {
    // /r/<code> or /r/<code>/...
    const m = pathname.match(/^\/r\/([^/]+)/);
    return m?.[1] ?? null;
  }

  private authorized(pathname: string): boolean {
    if (!this.code) return false;
    const c = this.codeFromPath(pathname);
    return c === this.code;
  }

  private handleFetch(
    req: Request,
    // Bun's Server type; keep loose so upgrade options stay compatible.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server: any,
  ): Response | Promise<Response> | undefined {
    const url = new URL(req.url);
    const { pathname } = url;

    // WebSocket upgrade: /r/<code>/ws
    if (pathname === `/r/${this.code}/ws`) {
      if (server.upgrade(req, { data: {} })) {
        // Upgraded — no HTTP response body.
        return undefined;
      }
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    if (pathname.endsWith("/ws")) {
      return new Response("Unauthorized", { status: 401 });
    }

    // SPA entry: /r/<code> or /r/<code>/
    if (
      pathname === `/r/${this.code}` ||
      pathname === `/r/${this.code}/`
    ) {
      return this.serveIndex();
    }

    // Reject other /r/* paths with wrong code
    if (pathname.startsWith("/r/")) {
      if (!this.authorized(pathname)) {
        return new Response("Invalid or expired access code", { status: 403 });
      }
      // /r/code/something → SPA fallback
      return this.serveIndex();
    }

    // Static assets (absolute /assets/*)
    if (pathname.startsWith("/assets/") || pathname === "/favicon.ico") {
      return this.serveStatic(pathname);
    }

    // Root → hint
    if (pathname === "/" || pathname === "") {
      return new Response(
        "terminal-react remote access. Open the URL with your access code from the desktop app.",
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    return new Response("Not found", { status: 404 });
  }

  private serveIndex(): Response {
    const roots = resolveStaticRoots();
    if (roots.length === 0) {
      return new Response(
        "Remote UI assets not found. Run `bunx vite build` (or `bun run dev`) so dist/index.html exists.",
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    try {
      const html = readFileSync(join(roots[0]!, "index.html"), "utf8");
      return new Response(rewriteIndexHtml(html, this.code!), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(`Failed to read index.html: ${message}`, {
        status: 500,
      });
    }
  }

  private serveStatic(pathname: string): Response {
    const roots = resolveStaticRoots();
    for (const root of roots) {
      const rel = pathname.replace(/^\//, "");
      const full = safeJoin(root, rel);
      if (!full || !existsSync(full) || !statSync(full).isFile()) continue;
      const ext = extname(full).toLowerCase();
      const type = MIME[ext] ?? "application/octet-stream";
      return new Response(Bun.file(full), {
        headers: {
          "content-type": type,
          "cache-control": "public, max-age=3600",
        },
      });
    }
    // Dev HMR: try listing first root for debugging
    if (roots[0]) {
      try {
        const assets = join(roots[0], "assets");
        if (existsSync(assets)) {
          const names = readdirSync(assets).slice(0, 20).join(", ");
          return new Response(`Asset not found: ${pathname}. Have: ${names}`, {
            status: 404,
          });
        }
      } catch {
        /* ignore */
      }
    }
    return new Response(`Asset not found: ${pathname}`, { status: 404 });
  }

  private async handleWsMessage(
    ws: WsClient,
    message: string | Buffer,
  ): Promise<void> {
    let raw: string;
    if (typeof message === "string") raw = message;
    else raw = new TextDecoder().decode(message);

    let msg: {
      type?: string;
      id?: string;
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(
        JSON.stringify({
          type: "response",
          id: null,
          error: "invalid JSON",
        }),
      );
      return;
    }

    if (msg.type !== "request" || !msg.method || !msg.id) {
      ws.send(
        JSON.stringify({
          type: "response",
          id: msg.id ?? null,
          error: "expected { type: request, id, method, params }",
        }),
      );
      return;
    }

    try {
      const result = await this.dispatch(msg.method, msg.params ?? {});
      ws.send(
        JSON.stringify({ type: "response", id: msg.id, result }),
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      ws.send(
        JSON.stringify({ type: "response", id: msg.id, error }),
      );
    }
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const h = this.handlers;
    switch (method) {
      case "sendPrompt":
        return h.sendPrompt(
          String(params.text ?? ""),
          params.sessionId != null ? String(params.sessionId) : undefined,
        );
      case "cancel":
        return h.cancel(
          params.sessionId != null ? String(params.sessionId) : undefined,
        );
      case "listAgents":
        return h.listAgents();
      case "listSessions":
        return h.listSessions();
      case "createSession":
        return h.createSession({
          title: params.title != null ? String(params.title) : undefined,
          project: params.project != null ? String(params.project) : undefined,
          cwd: params.cwd != null ? String(params.cwd) : undefined,
          agentId: params.agentId != null ? String(params.agentId) : undefined,
          seedContext: params.seedContext as
            | {
                text: string;
                role?: "user" | "agent" | "thought";
              }
            | undefined,
        });
      case "switchSession":
        return h.switchSession(String(params.sessionId));
      case "deleteSession":
        return h.deleteSession(String(params.sessionId));
      case "offloadSession":
        return h.offloadSession(String(params.sessionId));
      case "respondPermission":
        return h.respondPermission(
          String(params.requestId),
          String(params.optionId),
        );
      case "openFile":
        return h.openFile(
          String(params.path),
          params.line != null ? Number(params.line) : undefined,
        );
      case "getSettings":
        return h.getSettings();
      case "saveSettings":
        return h.saveSettings(params as Partial<AppSettings>);
      case "getConnectionState":
        return h.getConnectionState();
      case "connectAgent":
        return h.connectAgent(
          params.agentId != null ? String(params.agentId) : undefined,
          params.cwd != null ? String(params.cwd) : undefined,
        );
      case "pickFolder":
        // Native dialog only on desktop — remote clients type a path.
        return {
          ok: false as const,
          error:
            "Folder picker is only available on the desktop app. Paste the project path instead.",
        };
      case "listRecentProjects":
        return h.listRecentProjects();
      case "removeRecentProject":
        return h.removeRecentProject(String(params.cwd ?? ""));
      case "writeClipboard":
        return h.writeClipboard(String(params.text ?? ""));
      case "readClipboard":
        return h.readClipboard();
      case "getGitBranch":
        return h.getGitBranch(String(params.cwd ?? ""));
      case "windowControl":
        return { ok: false as const, error: "No window control on remote" };
      case "setConfigOption":
        return h.setConfigOption(
          String(params.configId),
          params.value as string | boolean,
          params.sessionId != null ? String(params.sessionId) : undefined,
        );
      case "showDesktopNotification":
        return { ok: true };
      case "listSkills":
        return h.listSkills(
          params.projectCwd != null ? String(params.projectCwd) : null,
        );
      case "installSkill":
        return h.installSkill(String(params.package ?? ""));
      case "setSkillEnabled":
        return h.setSkillEnabled(
          String(params.skillId ?? ""),
          Boolean(params.enabled),
        );
      case "uninstallSkill":
        return h.uninstallSkill(String(params.skillId ?? ""));
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }
}

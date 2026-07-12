/**
 * Localhost control plane for the built-in browser.
 *
 * The MCP stdio process (spawned by Claude Code) POSTs here; we forward page
 * actions to the webview BrowserPanel via Electrobun RPC, and token store/list
 * to SQLite so multi-step auth can be reused on later prompts.
 *
 * Each MCP process is bound to one chat session via TR_BROWSER_SESSION_ID —
 * agents never pick a session; the server already knows which chat they own.
 */
import type {
  BrowserControlRequest,
  BrowserControlResponse,
  BrowserTokenSummary,
} from "../shared/browser-control";

export type BrowserControlDispatcher = (
  req: BrowserControlRequest,
) => Promise<BrowserControlResponse>;

export type BrowserOpenNotifier = (
  sessionId: string,
  url?: string,
) => void;

export type BrowserSecretsHandlers = {
  store: (input: {
    sessionId: string;
    key: string;
    value: string;
    label?: string;
    domain?: string;
  }) => BrowserControlResponse | Promise<BrowserControlResponse>;
  list: (sessionId: string) =>
    | { ok: true; tokens: BrowserTokenSummary[]; projectCwd?: string | null }
    | { ok: false; error: string }
    | Promise<
        | {
            ok: true;
            tokens: BrowserTokenSummary[];
            projectCwd?: string | null;
          }
        | { ok: false; error: string }
      >;
  delete: (
    sessionId: string,
    key: string,
  ) => BrowserControlResponse | Promise<BrowserControlResponse>;
  /** Resolve project cwd + optional panel status for session_info. */
  sessionInfo?: (sessionId: string) =>
    | {
        ok: true;
        projectCwd: string | null;
        panelOpen?: boolean;
        tokens: BrowserTokenSummary[];
      }
    | { ok: false; error: string }
    | Promise<
        | {
            ok: true;
            projectCwd: string | null;
            panelOpen?: boolean;
            tokens: BrowserTokenSummary[];
          }
        | { ok: false; error: string }
      >;
};

const PAGE_ACTIONS = new Set([
  "navigate",
  "snapshot",
  "click",
  "type",
  "fill",
  "press",
  "back",
  "forward",
  "reload",
  "url",
  "evaluate",
  "open",
]);

export class BrowserControlServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port = 0;
  private token: string;
  private dispatch: BrowserControlDispatcher;
  private onOpen: BrowserOpenNotifier;
  private secrets: BrowserSecretsHandlers | null;
  /** Sessions for which we have requested the panel open (best-effort). */
  private openRequested = new Set<string>();

  constructor(
    dispatch: BrowserControlDispatcher,
    onOpen: BrowserOpenNotifier,
    options?: {
      token?: string;
      secrets?: BrowserSecretsHandlers;
    },
  ) {
    this.dispatch = dispatch;
    this.onOpen = onOpen;
    this.token = options?.token ?? crypto.randomUUID();
    this.secrets = options?.secrets ?? null;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get authToken(): string {
    return this.token;
  }

  setSecrets(secrets: BrowserSecretsHandlers) {
    this.secrets = secrets;
  }

  markPanelOpen(sessionId: string) {
    this.openRequested.add(sessionId);
  }

  markPanelClosed(sessionId: string) {
    this.openRequested.delete(sessionId);
  }

  start(): { url: string; token: string } {
    if (this.server) {
      return { url: this.baseUrl, token: this.token };
    }

    const self = this;
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const auth = req.headers.get("authorization") ?? "";
        const expected = `Bearer ${self.token}`;
        if (auth !== expected) {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }

        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/health") {
          return Response.json({ ok: true });
        }

        if (req.method === "POST" && url.pathname === "/action") {
          let body: BrowserControlRequest;
          try {
            body = (await req.json()) as BrowserControlRequest;
          } catch {
            return Response.json(
              { ok: false, error: "invalid JSON body" },
              { status: 400 },
            );
          }
          if (!body?.sessionId || !body?.action) {
            return Response.json(
              { ok: false, error: "sessionId and action required" },
              { status: 400 },
            );
          }

          try {
            const result = await self.handleAction(body);
            return Response.json(result);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return Response.json({ ok: false, error: message });
          }
        }

        return new Response("not found", { status: 404 });
      },
    });

    this.port = this.server.port ?? 0;
    console.log(
      `[browser-control] listening on ${this.baseUrl} (token ${this.token.slice(0, 8)}…)`,
    );
    return { url: this.baseUrl, token: this.token };
  }

  private requestOpen(sessionId: string, url?: string) {
    this.openRequested.add(sessionId);
    this.onOpen(sessionId, url);
  }

  private async handleAction(
    body: BrowserControlRequest,
  ): Promise<BrowserControlResponse> {
    if (body.action === "session_info") {
      if (this.secrets?.sessionInfo) {
        const info = await this.secrets.sessionInfo(body.sessionId);
        if (!info.ok) return info;
        return {
          ok: true,
          sessionId: body.sessionId,
          projectCwd: info.projectCwd,
          panelOpen: info.panelOpen ?? this.openRequested.has(body.sessionId),
          tokens: info.tokens,
          message:
            `Bound to chat session ${body.sessionId}. ` +
            `Use browser_open or browser_navigate to show the right-side panel. ` +
            `Tokens listed are for this project and will be injected into prompts.`,
        };
      }
      if (!this.secrets) {
        return { ok: false, error: "Session info not available" };
      }
      const listed = await this.secrets.list(body.sessionId);
      if (!listed.ok) return listed;
      return {
        ok: true,
        sessionId: body.sessionId,
        projectCwd: listed.projectCwd ?? null,
        panelOpen: this.openRequested.has(body.sessionId),
        tokens: listed.tokens,
        message: `Bound to chat session ${body.sessionId}.`,
      };
    }

    if (body.action === "store_token") {
      if (!this.secrets) {
        return { ok: false, error: "Token store not available" };
      }
      const key = body.tokenKey?.trim() || body.key?.trim();
      const value = body.tokenValue ?? body.text;
      if (!key || value == null || value === "") {
        return { ok: false, error: "tokenKey and tokenValue required" };
      }
      return this.secrets.store({
        sessionId: body.sessionId,
        key,
        value: String(value),
        label: body.tokenLabel,
        domain: body.tokenDomain,
      });
    }

    if (body.action === "list_tokens") {
      if (!this.secrets) {
        return { ok: false, error: "Token store not available" };
      }
      return this.secrets.list(body.sessionId);
    }

    if (body.action === "delete_token") {
      if (!this.secrets) {
        return { ok: false, error: "Token store not available" };
      }
      const key = body.tokenKey?.trim() || body.key?.trim();
      if (!key) return { ok: false, error: "tokenKey required" };
      return this.secrets.delete(body.sessionId, key);
    }

    if (!PAGE_ACTIONS.has(body.action)) {
      return { ok: false, error: `Unknown action: ${body.action}` };
    }

    // Always open/mount the panel before any page action so the webview
    // handler is registered — agents should not need a manual globe click.
    this.requestOpen(
      body.sessionId,
      body.action === "navigate" ? body.url : undefined,
    );

    if (body.action === "open") {
      // Give React a beat to mount, then confirm via dispatcher wait path.
      await new Promise((r) => setTimeout(r, 120));
      return {
        ok: true,
        sessionId: body.sessionId,
        panelOpen: true,
        message:
          "Built-in browser panel open requested for this chat. " +
          "Use browser_navigate next if you need a URL.",
      };
    }

    return this.dispatch(body);
  }

  stop() {
    this.server?.stop(true);
    this.server = null;
    this.port = 0;
  }
}

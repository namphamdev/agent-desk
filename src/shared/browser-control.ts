/**
 * Shared types for the in-app browser control plane.
 * Agent MCP tools → Bun control server → webview BrowserPanel / SQLite secrets.
 */

export type BrowserControlAction =
  | "navigate"
  | "snapshot"
  | "click"
  | "type"
  | "fill"
  | "press"
  | "back"
  | "forward"
  | "reload"
  | "url"
  /** Run JS in the page and return JSON-serializable result. */
  | "evaluate"
  /** Persist a token/secret to SQLite for this project. */
  | "store_token"
  /** List stored token keys (and values) for this project. */
  | "list_tokens"
  /** Delete a stored token. */
  | "delete_token"
  /** Open the right-side panel for this chat (no navigation). */
  | "open"
  /** Discover binding: session id, project cwd, panel state, tokens. */
  | "session_info";

export type BrowserControlRequest = {
  sessionId: string;
  action: BrowserControlAction;
  url?: string;
  /** Element ref from a prior snapshot (e.g. "e3"). */
  ref?: string;
  text?: string;
  key?: string;
  /** When true, submit after type (press Enter). */
  submit?: boolean;
  /** JS expression for evaluate (must return a JSON-serializable value). */
  expression?: string;
  /** Token key for store_token / delete_token. */
  tokenKey?: string;
  /** Token value for store_token. */
  tokenValue?: string;
  /** Optional human label for store_token. */
  tokenLabel?: string;
  /** Optional domain hint for store_token. */
  tokenDomain?: string;
};

export type BrowserTokenSummary = {
  key: string;
  value: string;
  label?: string;
  domain?: string;
  updatedAt?: number;
  /** Chat session that last wrote this token, if known. */
  sessionId?: string | null;
};

export type BrowserControlResponse =
  | {
      ok: true;
      url?: string;
      title?: string;
      /** Accessibility-style snapshot text for the agent. */
      snapshot?: string;
      message?: string;
      /** Result of evaluate (JSON-stringified if object). */
      result?: string;
      /** Stored tokens from list_tokens / session_info. */
      tokens?: BrowserTokenSummary[];
      /** Echo of bound chat session id. */
      sessionId?: string;
      /** Project folder this chat (and tokens) are scoped to. */
      projectCwd?: string | null;
      /** Whether the in-app panel is currently mounted for this chat. */
      panelOpen?: boolean;
    }
  | { ok: false; error: string };

/** Message: agent (or control plane) wants the panel open for a session. */
export type BrowserOpenMessage = {
  sessionId: string;
  url?: string;
};

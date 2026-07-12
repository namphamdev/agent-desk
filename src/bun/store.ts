/**
 * Local persistence for sessions + raw ACP events using bun:sqlite.
 * Full events are stored so future renderer changes can re-derive cleanly.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionUpdate } from "../session/types";
import type { SessionSummary } from "../shared/rpc";

export type StoredSession = SessionSummary & {
  mode: string;
};

/** Token/secret captured from the built-in browser and reused across prompts. */
export type BrowserTokenRecord = {
  id: string;
  key: string;
  value: string;
  projectCwd: string;
  domain: string;
  label: string;
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
};

export class SessionStore {
  private db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, "sessions.sqlite");
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        project TEXT NOT NULL DEFAULT '',
        cwd TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'default',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        update_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_events_session_seq
        ON events(session_id, seq);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Tokens / secrets captured from the built-in browser (OAuth, API keys).
      -- Scoped by project cwd so chats in the same project reuse them.
      CREATE TABLE IF NOT EXISTS browser_tokens (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        project_cwd TEXT NOT NULL DEFAULT '',
        domain TEXT NOT NULL DEFAULT '',
        label TEXT NOT NULL DEFAULT '',
        session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_cwd, key)
      );

      CREATE INDEX IF NOT EXISTS idx_browser_tokens_project
        ON browser_tokens(project_cwd);
    `);
  }

  // --- Browser tokens (persisted secrets for agent reuse) ---

  upsertBrowserToken(input: {
    key: string;
    value: string;
    projectCwd: string;
    domain?: string;
    label?: string;
    sessionId?: string | null;
  }): BrowserTokenRecord {
    const key = input.key.trim();
    if (!key) throw new Error("token key required");
    const projectCwd = input.projectCwd || "";
    const now = Date.now();
    const existing = this.db
      .query(
        `SELECT id, created_at as createdAt FROM browser_tokens
         WHERE project_cwd = ? AND key = ?`,
      )
      .get(projectCwd, key) as { id: string; createdAt: number } | null;

    const id = existing?.id ?? crypto.randomUUID();
    const createdAt = existing?.createdAt ?? now;
    this.db
      .query(
        `INSERT INTO browser_tokens
           (id, key, value, project_cwd, domain, label, session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_cwd, key) DO UPDATE SET
           value = excluded.value,
           domain = excluded.domain,
           label = excluded.label,
           session_id = excluded.session_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        key,
        input.value,
        projectCwd,
        input.domain ?? "",
        input.label ?? "",
        input.sessionId ?? null,
        createdAt,
        now,
      );
    return {
      id,
      key,
      value: input.value,
      projectCwd,
      domain: input.domain ?? "",
      label: input.label ?? "",
      sessionId: input.sessionId ?? null,
      createdAt,
      updatedAt: now,
    };
  }

  listBrowserTokens(projectCwd: string): BrowserTokenRecord[] {
    const rows = this.db
      .query(
        `SELECT id, key, value, project_cwd as projectCwd, domain, label,
                session_id as sessionId, created_at as createdAt, updated_at as updatedAt
         FROM browser_tokens WHERE project_cwd = ? ORDER BY key ASC`,
      )
      .all(projectCwd || "") as BrowserTokenRecord[];
    return rows;
  }

  getBrowserToken(
    projectCwd: string,
    key: string,
  ): BrowserTokenRecord | null {
    const row = this.db
      .query(
        `SELECT id, key, value, project_cwd as projectCwd, domain, label,
                session_id as sessionId, created_at as createdAt, updated_at as updatedAt
         FROM browser_tokens WHERE project_cwd = ? AND key = ?`,
      )
      .get(projectCwd || "", key.trim()) as BrowserTokenRecord | null;
    return row ?? null;
  }

  deleteBrowserToken(projectCwd: string, key: string): boolean {
    const res = this.db
      .query(`DELETE FROM browser_tokens WHERE project_cwd = ? AND key = ?`)
      .run(projectCwd || "", key.trim());
    return res.changes > 0;
  }

  listSessions(): SessionSummary[] {
    const rows = this.db
      .query(
        `SELECT id, title, project, cwd, agent_id as agentId, created_at as createdAt, updated_at as updatedAt
         FROM sessions ORDER BY updated_at DESC`,
      )
      .all() as Array<SessionSummary>;
    return rows;
  }

  getSession(id: string): StoredSession | null {
    const row = this.db
      .query(
        `SELECT id, title, project, cwd, agent_id as agentId, mode,
                created_at as createdAt, updated_at as updatedAt
         FROM sessions WHERE id = ?`,
      )
      .get(id) as StoredSession | null;
    return row ?? null;
  }

  createSession(input: {
    id: string;
    title: string;
    project: string;
    cwd: string;
    agentId: string;
  }): StoredSession {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO sessions (id, title, project, cwd, agent_id, mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'default', ?, ?)`,
      )
      .run(
        input.id,
        input.title,
        input.project,
        input.cwd,
        input.agentId,
        now,
        now,
      );
    return {
      ...input,
      mode: "default",
      createdAt: now,
      updatedAt: now,
    };
  }

  updateSession(
    id: string,
    patch: Partial<Pick<StoredSession, "title" | "project" | "mode" | "agentId">>,
  ) {
    const s = this.getSession(id);
    if (!s) return;
    const title = patch.title ?? s.title;
    const project = patch.project ?? s.project;
    const mode = patch.mode ?? s.mode;
    const agentId = patch.agentId ?? s.agentId;
    const now = Date.now();
    this.db
      .query(
        `UPDATE sessions SET title = ?, project = ?, mode = ?, agent_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(title, project, mode, agentId, now, id);
  }

  touchSession(id: string) {
    this.db
      .query(`UPDATE sessions SET updated_at = ? WHERE id = ?`)
      .run(Date.now(), id);
  }

  deleteSession(id: string) {
    this.db.query(`DELETE FROM events WHERE session_id = ?`).run(id);
    this.db.query(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  appendEvent(sessionId: string, update: SessionUpdate) {
    const row = this.db
      .query(
        `SELECT COALESCE(MAX(seq), 0) as maxSeq FROM events WHERE session_id = ?`,
      )
      .get(sessionId) as { maxSeq: number };
    const seq = (row?.maxSeq ?? 0) + 1;
    this.db
      .query(
        `INSERT INTO events (session_id, seq, update_json, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(sessionId, seq, JSON.stringify(update), Date.now());
    this.touchSession(sessionId);
  }

  loadEvents(sessionId: string): SessionUpdate[] {
    const rows = this.db
      .query(
        `SELECT update_json FROM events WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all(sessionId) as Array<{ update_json: string }>;
    return rows.map((r) => JSON.parse(r.update_json) as SessionUpdate);
  }

  getSetting(key: string): string | null {
    const row = this.db
      .query(`SELECT value FROM settings WHERE key = ?`)
      .get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string) {
    this.db
      .query(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  close() {
    this.db.close();
  }
}

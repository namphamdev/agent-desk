/** Runtime configuration for the self-hosted edge server. Replaces the
 * Cloudflare Worker `Env` interface: no DurableObjectNamespace, R2Bucket, or
 * KVNamespace — rooms are in-process, blobs on filesystem, KV as JSON. */
export interface Env {
  /** Root data directory for all persistent storage. Default: /app/data. */
  DATA_DIR: string;
  /** HTTP/WS listen port. Default: 3000. */
  PORT: number;
  WORKOS_CLIENT_ID: string;
  /** "workos" (verify AuthKit JWTs) or "dev" (bearer == userId, never prod). */
  AUTH_MODE: "workos" | "dev";
  /** Optional overrides for the WorkOS trust anchor. */
  WORKOS_ISSUER?: string;
  WORKOS_JWKS_URL?: string;
  /** WorkOS secret API key — powers /auth/exchange, /auth/refresh, /auth/orgs. */
  WORKOS_API_KEY?: string;
  /** Base64 32-byte secret key for AES-256-GCM encryption of account settings. */
  SETTINGS_ENCRYPTION_KEY?: string;
  /** Shared secret for internal /push/send calls from the Rust engine. */
  PUSH_INTERNAL_SECRET?: string;
}

/** Header the server stamps on requests it forwards into rooms after verifying
 * the caller's JWT. Rooms trust it blindly — they are only reachable through
 * the authenticated router. */
export const AUTH_USER_HEADER = "x-comet-auth-user";

/** Header stamped on requests forwarded into workspace-doc rooms. Membership
 * (JWT org claim == orgId) is enforced at the router; the room sees this and
 * skips its per-chat claim-on-first-join ownership discipline. */
export const ROOM_KIND_HEADER = "x-comet-room-kind";

/** Build an Env from process.env with defaults. */
export const loadEnv = (): Env => ({
  DATA_DIR: process.env.DATA_DIR ?? "./data",
  PORT: parseInt(process.env.PORT ?? "3000", 10),
  WORKOS_CLIENT_ID: process.env.WORKOS_CLIENT_ID ?? "",
  AUTH_MODE: (process.env.AUTH_MODE ?? "dev") as "workos" | "dev",
  WORKOS_ISSUER: process.env.WORKOS_ISSUER,
  WORKOS_JWKS_URL: process.env.WORKOS_JWKS_URL,
  WORKOS_API_KEY: process.env.WORKOS_API_KEY,
  SETTINGS_ENCRYPTION_KEY: process.env.SETTINGS_ENCRYPTION_KEY,
  PUSH_INTERNAL_SECRET: process.env.PUSH_INTERNAL_SECRET
});

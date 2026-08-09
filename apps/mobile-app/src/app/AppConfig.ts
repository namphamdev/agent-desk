// Session-wide connection config: edge base URL, identity, token minting for
// room sockets (WS auth rides the URL query — sockets can't set headers), and
// the durable-nudge POST.

import { AuthClient, AuthError, AuthTokens, isJwtExpired, jwtExpiresIn, Keychain } from '../auth/AuthClient';

export type AppConfigMode = 'workos' | 'dev';

export interface AppConfigInit {
  edgeURL: string;
  mode: AppConfigMode;
  userId: string;
  orgId: string;
  deviceId: string;
  deviceName: string;
  tokens?: AuthTokens;
  devBearer?: string;
}

/**
 * Plain class — methods are async (no actor isolation in JS). The token cache
 * is mutable; refresh mutates it and persists to Keychain.
 *
 * `onAuthFailed` is invoked when the refresh token is permanently rejected
 * (HTTP 400/401 from WorkOS), so the app can return the user to the sign-in
 * screen instead of looping forever against an expired session.
 */
export class AppConfig {
  readonly edgeURL: string;
  readonly mode: AppConfigMode;
  readonly userId: string;
  readonly orgId: string;
  readonly deviceId: string;
  readonly deviceName: string;

  /** Set by AppModel; fired exactly once when refresh is permanently invalid. */
  onAuthFailed?: () => void;

  private tokens: AuthTokens | undefined;
  private devBearer: string | undefined;
  /** In-flight refresh promise — concurrent callers share the same request so
   * refresh-token rotation doesn't collide. */
  private refreshInFlight: Promise<string | null> | null = null;
  private authFailedFired = false;

  constructor(init: AppConfigInit) {
    this.edgeURL = init.edgeURL;
    this.mode = init.mode;
    this.userId = init.userId;
    this.orgId = init.orgId;
    this.deviceId = init.deviceId;
    this.deviceName = init.deviceName;
    this.tokens = init.tokens;
    this.devBearer = init.devBearer;
  }

  updateTokens(next: AuthTokens): void {
    this.tokens = next;
    // New tokens received — clear any stale auth-failed flag so a future
    // expiry can re-trigger the callback.
    this.authFailedFired = false;
  }

  /** Current bearer, refreshing the WorkOS access token when needed.
   * Concurrent calls share a single in-flight refresh to avoid racing
   * WorkOS refresh-token rotation (each call invalidates the prior token). */
  async currentToken(): Promise<string | null> {
    switch (this.mode) {
      case 'dev':
        return this.devBearer ?? null;
      case 'workos': {
        const current = this.tokens;
        if (!current) return null;
        if (!isJwtExpired(current.accessToken)) return current.accessToken;
        // Dedupe: if a refresh is already in flight, await it instead of
        // starting a second concurrent one that would use the same (stale)
        // refresh token and collide with rotation.
        if (this.refreshInFlight) return this.refreshInFlight;
        this.refreshInFlight = this.doRefresh(current);
        try {
          return await this.refreshInFlight;
        } finally {
          this.refreshInFlight = null;
        }
      }
    }
  }

  private async doRefresh(current: AuthTokens): Promise<string | null> {
    const client = new AuthClient(this.edgeURL);
    try {
      const refreshed = await client.refresh(current.refreshToken, this.orgId);
      // Persist BEFORE updating in-memory state so a crash between the two
      // never leaves Keychain holding an already-rotated refresh token.
      await Keychain.saveAccessToken(refreshed.accessToken);
      await Keychain.saveRefreshToken(refreshed.refreshToken);
      this.tokens = refreshed;
      return refreshed.accessToken;
    } catch (err) {
      // Distinguish permanent (auth) failures from transient (network) ones.
      // WorkOS rejects an expired/rotated refresh token with 400 or 401.
      if (err instanceof AuthError && (err.code === 400 || err.code === 401)) {
        console.warn('[appconfig] refresh token rejected; signing out', err.code);
        if (!this.authFailedFired) {
          this.authFailedFired = true;
          this.onAuthFailed?.();
        }
        return null;
      }
      console.warn('[appconfig] token refresh failed (transient); using expired token', err);
      return current.accessToken; // let the server reject; backoff redials
    }
  }

  private get wsBase(): string {
    return this.edgeURL.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  }

  /** Minimum seconds of remaining validity a token must have to be embedded
   * in a WS URL. The token is baked into the URL at connect time and cannot
   * be refreshed mid-socket, so it must outlast the handshake RTT + WorkOS
   * JWKS verification on the edge plus a reasonable socket lifetime. If the
   * cached token falls below this floor, force a refresh before building the
   * URL. This is the defensive backstop behind isJwtExpired's margin: even
   * if a redial races the refresh, it never ships an about-to-expire token. */
  private static readonly SOCKET_TOKEN_MIN_VALIDITY_S = 90;

  /** Token guaranteed to have at least SOCKET_TOKEN_MIN_VALIDITY_S of
   * validity remaining (after the early-refresh margin), refreshing first if
   * the cached token is too close to expiry. Use this for every WS URL
   * builder; use currentToken() for short-lived HTTP requests. */
  private async freshTokenForSocket(): Promise<string | null> {
    const current = this.tokens;
    if (current && !isJwtExpired(current.accessToken)) {
      const remaining = jwtExpiresIn(current.accessToken);
      if (remaining >= AppConfig.SOCKET_TOKEN_MIN_VALIDITY_S) {
        return current.accessToken;
      }
      // Token is valid but won't outlive the minimum floor — refresh now so
      // the WS URL gets a token with enough runway.
      if (this.mode === 'dev') return this.devBearer ?? null;
      if (this.refreshInFlight) return this.refreshInFlight;
      this.refreshInFlight = this.doRefresh(current);
      try {
        return await this.refreshInFlight;
      } finally {
        this.refreshInFlight = null;
      }
    }
    return this.currentToken();
  }

  async workspaceSocketURL(): Promise<string | null> {
    const token = await this.freshTokenForSocket();
    if (!token) return null;
    return `${this.wsBase}/workspace/${this.orgId}/ws?token=${encodeURIComponent(token)}`;
  }

  async sessionSocketURL(chatId: string): Promise<string | null> {
    const token = await this.freshTokenForSocket();
    if (!token) return null;
    return `${this.wsBase}/session/${chatId}/ws?token=${encodeURIComponent(token)}`;
  }

  async deviceStatus(deviceId: string): Promise<string> {
    const token = await this.currentToken();
    if (!token) return 'no-token';
    try {
      const res = await fetch(`${this.edgeURL}/device/${deviceId}/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.text();
      return `http=${res.status} body=${body}`;
    } catch {
      return 'unreachable';
    }
  }

  /** POST /device/{deviceId}/nudge {chatId} — wake a cold host. */
  async nudge(deviceId: string, chatId: string): Promise<void> {
    const token = await this.currentToken();
    if (!token) return;
    try {
      await fetch(`${this.edgeURL}/device/${deviceId}/nudge`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ chatId }),
      });
    } catch {
      // fire-and-forget; doc is durable regardless
    }
  }

  deviceRelaySocketURL(deviceId: string, connId: string): Promise<string | null> {
    return (async () => {
      const token = await this.freshTokenForSocket();
      if (!token) return null;
      const params = new URLSearchParams({
        role: 'client',
        connId,
        token,
      });
      return `${this.wsBase}/device/${deviceId}/ws?${params.toString()}`;
    })();
  }

  /** POST /push/register {token} — register this device's Expo push token. */
  async registerPushToken(pushToken: string): Promise<boolean> {
    const token = await this.currentToken();
    if (!token) {
      console.warn('[appconfig] push register: no auth token');
      return false;
    }
    try {
      const res = await fetch(`${this.edgeURL}/push/register`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token: pushToken }),
      });
      const body = await res.text();
      console.info('[appconfig] push register response:', res.status, body);
      return res.ok;
    } catch (err) {
      console.warn('[appconfig] push register failed', err);
      return false;
    }
  }
}

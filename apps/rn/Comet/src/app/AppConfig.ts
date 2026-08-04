// Session-wide connection config: edge base URL, identity, token minting for
// room sockets (WS auth rides the URL query — sockets can't set headers), and
// the durable-nudge POST.

import { AuthClient, AuthTokens, isJwtExpired, Keychain } from '../auth/AuthClient';

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
 */
export class AppConfig {
  readonly edgeURL: string;
  readonly mode: AppConfigMode;
  readonly userId: string;
  readonly orgId: string;
  readonly deviceId: string;
  readonly deviceName: string;

  private tokens: AuthTokens | undefined;
  private devBearer: string | undefined;

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
  }

  /** Current bearer, refreshing the WorkOS access token when needed. */
  async currentToken(): Promise<string | null> {
    switch (this.mode) {
      case 'dev':
        return this.devBearer ?? null;
      case 'workos': {
        const current = this.tokens;
        if (!current) return null;
        if (!isJwtExpired(current.accessToken)) return current.accessToken;
        const client = new AuthClient(this.edgeURL);
        try {
          const refreshed = await client.refresh(
            current.refreshToken,
            this.orgId,
          );
          this.updateTokens(refreshed);
          await Keychain.saveAccessToken(refreshed.accessToken);
          await Keychain.saveRefreshToken(refreshed.refreshToken);
          return refreshed.accessToken;
        } catch (err) {
          console.warn('[appconfig] token refresh failed; using expired token', err);
          return current.accessToken; // let the server reject; backoff redials
        }
      }
    }
  }

  private get wsBase(): string {
    return this.edgeURL.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  }

  async workspaceSocketURL(): Promise<string | null> {
    const token = await this.currentToken();
    if (!token) return null;
    return `${this.wsBase}/workspace/${this.orgId}/ws?token=${encodeURIComponent(token)}`;
  }

  async sessionSocketURL(chatId: string): Promise<string | null> {
    const token = await this.currentToken();
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
      const token = await this.currentToken();
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

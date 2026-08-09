// App session root — TS port of AppModel.swift. Sign-in state machine,
// workspace connection, and the per-chat session store cache. Also hosts
// demo mode — an offline in-memory dataset so the UI can be exercised
// without an edge deployment.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { v4 as uuidv4 } from 'uuid';

import { AppConfig, AppConfigMode } from './AppConfig';
import { DemoDataset } from './DemoDataset';
import {
  AcpAgentsSnapshot,
  baseName,
  Chat,
  ChatConfig,
  ChatIndicatorValue,
  chatIndicator,
  CheckoutKind,
  CustomProviderDraft,
  CustomProviderSnapshot,
  effectiveStatus,
  FolderListing,
  GitStatus,
  nowMs,
  PRESENCE_FRESH_MS,
  RepoRef,
  Route,
  SessionRow,
  SessionStatusValue,
  sortActive,
  Space,
} from '../models/Entities';
import { HarnessCatalog, ModelInfo } from '../models/HarnessCatalog';
import { AuthClient, AuthOrg, AuthTokens, Keychain } from '../auth/AuthClient';
import { SessionStore } from '../sync/SessionStore';
import { WorkspaceStore } from '../sync/WorkspaceStore';
import { NotificationManager } from '../notifications/NotificationManager';
import { DocDisk } from '../sync/DocDisk';

export type Phase =
  | { kind: 'signedOut' }
  | { kind: 'pickingOrg'; tokens: AuthTokens; orgs: AuthOrg[] }
  | { kind: 'ready' };

interface Listener {
  (): void;
}

const KEY_EDGE_URL = 'edgeURL';
const KEY_AUTH_MODE = 'authMode';
const KEY_USER_ID = 'userId';
const KEY_ORG_ID = 'orgId';
const KEY_DEVICE_ID = 'deviceId';

export class AppModel {
  phase: Phase = { kind: 'signedOut' };
  workspace?: WorkspaceStore;
  demo?: DemoDataset;
  notifications = NotificationManager.shared;
  launchRoute?: Route;
  launchSheet?: string;
  launchAutosend = false;

  private sessionStores = new Map<string, SessionStore>();
  private config?: AppConfig;
  private listeners = new Set<Listener>();

  // Persisted connection settings.
  edgeURLString: string = DEFAULT_EDGE_URL;
  authModeRaw: AppConfigMode = 'workos';
  storedUserId = '';
  storedOrgId = '';
  storedDeviceId = '';

  private get deviceId(): string {
    if (this.storedDeviceId.length === 0) {
      this.storedDeviceId = `rn-${uuidv4().slice(0, 8)}`;
      void AsyncStorage.setItem(KEY_DEVICE_ID, this.storedDeviceId);
    }
    return this.storedDeviceId;
  }

  private get deviceName(): string {
    return Platform.OS === 'ios' ? 'iPhone' : Platform.OS === 'android' ? 'Android' : 'Device';
  }

  // MARK: Subscription

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(): void {
    for (const fn of this.listeners) fn();
  }

  // MARK: Restore

  async restore(): Promise<void> {
    if (this.demo) return;
    await DocDisk.prune(80);

    this.edgeURLString = DEFAULT_EDGE_URL || ((await AsyncStorage.getItem(KEY_EDGE_URL)) ?? "");
    const mode = (await AsyncStorage.getItem(KEY_AUTH_MODE)) as AppConfigMode | null;
    this.authModeRaw = mode ?? 'workos';
    this.storedUserId = (await AsyncStorage.getItem(KEY_USER_ID)) ?? '';
    this.storedOrgId = (await AsyncStorage.getItem(KEY_ORG_ID)) ?? '';
    this.storedDeviceId = (await AsyncStorage.getItem(KEY_DEVICE_ID)) ?? '';

    if (!this.storedUserId || !this.storedOrgId) return;
    const url = this.edgeURLString;
    if (!url) return;

    if (this.authModeRaw === 'dev') {
      this.connect(url, 'dev', this.storedUserId, this.storedOrgId, undefined, this.devBearer(this.storedUserId, this.storedOrgId));
    } else {
      const access = await Keychain.loadAccessToken();
      const refresh = await Keychain.loadRefreshToken();
      if (!access || !refresh) return;
      this.connect(url, 'workos', this.storedUserId, this.storedOrgId, { accessToken: access, refreshToken: refresh }, undefined);
    }
  }

  enterDemoMode(): void {
    this.demo = DemoDataset.standard();
    this.phase = { kind: 'ready' };
    this.notify();
  }

  // MARK: Sign-in

  async signIn(edgeURL: string, code: string): Promise<void> {
    const client = new AuthClient(edgeURL);
    const { user, tokens } = await client.exchange(code);
    this.edgeURLString = edgeURL;
    this.authModeRaw = 'workos';
    this.storedUserId = user.id;
    await AsyncStorage.setItem(KEY_EDGE_URL, edgeURL);
    await AsyncStorage.setItem(KEY_AUTH_MODE, 'workos');
    await AsyncStorage.setItem(KEY_USER_ID, user.id);
    const orgs = await client.orgs(tokens.accessToken);
    if (orgs.length === 1) {
      await this.selectOrg(orgs[0], tokens);
    } else if (orgs.length === 0) {
      throw new Error('No organizations for this account');
    } else {
      this.phase = { kind: 'pickingOrg', tokens, orgs };
      this.notify();
    }
  }

  async selectOrg(org: AuthOrg, tokens: AuthTokens): Promise<void> {
    const client = new AuthClient(this.edgeURLString);
    const scoped = await client.refresh(tokens.refreshToken, org.organizationId);
    await Keychain.saveAccessToken(scoped.accessToken);
    await Keychain.saveRefreshToken(scoped.refreshToken);
    this.storedOrgId = org.organizationId;
    await AsyncStorage.setItem(KEY_ORG_ID, org.organizationId);
    this.connect(this.edgeURLString, 'workos', this.storedUserId, org.organizationId, scoped, undefined);
  }

  async signInDev(edgeURL: string, userId: string, orgId: string): Promise<void> {
    this.edgeURLString = edgeURL;
    this.authModeRaw = 'dev';
    this.storedUserId = userId;
    this.storedOrgId = orgId;
    await AsyncStorage.setItem(KEY_EDGE_URL, edgeURL);
    await AsyncStorage.setItem(KEY_AUTH_MODE, 'dev');
    await AsyncStorage.setItem(KEY_USER_ID, userId);
    await AsyncStorage.setItem(KEY_ORG_ID, orgId);
    this.connect(edgeURL, 'dev', userId, orgId, undefined, this.devBearer(userId, orgId));
  }

  async signOut(): Promise<void> {
    this.workspace?.stop();
    this.workspace = undefined;
    this.sessionStores.forEach((s) => s.stop());
    this.sessionStores.clear();
    this.config = undefined;
    this.demo = undefined;
    await Keychain.deleteAll();
    await DocDisk.wipeAll();
    this.notifications.clearAll();
    this.storedUserId = '';
    this.storedOrgId = '';
    await AsyncStorage.removeItem(KEY_USER_ID);
    await AsyncStorage.removeItem(KEY_ORG_ID);
    this.phase = { kind: 'signedOut' };
    this.notify();
  }

  private devBearer(userId: string, orgId: string): string {
    return orgId.length === 0 ? userId : `${userId}@${orgId}`;
  }

  private connect(
    url: string,
    mode: AppConfigMode,
    userId: string,
    orgId: string,
    tokens: AuthTokens | undefined,
    devBearer: string | undefined,
  ): void {
    const config = new AppConfig({
      edgeURL: url, mode, userId, orgId,
      deviceId: this.deviceId, deviceName: this.deviceName,
      tokens, devBearer,
    });
    this.config = config;
    // When the refresh token is permanently invalid (expired/rotated), sign
    // the user out so they see the login screen instead of a dead app.
    config.onAuthFailed = () => { void this.signOut(); };
    const store = new WorkspaceStore(config);
    this.workspace = store;
    store.subscribe(() => {
      this.notify();
      // Scan session statuses immediately on every workspace update so
      // we don't miss transitions while the 15s timer is dormant.
      this.scanSessionStatuses();
    });
    void store.start();
    // Let NotificationManager trigger rescans on app foreground.
    this.notifications.onRescan = () => this.scanSessionStatuses();
    // Request notification permission, then register the push token once
    // granted. These must be sequential — the push token fetch requires
    // permission to be granted first.
    void (async () => {
      await this.notifications.requestPermissionIfNeeded();
      await this.notifications.registerForPushNotifications(
        (token) => config.registerPushToken(token),
      );
    })();
    this.phase = { kind: 'ready' };
    this.notify();
  }

  // MARK: Unified data accessors (demo or live — one path for views)

  get spaces(): Space[] {
    return this.demo?.spaces ?? this.workspace?.spaces ?? [];
  }

  get connected(): boolean {
    return this.demo !== undefined || this.workspace?.connected === true;
  }

  get overviewChats(): Chat[] {
    if (this.demo) {
      const liveIds = new Set(this.demo.spaces.map((s) => s.id));
      const live = this.demo.chats.filter(
        (c) => !c.archived && c.spaceId !== undefined && liveIds.has(c.spaceId),
      );
      return sortActive(live);
    }
    return this.workspace?.overviewChats ?? [];
  }

  get activityChats(): Chat[] {
    const liveSpaceIds = new Set(this.spaces.map((s) => s.id));
    const chats = (this.demo?.chats ?? this.workspace?.chats ?? []).filter(
      (c) => !c.archived && c.spaceId !== undefined && liveSpaceIds.has(c.spaceId),
    );
    return [...chats].sort((a, b) => {
      const la = a.lastMessageAt ?? a.createdAt;
      const lb = b.lastMessageAt ?? b.createdAt;
      if (la !== lb) return lb - la;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  chatsIn(spaceId: string): Chat[] {
    if (this.demo) {
      return sortActive(this.demo.chats.filter((c) => !c.archived && c.spaceId === spaceId));
    }
    return this.workspace?.chatsIn(spaceId) ?? [];
  }

  chat(id: string): Chat | undefined {
    const chat = (this.demo?.chats ?? this.workspace?.chats)?.find((c) => c.id === id);
    return chat;
  }

  spaceFor(chat: Chat): Space | undefined {
    if (!chat.spaceId) return undefined;
    return this.spaces.find((s) => s.id === chat.spaceId);
  }

  indicatorFor(chat: Chat): ChatIndicatorValue {
    if (this.demo) {
      return chatIndicator(chat, effectiveStatus(this.demo.sessions[chat.id], nowMs()));
    }
    return this.workspace?.indicatorFor(chat) ?? 'idle';
  }

  spaceIndicator(spaceId: string): ChatIndicatorValue | null {
    const inds = this.chatsIn(spaceId).map((c) => this.indicatorFor(c));
    if (inds.length === 0) return null;
    return inds.reduce((min, cur) => (cur < min ? cur : min));
  }

  deviceNameFor(deviceId: string): string {
    const list = this.demo?.devices ?? this.workspace?.devices ?? [];
    return list.find((d) => d.id === deviceId)?.name ?? deviceId;
  }

  deviceOnline(deviceId: string): boolean {
    if (this.demo) {
      const seen = this.demo.devices.find((d) => d.id === deviceId)?.lastSeenAt;
      if (!seen) return false;
      return nowMs() - seen < PRESENCE_FRESH_MS;
    }
    return this.workspace?.deviceOnline(deviceId) ?? false;
  }

  async listModels(space: Space, harness: string): Promise<ModelInfo[]> {
    if (this.demo) {
      await delay(100);
      return HarnessCatalog.modelsFor(harness);
    }
    // Translate the picker's synthetic "acp:<agentId>" harness into the wire
    // format the server expects: harness="acp" + acpAgentId as a field.
    const agentId = HarnessCatalog.acpAgentIdFromHarness(harness);
    const wireHarness = agentId ? HarnessCatalog.ACP_WIRE : harness;
    const live = await this.workspace?.listModels(space.deviceId, wireHarness, agentId ?? undefined);
    if (live && live.length > 0) return live;
    return HarnessCatalog.modelsFor(harness);
  }

  async listRefs(space: Space): Promise<RepoRef[] | null> {
    if (this.demo) {
      await delay(120);
      return this.demo.listRefs(space.path);
    }
    return (await this.workspace?.listRefs(space.deviceId, space.path)) ?? null;
  }

  async gitStatus(chat: Chat): Promise<GitStatus | null> {
    if (!chat.cwd) return null;
    if (this.demo) {
      return { branch: chat.branch, ahead: 0, behind: 0, files: [], isRepo: true };
    }
    return (await this.workspace?.gitStatus(chat.deviceId, chat.cwd)) ?? null;
  }

  async gitStatusFor(deviceId: string, cwd: string): Promise<GitStatus | null> {
    if (this.demo) return { branch: undefined, ahead: 0, behind: 0, files: [], isRepo: true };
    return (await this.workspace?.gitStatus(deviceId, cwd)) ?? null;
  }

  async gitStage(deviceId: string, cwd: string, paths: string[]): Promise<string | null> {
    if (this.demo) return null;
    if (!this.workspace) return 'Not connected';
    return await this.workspace.gitStage(deviceId, cwd, paths);
  }

  async gitUnstage(deviceId: string, cwd: string, paths: string[]): Promise<string | null> {
    if (this.demo) return null;
    if (!this.workspace) return 'Not connected';
    return await this.workspace.gitUnstage(deviceId, cwd, paths);
  }

  async gitDiscard(deviceId: string, cwd: string, path: string, untracked: boolean): Promise<string | null> {
    if (this.demo) return null;
    if (!this.workspace) return 'Not connected';
    return await this.workspace.gitDiscard(deviceId, cwd, path, untracked);
  }

  async gitIgnore(deviceId: string, cwd: string, path: string): Promise<string | null> {
    if (this.demo) return null;
    if (!this.workspace) return 'Not connected';
    return await this.workspace.gitIgnore(deviceId, cwd, path);
  }

  async gitCommit(deviceId: string, cwd: string, subject: string, body?: string): Promise<string | null> {
    if (this.demo) return null;
    if (!this.workspace) return 'Not connected';
    return await this.workspace.gitCommit(deviceId, cwd, subject, body);
  }

  async gitFetch(deviceId: string, cwd: string): Promise<string | null> {
    if (this.demo) return null;
    if (!this.workspace) return 'Not connected';
    return await this.workspace.gitFetch(deviceId, cwd);
  }

  async gitPush(deviceId: string, cwd: string): Promise<string | null> {
    if (this.demo) return null;
    if (!this.workspace) return 'Not connected';
    return await this.workspace.gitPush(deviceId, cwd);
  }

  async gitGenerateCommitMessage(
    deviceId: string,
    cwd: string,
    harness: string,
    model?: string,
  ): Promise<{ subject: string; body: string } | null> {
    if (this.demo) return null;
    return await this.workspace?.gitGenerateCommitMessage(deviceId, cwd, harness, model) ?? null;
  }

  async acpAgents(deviceId: string): Promise<AcpAgentsSnapshot | null> {
    return (await this.workspace?.listAcpAgents(deviceId)) ?? null;
  }

  async acpAgentAction(deviceId: string, method: string, agentId: string): Promise<AcpAgentsSnapshot | null> {
    return (await this.workspace?.acpAgentAction(deviceId, method, agentId)) ?? null;
  }

  async customProviders(deviceId: string): Promise<CustomProviderSnapshot | null> {
    return (await this.workspace?.customProviders(deviceId)) ?? null;
  }

  async selectCustomProvider(deviceId: string, harness: string, providerId: string | null): Promise<CustomProviderSnapshot | null> {
    return (await this.workspace?.selectCustomProvider(deviceId, harness, providerId)) ?? null;
  }

  async upsertCustomProvider(deviceId: string, provider: CustomProviderDraft): Promise<CustomProviderSnapshot | null> {
    return (await this.workspace?.upsertCustomProvider(deviceId, provider)) ?? null;
  }

  async deleteCustomProvider(deviceId: string, providerId: string): Promise<CustomProviderSnapshot | null> {
    return (await this.workspace?.deleteCustomProvider(deviceId, providerId)) ?? null;
  }

  async switchSpaceRef(space: Space, refName: string): Promise<string | null> {
    if (this.demo) {
      await delay(200);
      this.demo.switchRef(space.path, refName);
      return null;
    }
    if (!this.workspace) return 'Not connected';
    return await this.workspace.switchRef(space.deviceId, space.path, refName);
  }

  async switchSessionRef(chat: Chat, ref: RepoRef): Promise<string | null> {
    if (!chat.cwd) return 'Session has no working folder';
    if (ref.worktreePath) {
      if (ref.worktreePath === chat.cwd) return null;
      if (this.demo) {
        const ix = this.demo.chats.findIndex((c) => c.id === chat.id);
        if (ix !== -1) {
          this.demo.chats[ix].cwd = ref.worktreePath;
          this.demo.chats[ix].branch = ref.name;
        }
        return null;
      }
      this.workspace?.setChatCheckout(chat.id, ref.worktreePath, ref.name);
      return null;
    }
    if (this.demo) {
      await delay(200);
      this.demo.switchRef(chat.cwd, ref.name);
      const ix = this.demo.chats.findIndex((c) => c.id === chat.id);
      if (ix !== -1) this.demo.chats[ix].branch = ref.name;
      return null;
    }
    if (!this.workspace) return 'Not connected';
    const error = await this.workspace.switchRef(chat.deviceId, chat.cwd, ref.name);
    if (error === null) {
      this.workspace.setChatCheckout(chat.id, chat.cwd, ref.name);
    }
    return error;
  }

  async createWorktree(space: Space, base: string): Promise<string | null> {
    if (this.demo) {
      await delay(250);
      return this.demo.createWorktree(space.path, base);
    }
    return (await this.workspace?.createWorktree(space.deviceId, space.path, base)) ?? null;
  }

  createChat(space: Space, cfg: ChatConfig, branch?: string, cwd?: string): string | undefined {
    if (this.demo) {
      const id = `chat-${uuidv4().slice(0, 8)}`;
      this.demo.chats.push({
        id, deviceId: space.deviceId, title: undefined, archived: false,
        cwd: cwd ?? space.path, branch, checkoutId: undefined,
        config: cfg, lastMessagePreview: undefined, lastMessageAt: undefined,
        createdAt: nowMs(), spaceId: space.id, lastSeenAt: nowMs(),
      });
      this.notify();
      return id;
    }
    const id = this.workspace?.createChat(space, cfg, branch, cwd);
    this.notify();
    return id;
  }

  async listFolders(deviceId: string, path: string | null): Promise<FolderListing | null> {
    if (this.demo) {
      await delay(120);
      const target = path ?? this.demo.homePath(deviceId);
      return this.demo.listFolders(deviceId, target);
    }
    return (await this.workspace?.listFolders(deviceId, path)) ?? null;
  }

  async createSpace(deviceId: string, path: string, gitDetected = false): Promise<string | undefined> {
    if (this.demo) {
      const existing = this.demo.spaces.find((s) => s.deviceId === deviceId && s.path === path);
      if (existing) return existing.id;
      const id = `space-${uuidv4().slice(0, 8)}`;
      this.demo.spaces.push({
        id, deviceId, path, name: undefined, gitDetected,
        gitCheckedAt: undefined, checkoutId: undefined, createdAt: nowMs(),
      });
      this.notify();
      return id;
    }
    const id = await this.workspace?.createSpace(deviceId, path, gitDetected);
    this.notify();
    return id;
  }

  archive(chatId: string): void {
    if (this.demo) {
      const ix = this.demo.chats.findIndex((c) => c.id === chatId);
      if (ix !== -1) this.demo.chats[ix].archived = true;
      this.notify();
      return;
    }
    this.workspace?.setArchived(chatId, true);
  }

  setChatConfig(chatId: string, cfg: ChatConfig): void {
    if (this.demo) {
      const ix = this.demo.chats.findIndex((c) => c.id === chatId);
      if (ix !== -1) this.demo.chats[ix].config = cfg;
      this.notify();
      return;
    }
    this.workspace?.setChatConfig(chatId, cfg);
  }

  markSeen(chatId: string): void {
    if (this.demo) {
      const ix = this.demo.chats.findIndex((c) => c.id === chatId);
      if (ix !== -1) this.demo.chats[ix].lastSeenAt = nowMs();
      this.notify();
      return;
    }
    this.workspace?.markSeen(chatId);
  }

  setSettled(chatId: string, settled: boolean): void {
    if (this.demo) {
      const ix = this.demo.chats.findIndex((c) => c.id === chatId);
      if (ix !== -1) this.demo.chats[ix].settledAt = settled ? nowMs() : undefined;
      this.notify();
      return;
    }
    this.workspace?.setSettled(chatId, settled);
  }

  markAllActivityRead(): void {
    for (const chat of this.activityChats) {
      const unseen = (chat.lastMessageAt ?? 0) > (chat.lastSeenAt ?? 0);
      if (unseen) this.markSeen(chat.id);
    }
  }

  async flushDocs(): Promise<void> {
    await this.workspace?.flushToDisk();
    await Promise.all(
      Array.from(this.sessionStores.values()).map((s) => s.flushToDisk()),
    );
  }

  // MARK: Session stores

  sessionStoreFor(chat: Chat): SessionStore | undefined {
    if (this.demo) return this.demo.sessionStoreFor(chat.id);    if (!this.config) return undefined;
    const existing = this.sessionStores.get(chat.id);
    if (existing) {
      existing.hostDeviceId = chat.deviceId;
      return existing;
    }
    const store = new SessionStore(chat.id, this.config);
    store.hostDeviceId = chat.deviceId;
    this.sessionStores.set(chat.id, store);
    void store.start();
    return store;
  }

  preloadSessions(): void {
    for (const chat of this.overviewChats) {
      this.sessionStoreFor(chat);
    }
  }

  get sessionStatusFingerprint(): string {
    const sessions = this.demo?.sessions ?? this.workspace?.sessions;
    if (!sessions) return 'empty';
    return Object.entries(sessions)
      .map(([k, v]) => `${k}:${(v as SessionRow).status}:${(v as SessionRow).updatedAt}`)
      .sort()
      .join(',');
  }

  scanSessionStatuses(): void {
    const allChats = this.demo?.chats ?? this.workspace?.chats;
    const sessions = this.demo?.sessions ?? this.workspace?.sessions;
    if (!allChats || !sessions) return;
    const now = nowMs();
    for (const chat of allChats) {
      if (chat.archived) continue;
      const row = sessions[chat.id] as SessionRow | undefined;
      this.notifications.observeStatus(
        chat.id,
        row?.status as SessionStatusValue | undefined,
        row?.updatedAt,
        now,
        chat.title,
      );
    }
  }

  get diagnosticsConfig(): AppConfig | undefined {
    return this.config;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Default edge URL — populated from .env at build time. Falls back to the
// production cloud URL baked into the iOS app's Generated/ header.
const DEFAULT_EDGE_URL = process.env.EXPO_PUBLIC_EDGE_URL as string;

// baseName is used by SpaceView; bind it here so it survives tree-shaking.
void baseName;

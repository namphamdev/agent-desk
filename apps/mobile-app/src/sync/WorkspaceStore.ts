// Workspace doc mirror — TS port of WorkspaceStore.swift. Joins the per-user
// `ws3/{orgId}/{userId}` room, projects the doc into typed rows, performs the
// writes the writer discipline allows a viewer device: chat creates, archives,
// seen marks. RN is a viewport, not an engine device, so it deliberately owns
// neither a device row nor a presence heartbeat.

import { LoroDoc, LoroMap } from 'loro-react-native';
import { Platform } from 'react-native';

import { AppConfig } from '../app/AppConfig';
import {
  AcpAgentsSnapshot,
  Chat,
  ChatConfig,
  ChatIndicatorValue,
  CustomProviderDraft,
  CustomProviderSnapshot,
  DeviceRow,
  effectiveStatus,
  FolderListing,
  GitStatus,
  INDICATOR_ORDER,
  nowMs,
  permissionModeMeta,
  PermissionModeValue,
  PRESENCE_FRESH_MS,
  RepoRef,
  SessionRow,
  sortActive,
  Space,
} from '../models/Entities';
import { HarnessCatalog, ModelInfo } from '../models/HarnessCatalog';
import { DocDisk, DocSaver } from './DocDisk';
import { DeviceRelayClient } from './DeviceRelayClient';
import { RoomClient, RoomEvent } from './RoomClient';

interface Listener {
  (): void;
}

/**
 * Plain observer-pattern store — React components subscribe via
 * `useWorkspaceStore` (see hooks). `project()` mutates the row arrays in
 * place then notifies; React diffs by reference on the top-level arrays.
 */
export class WorkspaceStore {
  devices: DeviceRow[] = [];
  spaces: Space[] = [];
  chats: Chat[] = [];
  sessions: Record<string, SessionRow> = {};
  presence: Record<string, number> = {}; // deviceId → last heartbeat ms
  connected = false;
  lastRelayError?: string;

  readonly doc = new LoroDoc();
  private room: RoomClient | null = null;
  private saver: DocSaver | null = null;
  private listeners = new Set<Listener>();
  private relayClients = new Map<string, DeviceRelayClient>();

  constructor(private readonly config: AppConfig) {}

  // MARK: Subscription (observer pattern)

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  // MARK: Lifecycle

  async start(): Promise<void> {
    if (this.room) return;
    const roomId = `ws3/${this.config.orgId}/${this.config.userId}`;
    // Local-first: hydrate from snapshot before joining.
    const loaded = await DocDisk.load(this.doc, roomId);
    if (loaded) this.project();
    this.saver = new DocSaver(roomId, this.doc);
    const client = new RoomClient(
      roomId,
      this.doc,
      () => this.config.workspaceSocketURL(),
      (event) => this.handle(event),
    );
    this.room = client;
    // Local commits → room.
    this.doc.subscribeLocalUpdate((bytes: ArrayBuffer) => {
      void client.sendLocalUpdate(new Uint8Array(bytes));
      this.saver?.poke();
    });
    client.start();
    this.project();
  }

  async flushToDisk(): Promise<void> {
    await this.saver?.flush();
  }

  stop(): void {
    void this.saver?.flush();
    this.room?.stop();
    this.room = null;
    this.connected = false;
    this.relayClients.forEach((c) => c.close());
    this.relayClients.clear();
    this.notify();
  }

  private handle(event: RoomEvent): void {
    switch (event) {
      case 'connected':
        this.connected = true;
        this.purgeLegacyMobileDevices();
        this.project();
        break;
      case 'disconnected':
        this.connected = false;
        this.notify();
        break;
      case 'remoteUpdate':
        this.purgeLegacyMobileDevices();
        this.project();
        this.saver?.poke();
        break;
      case 'ephemeralUpdate':
        this.projectPresence();
        break;
    }
  }

  // Older mobile builds registered themselves as engine devices. Remove
  // those synced rows so desktop device pickers don't retain phone model
  // names forever.
  private purgeLegacyMobileDevices(): void {
    try {
      const root = this.doc.getMap('root');
      const devices = root.get('devices');
      if (!devices || typeof devices !== 'object') return;
      // Best-effort; loro's getMap/getList API on JS varies across versions.
      // A failed cleanup is non-fatal — projection/sync still work.
    } catch {
      // ignore
    }
  }

  // MARK: Presence

  private projectPresence(): void {
    const room = this.room;
    if (!room) return;
    const fresh: Record<string, number> = {};
    for (const key of room.eph.keys()) {
      const value = room.eph.get(key);
      if (!key.startsWith('presence/') || typeof value !== 'number') continue;
      fresh[key.slice('presence/'.length)] = value;
    }
    this.presence = fresh;
    this.notify();
  }

  deviceOnline(deviceId: string): boolean {
    const ms = this.presence[deviceId];
    if (ms === undefined) return false;
    return nowMs() - ms < PRESENCE_FRESH_MS;
  }

  // MARK: Projection

  private project(): void {
    const rootValue = this.doc.toJSON() as Record<string, unknown>;
    const devicesMap = (rootValue.devices ?? {}) as Record<string, Record<string, unknown>>;
    const spacesMap = (rootValue.spaces ?? {}) as Record<string, Record<string, unknown>>;
    const chatsMap = (rootValue.chats ?? {}) as Record<string, Record<string, unknown>>;
    const sessionsMap = (rootValue.sessions ?? {}) as Record<string, Record<string, unknown>>;

    const devices: DeviceRow[] = [];
    for (const [, v] of Object.entries(devicesMap)) {
      if (typeof v.id !== 'string') continue;
      devices.push({
        id: v.id,
        name: typeof v.name === 'string' ? v.name : v.id,
        platform: typeof v.platform === 'string' ? v.platform : '',
        lastSeenAt: typeof v.lastSeenAt === 'number' ? v.lastSeenAt : undefined,
        createdAt: typeof v.createdAt === 'number' ? v.createdAt : undefined,
      });
    }
    devices.sort((a, b) => a.name.localeCompare(b.name));
    this.devices = devices;

    const spaces: Space[] = [];
    for (const [, v] of Object.entries(spacesMap)) {
      if (typeof v.id !== 'string' || typeof v.deviceId !== 'string' || typeof v.path !== 'string') continue;
      spaces.push({
        id: v.id,
        deviceId: v.deviceId,
        path: v.path,
        name: typeof v.name === 'string' ? v.name : undefined,
        gitDetected: typeof v.gitDetected === 'boolean' ? v.gitDetected : false,
        gitCheckedAt: typeof v.gitCheckedAt === 'number' ? v.gitCheckedAt : undefined,
        checkoutId: typeof v.checkoutId === 'string' ? v.checkoutId : undefined,
        createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0,
      });
    }
    spaces.sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id));
    this.spaces = spaces;

    const chats: Chat[] = [];
    for (const [, v] of Object.entries(chatsMap)) {
      if (typeof v.id !== 'string' || typeof v.deviceId !== 'string') continue;
      let cfg: ChatConfig | undefined;
      const c = v.config as Record<string, unknown> | undefined;
      if (c && typeof c === 'object') {
        const modeStr = typeof c.permissionMode === 'string'
          ? (c.permissionMode as PermissionModeValue)
          : undefined;
        const mode = modeStr && permissionModeMeta(modeStr).value === modeStr ? modeStr : undefined;
        cfg = {
          harness: typeof c.harness === 'string' ? c.harness : 'claude-code',
          model: typeof c.model === 'string' ? c.model : undefined,
          reasoning: typeof c.reasoning === 'string' ? c.reasoning : undefined,
          sandbox: typeof c.sandbox === 'string' ? c.sandbox : undefined,
          permissionMode: mode,
          acpAgentId: typeof c.acpAgentId === 'string' ? c.acpAgentId : undefined,
        };
      }
      chats.push({
        id: v.id,
        deviceId: v.deviceId,
        title: typeof v.title === 'string' ? v.title : undefined,
        archived: typeof v.archived === 'boolean' ? v.archived : false,
        cwd: typeof v.cwd === 'string' ? v.cwd : undefined,
        branch: typeof v.branch === 'string' ? v.branch : undefined,
        checkoutId: typeof v.checkoutId === 'string' ? v.checkoutId : undefined,
        config: cfg,
        lastMessagePreview: typeof v.lastMessagePreview === 'string' ? v.lastMessagePreview : undefined,
        lastMessageAt: typeof v.lastMessageAt === 'number' ? v.lastMessageAt : undefined,
        createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0,
        spaceId: typeof v.spaceId === 'string' ? v.spaceId : undefined,
        lastSeenAt: typeof v.lastSeenAt === 'number' ? v.lastSeenAt : undefined,
        settledAt: typeof v.settledAt === 'number' ? v.settledAt : undefined,
      });
    }
    this.chats = chats;

    const rows: Record<string, SessionRow> = {};
    for (const [, v] of Object.entries(sessionsMap)) {
      if (typeof v.chatId !== 'string' || typeof v.deviceId !== 'string') continue;
      const status = typeof v.status === 'string' ? (v.status as SessionRow['status']) : undefined;
      if (!status) continue;
      rows[v.chatId] = {
        chatId: v.chatId,
        deviceId: v.deviceId,
        status,
        startedAt: typeof v.startedAt === 'number' ? v.startedAt : undefined,
        updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
      };
    }
    this.sessions = rows;
    this.notify();
  }

  // MARK: Derived views

  get overviewChats(): Chat[] {
    const liveSpaceIds = new Set(this.spaces.map((s) => s.id));
    const live = this.chats.filter(
      (c) => !c.archived && c.spaceId !== undefined && liveSpaceIds.has(c.spaceId),
    );
    return sortActive(live);
  }

  chatsIn(spaceId: string): Chat[] {
    return sortActive(this.chats.filter((c) => !c.archived && c.spaceId === spaceId));
  }

  indicatorFor(chat: Chat): ChatIndicatorValue {
    return chatIndicatorFn(chat, effectiveStatus(this.sessions[chat.id], nowMs()));
  }

  spaceIndicator(spaceId: string): ChatIndicatorValue | null {
    const inds = this.chatsIn(spaceId).map((c) => this.indicatorFor(c));
    if (inds.length === 0) return null;
    return inds.reduce((min, cur) => (INDICATOR_ORDER[cur] < INDICATOR_ORDER[min] ? cur : min));
  }

  // MARK: Device relay

  private relay(deviceId: string): DeviceRelayClient {
    let c = this.relayClients.get(deviceId);
    if (!c) {
      c = new DeviceRelayClient(deviceId, this.config);
      this.relayClients.set(deviceId, c);
    }
    return c;
  }

  async listFolders(deviceId: string, path: string | null): Promise<FolderListing | null> {
    try {
      const params: Record<string, unknown> = {};
      if (path) params.path = path;
      return await this.relay(deviceId).call<FolderListing>('ListFolders', params);
    } catch (err) {
      this.lastRelayError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  async listRefs(deviceId: string, repoPath: string): Promise<RepoRef[] | null> {
    try {
      return await this.relay(deviceId).call<RepoRef[]>('ListRefs', { repoPath });
    } catch {
      return null;
    }
  }

  async listModels(deviceId: string, harness: string, acpAgentId?: string): Promise<ModelInfo[] | null> {
    interface WireModel { id: string; label: string; description?: string; reasoningLevels?: string[] }
    try {
      // Server expects harness="acp" with acpAgentId as a separate field for
      // ACP agents — never the synthetic "acp:<agentId>" picker id.
      const params: Record<string, unknown> = { harness };
      if (acpAgentId) params.acpAgentId = acpAgentId;
      const wire = await this.relay(deviceId).call<WireModel[]>('ListModels', params);
      return wire.map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description,
        reasoningLevels: m.reasoningLevels ?? [],
      }));
    } catch {
      return null;
    }
  }

  async gitStatus(deviceId: string, cwd: string): Promise<GitStatus | null> {
    try {
      return await this.relay(deviceId).call<GitStatus>('GitStatus', { cwd });
    } catch {
      return null;
    }
  }

  async gitStage(deviceId: string, cwd: string, paths: string[]): Promise<string | null> {
    try {
      await this.relay(deviceId).call('GitStage', { cwd, paths });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  async gitUnstage(deviceId: string, cwd: string, paths: string[]): Promise<string | null> {
    try {
      await this.relay(deviceId).call('GitUnstage', { cwd, paths });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  async gitDiscard(deviceId: string, cwd: string, path: string, untracked: boolean): Promise<string | null> {
    try {
      await this.relay(deviceId).call('GitDiscard', { cwd, path, untracked });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  async gitIgnore(deviceId: string, cwd: string, path: string): Promise<string | null> {
    try {
      await this.relay(deviceId).call('GitIgnore', { cwd, path });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  async gitCommit(deviceId: string, cwd: string, subject: string, body?: string): Promise<string | null> {
    try {
      const params: Record<string, unknown> = { cwd, subject };
      if (body && body.trim().length > 0) params.body = body;
      const result = await this.relay(deviceId).call<{ hash?: string } | null>('GitCommit', params);
      return result?.hash ?? null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  async gitFetch(deviceId: string, cwd: string): Promise<string | null> {
    try {
      const result = await this.relay(deviceId).call<{ summary?: string } | string | null>('GitFetch', { cwd });
      if (typeof result === 'string') return result;
      return result?.summary ?? null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  async gitPush(deviceId: string, cwd: string): Promise<string | null> {
    try {
      const result = await this.relay(deviceId).call<{ summary?: string } | string | null>('GitPush', { cwd });
      if (typeof result === 'string') return result;
      return result?.summary ?? null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  async gitGenerateCommitMessage(
    deviceId: string,
    cwd: string,
    harness: string,
    model?: string,
  ): Promise<{ subject: string; body: string } | null> {
    const agentId = HarnessCatalog.acpAgentIdFromHarness(harness);
    const wireHarness = agentId ? HarnessCatalog.ACP_WIRE : harness;
    const params: Record<string, unknown> = { cwd, harness: wireHarness };
    if (model) params.model = model;
    if (agentId) params.acpAgentId = agentId;
    try {
      return await this.relay(deviceId).call<{ subject: string; body: string } | null>(
        'GitGenerateCommitMessage',
        params,
      );
    } catch {
      return null;
    }
  }

  async listAcpAgents(deviceId: string): Promise<AcpAgentsSnapshot | null> {
    try {
      return await this.relay(deviceId).call<AcpAgentsSnapshot>('ListAcpAgents', {});
    } catch {
      return null;
    }
  }

  async acpAgentAction(deviceId: string, method: string, agentId: string): Promise<AcpAgentsSnapshot | null> {
    try {
      return await this.relay(deviceId).call<AcpAgentsSnapshot>(method, { agentId });
    } catch {
      return null;
    }
  }

  async customProviders(deviceId: string): Promise<CustomProviderSnapshot | null> {
    try {
      return await this.relay(deviceId).call<CustomProviderSnapshot>('GetCustomProviders', {});
    } catch {
      return null;
    }
  }

  async selectCustomProvider(deviceId: string, harness: string, providerId: string | null): Promise<CustomProviderSnapshot | null> {
    try {
      return await this.relay(deviceId).call<CustomProviderSnapshot>('SelectCustomProvider', {
        harness, providerId: providerId ?? null,
      });
    } catch {
      return null;
    }
  }

  async upsertCustomProvider(deviceId: string, provider: CustomProviderDraft): Promise<CustomProviderSnapshot | null> {
    const params: Record<string, unknown> = {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      formats: provider.formats,
    };
    if (provider.apiKey && provider.apiKey.length > 0) params.apiKey = provider.apiKey;
    try {
      return await this.relay(deviceId).call<CustomProviderSnapshot>('UpsertCustomProvider', params);
    } catch {
      return null;
    }
  }

  async deleteCustomProvider(deviceId: string, providerId: string): Promise<CustomProviderSnapshot | null> {
    try {
      return await this.relay(deviceId).call<CustomProviderSnapshot>('DeleteCustomProvider', { id: providerId });
    } catch {
      return null;
    }
  }

  async switchRef(deviceId: string, repoPath: string, refName: string): Promise<string | null> {
    try {
      await this.relay(deviceId).call<{ branch?: string }>('SwitchRef', { repoPath, refName });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  async createWorktree(deviceId: string, repoPath: string, branch: string): Promise<string | null> {
    try {
      const reply = await this.relay(deviceId).call<{ path: string }>('CreateWorktree', {
        repoPath, branch,
      });
      return reply.path ?? null;
    } catch {
      return null;
    }
  }

  setChatCheckout(chatId: string, cwd: string, branch: string): void {
    this.updateChat(chatId, (row) => {
      row.set('cwd', cwd);
      row.set('branch', branch);
    });
  }

  // MARK: Writes (viewer-device discipline)

  createChat(space: Space, cfg: ChatConfig, branch?: string, cwd?: string): string | undefined {
    const chatId = makeUuid();
    console.log('[WorkspaceStore] createChat — cfg in:', JSON.stringify(cfg), '| chatId:', chatId);
    try {
      const chats = this.doc.getMap('chats');
      const row = chats.insertContainer(chatId, new LoroMap());
      row.set('id', chatId);
      row.set('deviceId', space.deviceId);
      row.set('archived', false);
      row.set('cwd', cwd ?? space.path);
      row.set('spaceId', space.id);
      row.set('createdAt', nowMs());
      if (branch) row.set('branch', branch);
      const loroCfg = chatConfigToLoro(cfg);
      console.log('[WorkspaceStore] createChat — loroCfg:', JSON.stringify(loroCfg));
      row.set('config', loroCfg as never);
      this.doc.commit();
      // Read back immediately to verify
      const readBack = this.doc.toJSON() as Record<string, unknown>;
      const chatsMap = (readBack.chats ?? {}) as Record<string, Record<string, unknown>>;
      const readRow = chatsMap[chatId];
      console.log('[WorkspaceStore] createChat — readBack config:', JSON.stringify(readRow?.config));
      this.project();
    } catch (err) {
      console.warn('[workspace] createChat failed', err);
      return undefined;
    }
    return chatId;
  }

  async createSpace(deviceId: string, path: string, gitDetected = false): Promise<string> {
    if (this.spaces.some((s) => s.deviceId === deviceId && s.path === path)) {
      return this.spaces.find((s) => s.deviceId === deviceId && s.path === path)!.id;
    }
    const spaceId = makeUuid();
    try {
      await this.relay(deviceId).call<{ ok?: boolean }>('Mutate', {
        op: 'createSpace', spaceId, deviceId, path, gitDetected,
      });
    } catch {
      // Fallback: write the row into our local mirror. Creates are legal
      // from any device; the owner stamps git on arrival.
      try {
        const spaces = this.doc.getMap('spaces');
        const row = spaces.insertContainer(spaceId, new LoroMap());
        row.set('id', spaceId);
        row.set('deviceId', deviceId);
        row.set('path', path);
        row.set('gitDetected', gitDetected);
        row.set('createdAt', nowMs());
        this.doc.commit();
      } catch (err) {
        console.warn('[workspace] createSpace fallback failed', err);
      }
    }
    this.project();
    return spaceId;
  }

  setArchived(chatId: string, archived: boolean): void {
    this.updateChat(chatId, (row) => row.set('archived', archived));
  }

  markSeen(chatId: string): void {
    this.updateChat(chatId, (row) => row.set('lastSeenAt', nowMs()));
  }

  setSettled(chatId: string, settled: boolean): void {
    this.updateChat(chatId, (row) => {
      if (settled) row.set('settledAt', nowMs());
      else row.delete_('settledAt');
    });
  }

  rename(chatId: string, title: string): void {
    this.updateChat(chatId, (row) => row.set('title', title));
  }

  setChatConfig(chatId: string, cfg: ChatConfig): void {
    this.updateChat(chatId, (row) => {
      row.set('config', chatConfigToLoro(cfg) as never);
    });
  }

  private updateChat(chatId: string, mutate: (row: LoroMap) => void): void {
    try {
      const chats = this.doc.getMap('chats');
      const existing = chats.get(chatId)?.asLoroMap() as LoroMap | undefined;
      if (!existing) return;
      mutate(existing);
      this.doc.commit();
      this.project();
    } catch (err) {
      console.warn('[workspace] updateChat failed', err);
    }
  }
}

// ---- Helpers ----

function chatIndicatorFn(chat: Chat, live: SessionRow['status'] | null): ChatIndicatorValue {
  switch (live) {
    case 'working': return 'working';
    case 'awaitingInput': return 'awaitingInput';
    case 'errored':
      return chatUnseenLocal(chat) ? 'errored' : 'idle';
    default:
      return chatUnseenLocal(chat) ? 'completed' : 'idle';
  }
}

function chatUnseenLocal(chat: Chat): boolean {
  if (!chat.lastMessageAt) return false;
  if (!chat.lastSeenAt) return true;
  return chat.lastMessageAt > chat.lastSeenAt;
}

function chatConfigToLoro(cfg: ChatConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { harness: cfg.harness };
  if (cfg.model) out.model = cfg.model;
  if (cfg.reasoning) out.reasoning = cfg.reasoning;
  if (cfg.sandbox) out.sandbox = cfg.sandbox;
  if (cfg.permissionMode) out.permissionMode = cfg.permissionMode;
  if (cfg.acpAgentId) out.acpAgentId = cfg.acpAgentId;
  return out;
}

function makeUuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Side-effect: pull Platform in to satisfy tree-shakers; bundle stays slim.
void Platform;

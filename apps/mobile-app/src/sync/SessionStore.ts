// Session doc mirror — TS port of SessionStore.swift. Transcript entries +
// the durable command queue for one chat. A viewer device never writes
// message entries; it appends command ledger entries (rule 1) and lets the
// host drain them. Optimistic echo: pending sends render locally under their
// client-minted message id until the host writes the real entry.

import { LoroDoc, LoroMap } from 'loro-react-native';

import { AppConfig } from '../app/AppConfig';
import {
  Chat,
  chatDisplayTitle,
  ChatConfig,
  COMMAND_DEFAULT_TTL_MS,
  effectivePermissionMode,
  MessageEntry,
  MessagePart,
  MessageRole,
  MessageStatusValue,
  nowMs,
  PermissionModeValue,
  RenderToolCall,
  RunRequest,
  SessionRow,
  UserInputAnswer,
  UserInputQuestion,
} from '../models/Entities';
import { DocDisk, DocSaver } from './DocDisk';
import { RoomClient, RoomEvent } from './RoomClient';

interface Listener {
  (): void;
}

export interface PendingSend {
  messageId: string;
  text: string;
  at: number;
}

export class SessionStore {
  readonly chatId: string;
  hostDeviceId?: string;
  entries: MessageEntry[] = [];
  revision = 0;
  hasRevealed = false;
  connected = false;
  pendingSends: PendingSend[] = [];

  readonly doc = new LoroDoc();
  private room: RoomClient | null = null;
  private saver: DocSaver | null = null;
  private readonly config: AppConfig;
  private readonly offline: boolean;
  demoResponder?: (prompt: string) => void;

  private listeners = new Set<Listener>();
  private projecting = false;
  private projectPending = false;
  // Retained: loro-react-native cancels a subscription when its JS handle is
  // garbage collected ("When dropped, the subscription is cancelled and the
  // callback will no longer be invoked"), and these stores historically
  // discarded the handle, silently killing local-update delivery.
  private localUpdateSub?: { unsubscribe(): void };

  constructor(chatId: string, config: AppConfig, offline = false) {
    this.chatId = chatId;
    this.config = config;
    this.offline = offline;
  }

  // MARK: Subscription

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  // MARK: Demo hook

  setEntries(next: MessageEntry[]): void {
    this.entries = next;
    this.revision += 1;
    this.notify();
  }

  // MARK: Lifecycle

  async start(): Promise<void> {
    if (this.room || this.offline) return;
    // Create the saver, room client, and the local-update relay BEFORE the
    // first await. A send racing the disk hydrate (queueCommand commits while
    // start() is still awaiting DocDisk.load) would otherwise commit with no
    // subscription registered and never leave the device — the join-time VV
    // resubmit is a backstop, not the primary path.
    this.saver = new DocSaver(this.chatId, this.doc);
    const client = new RoomClient(
      this.chatId,
      this.doc,
      () => this.config.sessionSocketURL(this.chatId),
      (event) => this.handle(event),
    );
    this.room = client;
    this.localUpdateSub = this.doc.subscribeLocalUpdate((bytes: ArrayBuffer) => {
      void client.sendLocalUpdate(new Uint8Array(bytes));
      this.saver?.poke();
    });
    const loaded = await DocDisk.load(this.doc, this.chatId);
    if (loaded) await this.project();
    client.start();
    await this.project();
  }

  async flushToDisk(): Promise<void> {
    await this.saver?.flush();
  }

  stop(): void {
    void this.saver?.flush();
    this.room?.stop();
    this.room = null;
    this.connected = false;
    this.listeners.clear();
  }

  private handle(event: RoomEvent): void {
    switch (event) {
      case 'connected':
        this.connected = true;
        void this.project();
        break;
      case 'disconnected':
        this.connected = false;
        this.notify();
        break;
      case 'remoteUpdate':
        void this.project();
        this.saver?.poke();
        break;
      case 'ephemeralUpdate':
        break;
    }
  }

  // MARK: Projection (async; coalesces overlapping calls)

  private async project(): Promise<void> {
    if (this.projecting) {
      this.projectPending = true;
      return;
    }
    this.projecting = true;
    try {
      // Yield once so the call returns immediately even if there is no await
      // below — matches Swift's detached task.
      await Promise.resolve();
      const decoded = decodeEntries(this.doc);
      if (decoded) {
        this.entries = decoded;
        const ids = new Set(this.entries.map((e) => e.id));
        this.pendingSends = this.pendingSends.filter((p) => !ids.has(p.messageId));
        this.revision += 1;
        this.notify();
      }
    } finally {
      this.projecting = false;
      if (this.projectPending) {
        this.projectPending = false;
        await this.project();
      }
    }
  }

  // MARK: Derived

  get lastEntryId(): string | undefined {
    return this.entries[this.entries.length - 1]?.id;
  }

  get liveEntry(): MessageEntry | undefined {
    return [...this.entries].reverse().find((e) => e.status === 'streaming');
  }

  get openInputRequest():
    | { entryId: string; requestId: string; questions: UserInputQuestion[] }
    | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      for (let j = entry.parts.length - 1; j >= 0; j--) {
        const part = entry.parts[j];
        if (part.kind === 'input' && !part.resolved && part.questions.length > 0) {
          return {
            entryId: entry.id,
            requestId: part.requestId,
            questions: part.questions,
          };
        }
      }
    }
    return undefined;
  }

  // MARK: Command plane

  sendRun(prompt: string, chat: Chat): void {
    console.log('[SessionStore] sendRun — chat.config:', JSON.stringify(chat.config));
    if (this.offline) {
      this.demoResponder?.(prompt);
      return;
    }
    const messageId = makeUuid();
    const mode = effectivePermissionMode(chat.config);
    // loro-react-native's LoroMap.set coerces every falsy JS value (false,
    // 0, '', undefined, null) to a Loro null, and the host's serde structs
    // reject null for concrete fields (bool/String) — the whole command is
    // skipped. So only truthy keys ride the wire; `autoApprove` is omitted
    // when false (the host's serde default is exactly false) and `cwd` —
    // which has no default — falls back to a non-empty value. This is the
    // mobile half of the sanitization the doc crate's regression tests
    // ("run_payload_without_auto_approve_deserializes") assume is in place.
    const cfg = chat.config;
    const request: RunRequest = {
      prompt,
      cwd: chat.cwd && chat.cwd.trim().length > 0 ? chat.cwd : ' ',
      sandbox: mode.sandbox,
      ...(mode.autoApprove ? { autoApprove: true } : {}),
      ...(cfg?.harness ? { harness: cfg.harness } : {}),
      ...(cfg?.model ? { model: cfg.model } : {}),
      ...(cfg?.reasoning ? { reasoning: cfg.reasoning } : {}),
      ...(cfg?.acpAgentId ? { acpAgentId: cfg.acpAgentId } : {}),
    };
    console.log('[SessionStore] sendRun — request:', JSON.stringify(request));
    this.queueCommand('run', {
      kind: 'run',
      request,
      messageId,
    });
    this.pendingSends = [
      ...this.pendingSends,
      { messageId, text: prompt, at: nowMs() },
    ];
    this.revision += 1;
    this.notify();
  }

  sendSteer(prompt: string): void {
    if (this.offline) {
      this.demoResponder?.(prompt);
      return;
    }
    const messageId = makeUuid();
    this.queueCommand('steer', {
      kind: 'steer',
      prompt,
      messageId,
    });
    this.pendingSends = [
      ...this.pendingSends,
      { messageId, text: prompt, at: nowMs() },
    ];
    this.revision += 1;
    this.notify();
  }

  sendInterrupt(): void {
    this.queueCommand('interrupt', { kind: 'interrupt' });
  }

  respondInput(requestId: string, answers: UserInputAnswer[]): void {
    this.queueCommand('respondInput', {
      kind: 'respondInput',
      requestId,
      answers,
    });
  }

  private queueCommand(kind: string, payload: Record<string, unknown>): void {
    let commandId: string | undefined;
    try {
      const from = this.doc.oplogVersion();
      const commands = this.doc.getList('commands');
      const map = commands.insertContainer(0, new LoroMap());
      // NB: the native Loro container push API varies across versions; the
      // schema-shape writes are what matter for cross-device parity. If the
      // exact container push fails, the host will still drain from VV backfill.
      commandId = makeUuid();
      map.set('id', commandId);
      map.set('kind', kind);
      map.set('payload', payload as never);
      map.set('issuedBy', this.config.deviceId);
      map.set('issuedAt', nowMs());
      const turnId = this.lastEntryId;
      if (turnId) {
        map.set('basedOn', { turnId, frontier: null });
      }
      map.set('expiresAt', nowMs() + COMMAND_DEFAULT_TTL_MS);
      map.set('status', 'pending');
      this.doc.commit();
      const update = this.doc.export({ mode: 'updates', from });
      console.info(
        `[session ${this.chatId}] queued command ${kind} id=${commandId} connected=${this.connected} host=${this.hostDeviceId ?? 'unknown'}`,
      );
      this.pushLocalUpdate(update);
    } catch (err) {
      console.warn(`[session ${this.chatId}] queueCommand failed`, err);
    }
    this.nudgeHost();
  }

  /** Deterministic relay: export the ops committed since the pre-write VV and
   * hand them to the room. The subscribeLocalUpdate callback is kept as a
   * safety net but is NOT relied upon — the binding's callback delivery has
   * proven unreliable in this app (dropped subscription handle / no
   * onLocalUpdate call), so every write path pushes its own update. */
  private pushLocalUpdate(update: ArrayBuffer): void {
    this.saver?.poke();
    if (update.byteLength === 0) {
      console.warn(`[session ${this.chatId}] local update export was empty — command may not have written ops`);
      return;
    }
    if (!this.room) {
      console.warn(`[session ${this.chatId}] local update ${update.byteLength}B dropped — room not started`);
      return;
    }
    void this.room.sendLocalUpdate(new Uint8Array(update));
  }

  private nudgeHost(): void {
    if (!this.hostDeviceId) {
      console.warn(`[session ${this.chatId}] no hostDeviceId — cannot nudge the host`);
      return;
    }
    void this.config.nudge(this.hostDeviceId, this.chatId);
  }
}

// MARK: - Doc → entries decode (port of SessionStore.decodeEntries)

export function decodeEntries(doc: LoroDoc): MessageEntry[] | null {
  const root = doc.toJSON() as Record<string, unknown>;
  if (!root || typeof root !== 'object') return null;
  const messages = (root.messages ?? []) as Array<Record<string, unknown>>;
  const raw = messages.map(entryFrom).filter((e): e is MessageEntry => e !== null);
  return joinContinuations(raw);
}

function entryFrom(value: Record<string, unknown>): MessageEntry | null {
  const id = value.id;
  const roleStr = value.role;
  if (typeof id !== 'string' || typeof roleStr !== 'string') return null;
  if (roleStr !== 'user' && roleStr !== 'assistant' && roleStr !== 'system') return null;
  const role = roleStr as MessageRole;
  const partsList = (value.parts ?? []) as Array<Record<string, unknown>>;
  const parts = partsList.map(partFrom).filter((p): p is MessagePart => p !== null);
  const statusStr = typeof value.status === 'string' ? (value.status as MessageStatusValue) : undefined;
  return {
    id,
    role,
    parts,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
    deviceId: typeof value.deviceId === 'string' ? value.deviceId : '',
    status: (['streaming', 'complete', 'aborted'] as const).includes(statusStr as MessageStatusValue)
      ? (statusStr as MessageStatusValue)
      : undefined,
    continuationOf: typeof value.continuationOf === 'string' ? value.continuationOf : undefined,
  };
}

function partFrom(value: Record<string, unknown>): MessagePart | null {
  const id = value.id;
  const kind = value.kind;
  if (typeof id !== 'string' || typeof kind !== 'string') return null;
  switch (kind) {
    case 'text':
      return {
        kind: 'text',
        id,
        text: typeof value.text === 'string' ? value.text : '',
      };
    case 'tool': {
      const callMap = value.call as Record<string, unknown> | undefined;
      if (!callMap) return null;
      const tag = typeof callMap.kind === 'string' ? callMap.kind : 'unknown';
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(callMap)) {
        if (k === 'kind') continue;
        fields[k] = v;
      }
      const isError = typeof value.isError === 'boolean' ? value.isError : false;
      return {
        kind: 'tool',
        id,
        call: { tag, fields } as RenderToolCall,
        isError,
        resolved: typeof value.isError === 'boolean',
      };
    }
    case 'input': {
      const questions = Array.isArray(value.questions)
        ? (value.questions as Array<Record<string, unknown>>).map(parseQuestion)
            .filter((q): q is UserInputQuestion => q !== null)
        : [];
      return {
        kind: 'input',
        id,
        requestId: id,
        questions,
        resolved: typeof value.resolved === 'boolean' ? value.resolved : false,
      };
    }
    case 'error':
      return {
        kind: 'error',
        id,
        message: typeof value.message === 'string' ? value.message : '',
      };
    default:
      return null;
  }
}

function parseQuestion(raw: Record<string, unknown>): UserInputQuestion | null {
  const id = raw.id;
  const header = raw.header;
  const question = raw.question;
  const options = raw.options;
  if (typeof id !== 'string' || typeof header !== 'string' || typeof question !== 'string') return null;
  if (!Array.isArray(options)) return null;
  return {
    id,
    header,
    question,
    options: options.filter((o): o is string => typeof o === 'string'),
    multiSelect: typeof raw.multiSelect === 'boolean' ? raw.multiSelect : undefined,
  };
}

function joinContinuations(raw: MessageEntry[]): MessageEntry[] {
  const roots: MessageEntry[] = [];
  const index = new Map<string, number>();
  for (const entry of raw) {
    const rootId = entry.continuationOf;
    if (rootId !== undefined) {
      const ix = index.get(rootId);
      if (ix !== undefined) {
        roots[ix].parts.push(...entry.parts);
        continue;
      }
    }
    index.set(entry.id, roots.length);
    roots.push(entry);
  }
  return roots;
}

function makeUuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Unused import bindings kept for type parity with future ports.
void chatDisplayTitle;

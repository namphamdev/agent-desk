// Offline demo dataset — TS port of DemoDataset.swift. Realistic spaces,
// sessions, transcripts so the app can be exercised with no edge deployment.
// The flagship chat streams a reply on demand, exercising the live-row
// pipeline.

import { AppConfig } from '../app/AppConfig';
import {
  Chat,
  ChatConfig,
  DeviceRow,
  FolderEntry,
  FolderListing,
  MessageEntry,
  nowMs,
  RepoRef,
  SessionRow,
  SessionStatusValue,
  Space,
} from '../models/Entities';
import { SessionStore } from '../sync/SessionStore';

export class DemoDataset {
  devices: DeviceRow[];
  spaces: Space[];
  chats: Chat[];
  sessions: Record<string, SessionRow>;
  private stores = new Map<string, SessionStore>();
  private streamTask?: ReturnType<typeof setTimeout>;
  private refsByPath: Record<string, RepoRef[]> = {};

  private static dummyConfig = new AppConfig({
    edgeURL: 'http://localhost:8787',
    mode: 'dev',
    userId: 'demo',
    orgId: 'demo',
    deviceId: 'rn-demo',
    deviceName: 'Phone',
  });

  constructor(
    devices: DeviceRow[],
    spaces: Space[],
    chats: Chat[],
    sessions: Record<string, SessionRow>,
  ) {
    this.devices = devices;
    this.spaces = spaces;
    this.chats = chats;
    this.sessions = sessions;
  }

  static standard(): DemoDataset {
    const now = nowMs();
    const mac: DeviceRow = {
      id: 'dev-mac', name: 'MacBook Pro', platform: 'macos',
      lastSeenAt: now, createdAt: now - 86_400_000 * 30,
    };
    const vps: DeviceRow = {
      id: 'dev-vps', name: 'hetzner-01', platform: 'linux',
      lastSeenAt: now - 600_000, createdAt: now - 86_400_000 * 12,
    };
    const comet: Space = {
      id: 'space-comet', deviceId: 'dev-mac',
      path: '/Users/dev/comet-native', name: undefined, gitDetected: true,
      gitCheckedAt: now, checkoutId: undefined, createdAt: now - 86_400_000 * 9,
    };
    const edge: Space = {
      id: 'space-edge', deviceId: 'dev-vps',
      path: '/srv/deploys/edge', name: undefined, gitDetected: true,
      gitCheckedAt: now, checkoutId: undefined, createdAt: now - 86_400_000 * 4,
    };
    const claude: ChatConfig = {
      harness: 'claude-code', model: 'claude-fable-5',
      reasoning: 'xhigh', sandbox: 'workspace-write',
    };
    const codex: ChatConfig = {
      harness: 'codex', model: 'gpt-5.6-terra',
      reasoning: 'high', sandbox: 'workspace-write',
    };
    const chats: Chat[] = [
      {
        id: 'chat-veil', deviceId: 'dev-mac', title: 'Streaming veil on transcript rows',
        archived: false,
        cwd: '/Users/dev/.comet-native/worktrees/comet-native-veil-fade',
        branch: 'veil-fade', checkoutId: undefined,
        config: claude, lastMessagePreview: 'Porting the paint-only fade…',
        lastMessageAt: now - 40_000, createdAt: now - 3_600_000,
        spaceId: comet.id, lastSeenAt: now,
      },
      {
        id: 'chat-picker', deviceId: 'dev-mac', title: 'Model picker catalog sync',
        archived: false, cwd: comet.path, branch: 'main', checkoutId: undefined,
        config: claude, lastMessagePreview: 'Which device owns the catalog?',
        lastMessageAt: now - 120_000, createdAt: now - 7_200_000,
        spaceId: comet.id, lastSeenAt: now - 130_000,
      },
      {
        id: 'chat-tabs', deviceId: 'dev-mac', title: 'Tool group header colors',
        archived: false, cwd: comet.path, branch: 'main', checkoutId: undefined,
        config: codex, lastMessagePreview: 'Done — failed children stay quiet.',
        lastMessageAt: now - 900_000, createdAt: now - 86_400_000,
        spaceId: comet.id, lastSeenAt: now - 3_600_000,
      },
      {
        id: 'chat-deploy', deviceId: 'dev-vps', title: 'Wrangler deploy hygiene',
        archived: false, cwd: edge.path, branch: undefined, checkoutId: undefined,
        config: claude, lastMessagePreview: 'Hibernation-safe flush timer',
        lastMessageAt: now - 86_400_000, createdAt: now - 86_400_000 * 2,
        spaceId: edge.id, lastSeenAt: now - 86_400_000,
      },
    ];
    const sessions: Record<string, SessionRow> = {
      'chat-veil': {
        chatId: 'chat-veil', deviceId: 'dev-mac', status: 'working',
        startedAt: now - 95_000, updatedAt: now - 5_000,
      },
      'chat-picker': {
        chatId: 'chat-picker', deviceId: 'dev-mac', status: 'awaitingInput',
        startedAt: now - 400_000, updatedAt: now - 10_000,
      },
    };
    return new DemoDataset([mac, vps], [comet, edge], chats, sessions);
  }

  // MARK: Fake filesystem

  static FILE_TREE: Record<string, string[]> = {
    '/Users/dev': ['Documents', 'Downloads', 'Projects', 'scratch'],
    '/Users/dev/Documents': ['notes', 'specs'],
    '/Users/dev/Projects': ['comet-native', 'dotfiles', 'blog', 'playground'],
    '/Users/dev/Projects/comet-native': ['apps', 'crates', 'docs', 'edge'],
    '/Users/dev/Projects/blog': ['content', 'public'],
    '/srv': ['deploys', 'backups'],
    '/srv/deploys': ['edge', 'landing'],
  };

  private static REPO_NAMES = new Set(['comet-native', 'dotfiles', 'blog', 'playground', 'edge', 'landing']);

  homePath(deviceId: string): string {
    return deviceId === 'dev-vps' ? '/srv' : '/Users/dev';
  }

  listFolders(deviceId: string, path: string): FolderListing {
    const entries: FolderEntry[] = (DemoDataset.FILE_TREE[path] ?? []).map((name) => ({
      name,
      isDir: true,
      isRepo: DemoDataset.REPO_NAMES.has(name),
    }));
    return { path, entries, truncated: false };
  }

  listRefs(spacePath: string): RepoRef[] {
    const cached = this.refsByPath[spacePath];
    if (cached) return cached;
    let seeded: RepoRef[];
    if (spacePath.includes('comet-native')) {
      seeded = [
        { name: 'main', current: true, worktreePath: undefined },
        {
          name: 'veil-fade', current: false,
          worktreePath: '/Users/dev/.comet-native/worktrees/comet-native-veil-fade',
        },
        { name: 'feature/diff-pane', current: false, worktreePath: undefined },
        { name: 'fix/tool-colors', current: false, worktreePath: undefined },
      ];
    } else {
      seeded = [
        { name: 'main', current: true, worktreePath: undefined },
        { name: 'staging', current: false, worktreePath: undefined },
      ];
    }
    this.refsByPath[spacePath] = seeded;
    return seeded;
  }

  switchRef(path: string, refName: string): void {
    const refs = this.listRefs(path).map((r) => ({ ...r, current: r.name === refName }));
    this.refsByPath[path] = refs;
  }

  createWorktree(spacePath: string, base: string): string {
    const slug = base.replace('/', '-');
    const path = `/Users/dev/.comet-native/worktrees/${spacePath.split('/').pop()}-${slug}`;
    const refs = this.listRefs(spacePath);
    const ix = refs.findIndex((r) => r.name === base);
    if (ix !== -1 && !refs[ix].worktreePath) refs[ix].worktreePath = path;
    this.refsByPath[spacePath] = refs;
    return path;
  }

  sessionStoreFor(chatId: string): SessionStore {
    const existing = this.stores.get(chatId);
    if (existing) return existing;
    const store = new SessionStore(chatId, DemoDataset.dummyConfig, true);
    store.setEntries(DemoDataset.transcriptFor(chatId));
    store.demoResponder = (prompt: string) => {
      this.simulateTurn(store, chatId, prompt);
    };
    this.stores.set(chatId, store);
    return store;
  }

  // MARK: Scripted transcripts

  private static transcriptFor(chatId: string): MessageEntry[] {
    const now = nowMs();
    switch (chatId) {
      case 'chat-veil':
        return [
          {
            id: 'm1', role: 'user', createdAt: now - 3_500_000, deviceId: 'rn-demo',
            status: 'complete', continuationOf: undefined,
            parts: [{ kind: 'text', id: 't0', text: 'Port the streaming fade-in veil from the desktop transcript. It must never affect layout — opacity only, split at chunk boundaries.' }],
          },
          {
            id: 'm2', role: 'assistant', createdAt: now - 3_400_000, deviceId: 'dev-mac',
            status: 'complete', continuationOf: undefined,
            parts: [
              {
                kind: 'text', id: 't0',
                text: '## Veil port plan\n\nThe desktop veil multiplies a fading alpha into each appended chunk\'s text color — **paint-layer only**, so shaping and wrapping never change. Three invariants to carry over:\n\n1. Chunk spans keep their *exact* byte length when split\n2. Fade duration tracks the append cadence\n3. Re-attach seeds the baseline — only post-switch appends animate\n\n| Constant | Value |\n| --- | --- |\n| `VEIL_MIN_FADE_MS` | 120 |\n| `VEIL_MAX_FADE_MS` | 400 |\n| `VEIL_CURVE_POW` | 1.6 |\n\n> The curve is `1 − (1−p)^1.6` — fast attack, soft landing.',
              },
              {
                kind: 'tool', id: 'tool1',
                call: { tag: 'readFile', fields: { path: 'crates/ui/src/markdown/veil.rs' } },
                isError: false, resolved: true,
              },
              {
                kind: 'tool', id: 'tool2',
                call: { tag: 'editFile', fields: { path: 'src/transcript/Veil.ts' } },
                isError: false, resolved: true,
              },
              {
                kind: 'tool', id: 'tool3',
                call: { tag: 'exec', fields: { command: 'yarn tsc --noEmit' } },
                isError: false, resolved: true,
              },
              {
                kind: 'text', id: 't1',
                text: 'Implementation lands in `Veil.ts`:\n\n```typescript\nfunction veilOpacity(p: number): number {\n  return 1 - Math.pow(1 - p, 1.6);\n}\n```\n\nThe row keeps one `RowVeil` while streaming and drops it on the live→complete flip, exactly like the desktop lifecycle.',
              },
            ],
          },
        ];
      case 'chat-picker':
        return [
          {
            id: 'm1', role: 'user', createdAt: now - 400_000, deviceId: 'rn-demo',
            status: 'complete', continuationOf: undefined,
            parts: [{ kind: 'text', id: 't0', text: 'The model picker shows stale catalogs after switching devices — where should the catalog come from?' }],
          },
          {
            id: 'm2', role: 'assistant', createdAt: now - 380_000, deviceId: 'dev-mac',
            status: 'complete', continuationOf: undefined,
            parts: [
              {
                kind: 'text', id: 't0',
                text: 'Two viable sources — the local device\'s harness install, or the space\'s owning device. The desktop recently moved to the latter. Before I wire the RPC, one decision:',
              },
              {
                kind: 'input', id: 'req-1', requestId: 'req-1', resolved: false,
                questions: [{
                  id: 'q1', header: 'Catalog source',
                  question: 'Which device should serve harness/model catalogs for the picker?',
                  options: ['Space\'s device (Recommended)', 'Local device', 'Union of both'],
                  multiSelect: false,
                }],
              },
            ],
          },
        ];
      case 'chat-tabs':
        return [
          {
            id: 'm1', role: 'user', createdAt: now - 1_000_000, deviceId: 'rn-demo',
            status: 'complete', continuationOf: undefined,
            parts: [{ kind: 'text', id: 't0', text: 'Tool group headers turn red when any child fails — they should stay quiet, chips carry the error.' }],
          },
          {
            id: 'm2', role: 'assistant', createdAt: now - 950_000, deviceId: 'dev-mac',
            status: 'complete', continuationOf: undefined,
            parts: [
              { kind: 'tool', id: 'tool1', call: { tag: 'search', fields: { pattern: 'group_header_color' } }, isError: false, resolved: true },
              { kind: 'tool', id: 'tool2', call: { tag: 'exec', fields: { command: 'yarn typecheck' } }, isError: true, resolved: true },
              { kind: 'tool', id: 'tool3', call: { tag: 'editFile', fields: { path: 'src/transcript/TranscriptRows.ts' } }, isError: false, resolved: true },
              { kind: 'text', id: 't0', text: 'Done — the header keeps `text_muted` even on failure; only the chip label and the summary segment pick up `danger`.' },
            ],
          },
        ];
      case 'chat-deploy':
        return [
          {
            id: 'm1', role: 'user', createdAt: now - 86_500_000, deviceId: 'rn-demo',
            status: 'complete', continuationOf: undefined,
            parts: [{ kind: 'text', id: 't0', text: 'Audit the wrangler config for hibernation hygiene.' }],
          },
          {
            id: 'm2', role: 'assistant', createdAt: now - 86_400_000, deviceId: 'dev-vps',
            status: 'complete', continuationOf: undefined,
            parts: [{ kind: 'text', id: 't0', text: 'Flush timer now only arms while dirty; ping/pong uses the auto-response path so the DO never wakes for keepalives.' }],
          },
        ];
      default:
        return [];
    }
  }

  // MARK: Streaming simulation

  private simulateTurn(store: SessionStore, chatId: string, prompt: string): void {
    if (this.streamTask) clearTimeout(this.streamTask);
    const now = nowMs();
    const userEntry: MessageEntry = {
      id: `u-${now}`, role: 'user', createdAt: now, deviceId: 'rn-demo',
      status: 'complete', continuationOf: undefined,
      parts: [{ kind: 'text', id: 't0', text: prompt }],
    };
    const liveEntry: MessageEntry = {
      id: `a-${now}`, role: 'assistant', createdAt: now, deviceId: 'dev-mac',
      status: 'streaming', continuationOf: undefined,
      parts: [{ kind: 'text', id: 't0', text: '' }],
    };
    store.setEntries([...store.entries, userEntry, liveEntry]);
    this.sessions[chatId] = {
      chatId, deviceId: 'dev-mac', status: 'working',
      startedAt: now, updatedAt: now,
    };

    const reply = `Here's how the streamed reply renders on this device:\n\n- Markdown re-parses **only the tail** — the last two top-level blocks\n- New text fades in through the paint-only veil\n- The transcript stays glued to the bottom until you scroll up\n\n\`\`\`typescript\n// The desktop constant carries over verbatim.\nconst STREAM_COMMIT_MS = 120;\n\`\`\`\n\nWhen the turn settles, this entry flips \`streaming → complete\`, the veil drops, and the row ids stay stable so nothing flickers.`;
    const words = reply.split(' ');

    let text = '';
    let ix = 0;
    const tick = () => {
      if (ix >= words.length) {
        const end = nowMs();
        const entries = [...store.entries];
        const last = entries[entries.length - 1];
        if (last && last.id === `a-${now}`) {
          last.status = 'complete';
        }
        store.setEntries(entries);
        this.sessions[chatId] = {
          chatId, deviceId: 'dev-mac', status: 'idle',
          startedAt: undefined, updatedAt: end,
        };
        const chatIx = this.chats.findIndex((c) => c.id === chatId);
        if (chatIx !== -1) {
          this.chats[chatIx].lastMessageAt = end;
          this.chats[chatIx].lastMessagePreview = 'When the turn settles…';
          this.chats[chatIx].lastSeenAt = end;
        }
        return;
      }
      text += (ix === 0 ? '' : ' ') + words[ix];
      ix++;
      const entries = [...store.entries];
      const last = entries[entries.length - 1];
      if (last && last.id === `a-${now}`) {
        last.parts = [{ kind: 'text', id: 't0', text }];
      }
      store.setEntries(entries);
      this.streamTask = setTimeout(tick, 30 + Math.random() * 110);
    };
    this.streamTask = setTimeout(tick, 30);
  }
}

// Used by callers that want the SessionStatusValue type bound.
export type { SessionStatusValue };

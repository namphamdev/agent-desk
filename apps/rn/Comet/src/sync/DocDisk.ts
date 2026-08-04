// On-device Loro doc persistence — port of DocDisk.swift. One snapshot per
// doc under the app's document directory. Docs load BEFORE the room join so
// the UI renders instantly from local state (offline included) and the join's
// version vector turns the backfill incremental.

import * as FileSystem from 'expo-file-system/legacy';
import { LoroDoc } from 'loro-react-native';

const DIRECTORY = `${FileSystem.documentDirectory}AgentDeskiDocs/`;

function safeId(id: string): string {
  return id.replaceAll('/', '_');
}

function docPath(id: string): string {
  return `${DIRECTORY}${safeId(id)}.loro`;
}

export const DocDisk = {
  async ensureDirectory(): Promise<void> {
    const info = await FileSystem.getInfoAsync(DIRECTORY);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(DIRECTORY, { intermediates: true });
    }
  },

  async load(into: LoroDoc, id: string): Promise<boolean> {
    try {
      await this.ensureDirectory();
      const url = docPath(id);
      const info = await FileSystem.getInfoAsync(url);
      if (!info.exists || info.size === 0) return false;
      // FileSystem reads as base64; convert to bytes for import.
      const base64 = await FileSystem.readAsStringAsync(url, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const bytes = base64ToUint8(base64);
      if (bytes.length === 0) return false;
      into.import_(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      return true;
    } catch (err) {
      console.warn(`[docdisk] load ${id} failed`, err);
      return false;
    }
  },

  async save(doc: LoroDoc, id: string): Promise<void> {
    try {
      await this.ensureDirectory();
      const snapshot = doc.export({ mode: "snapshot" });
      const url = docPath(id);
      const base64 = uint8ToBase64(new Uint8Array(snapshot));
      await FileSystem.writeAsStringAsync(url, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
    } catch (err) {
      console.warn(`[docdisk] save ${id} failed`, err);
    }
  },

  async prune(keep: number): Promise<void> {
    try {
      await this.ensureDirectory();
      const files = await FileSystem.readDirectoryAsync(DIRECTORY);
      const sessions = files.filter((name) => !name.startsWith('ws3_'));
      if (sessions.length <= keep) return;
      const infos = await Promise.all(
        sessions.map(async (name) => {
          const url = `${DIRECTORY}${name}`;
          const info = await FileSystem.getInfoAsync(url);
          return { name, url, modificationTime: info.exists ? (info.modificationTime ?? 0) : 0 };
        }),
      );
      infos.sort((a, b) => b.modificationTime - a.modificationTime);
      for (const stale of infos.slice(keep)) {
        try {
          await FileSystem.deleteAsync(stale.url, { idempotent: true });
        } catch {
          // ignore
        }
      }
    } catch {
      // directory missing etc. — non-fatal
    }
  },

  async wipeAll(): Promise<void> {
    try {
      await FileSystem.deleteAsync(DIRECTORY, { idempotent: true });
    } catch {
      // ignore
    }
  },
};

function base64ToUint8(b64: string): Uint8Array {
  // Use the RN runtime's atob.
  // eslint-disable-next-line no-undef
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // eslint-disable-next-line no-undef
  return btoa(bin);
}

/**
 * Debounced snapshot persistence shared by the doc stores: poke on every
 * change; the snapshot writes ~1.5s after the last poke, and `flush` forces
 * it (backgrounding, store teardown).
 */
export class DocSaver {
  private generation = 0;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly docId: string,
    private readonly doc: LoroDoc,
  ) {}

  poke(): void {
    this.dirty = true;
    this.generation += 1;
    const expected = this.generation;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      if (this.generation !== expected) return;
      await this.flush();
    }, 1500);
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await DocDisk.save(this.doc, this.docId);
  }
}

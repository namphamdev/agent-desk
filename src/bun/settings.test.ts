import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./store";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "terminal-react-settings-"));
}

describe("settings", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  function openStore() {
    const dir = tempDir();
    dirs.push(dir);
    return new SessionStore(dir);
  }

  it("exposes sensible defaults", () => {
    expect(DEFAULT_SETTINGS.theme).toBe("dark");
    expect(DEFAULT_SETTINGS.enableFsCapabilities).toBe(false);
    expect(DEFAULT_SETTINGS.enableNotifications).toBe(true);
    expect(DEFAULT_SETTINGS.enableSound).toBe(true);
    expect(DEFAULT_SETTINGS.defaultAgentId).toBeNull();
    expect(DEFAULT_SETTINGS.defaultEffort).toBe("High");
    expect(DEFAULT_SETTINGS.editorCommand).toBeTruthy();
    expect(DEFAULT_SETTINGS.dataDir).toContain(".terminal-react");
  });

  it("returns defaults when nothing is stored", () => {
    const store = openStore();
    const s = loadSettings(store);
    expect(s.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(s.enableFsCapabilities).toBe(false);
    store.close();
  });

  it("merges patches on top of defaults and persists", () => {
    const store = openStore();
    const next = saveSettings(store, {
      theme: "light",
      editorCommand: "nvim",
      enableFsCapabilities: true,
      defaultAgentId: "claude-code",
    });

    expect(next).toMatchObject({
      theme: "light",
      editorCommand: "nvim",
      enableFsCapabilities: true,
      defaultAgentId: "claude-code",
    });
    // Unpatched fields stay at defaults.
    expect(next.defaultEffort).toBe(DEFAULT_SETTINGS.defaultEffort);

    const reloaded = loadSettings(store);
    expect(reloaded).toEqual(next);
    store.close();
  });

  it("partial save keeps previous custom values", () => {
    const store = openStore();
    saveSettings(store, { theme: "light", editorCommand: "cursor" });
    const next = saveSettings(store, { theme: "system" });
    expect(next.theme).toBe("system");
    expect(next.editorCommand).toBe("cursor");
    store.close();
  });

  it("falls back to defaults when stored JSON is corrupt", () => {
    const store = openStore();
    store.setSetting("app_settings", "{not-json");
    const s = loadSettings(store);
    expect(s.theme).toBe(DEFAULT_SETTINGS.theme);
    store.close();
  });
});

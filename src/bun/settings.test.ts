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
    expect(DEFAULT_SETTINGS.theme).toBe("light");
    expect(DEFAULT_SETTINGS.enableFsCapabilities).toBe(false);
    expect(DEFAULT_SETTINGS.enableBrowserMcp).toBe(true);
    expect(DEFAULT_SETTINGS.enableNotifications).toBe(true);
    expect(DEFAULT_SETTINGS.enableSound).toBe(true);
    expect(DEFAULT_SETTINGS.defaultAgentId).toBeNull();
    expect(DEFAULT_SETTINGS.defaultEffort).toBe("high");
    expect(DEFAULT_SETTINGS.defaultPermissionMode).toBe("default");
    expect(DEFAULT_SETTINGS.editorCommand).toBeTruthy();
    expect(DEFAULT_SETTINGS.dataDir).toContain(".terminal-react");
    expect(DEFAULT_SETTINGS.providers).toEqual([]);
    expect(DEFAULT_SETTINGS.activeProviderId).toBeNull();
    expect(DEFAULT_SETTINGS.activeModelAlias).toBe("sonnet");
    expect(DEFAULT_SETTINGS.worktreeSymlinkPaths).toEqual(["node_modules"]);
    expect(DEFAULT_SETTINGS.workflows).toEqual([]);
  });

  it("normalizes worktree symlink paths on save", () => {
    const store = openStore();
    const next = saveSettings(store, {
      worktreeSymlinkPaths: ["node_modules", "../evil", "node_modules", ".venv"],
    });
    expect(next.worktreeSymlinkPaths).toEqual(["node_modules", ".venv"]);
    expect(loadSettings(store).worktreeSymlinkPaths).toEqual([
      "node_modules",
      ".venv",
    ]);
    store.close();
  });

  it("returns defaults when nothing is stored", () => {
    const store = openStore();
    const s = loadSettings(store);
    expect(s.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(s.enableFsCapabilities).toBe(false);
    expect(s.enableBrowserMcp).toBe(true);
    store.close();
  });

  it("defaults enableBrowserMcp to true when missing from stored JSON", () => {
    const store = openStore();
    // Simulate older settings without the flag.
    store.setSetting(
      "app_settings",
      JSON.stringify({
        theme: "light",
        enableFsCapabilities: false,
      }),
    );
    const s = loadSettings(store);
    expect(s.enableBrowserMcp).toBe(true);
    expect(s.theme).toBe("light");
    store.close();
  });

  it("persists enableBrowserMcp false", () => {
    const store = openStore();
    const next = saveSettings(store, { enableBrowserMcp: false });
    expect(next.enableBrowserMcp).toBe(false);
    expect(loadSettings(store).enableBrowserMcp).toBe(false);
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
    expect(next.defaultPermissionMode).toBe(
      DEFAULT_SETTINGS.defaultPermissionMode,
    );

    const reloaded = loadSettings(store);
    expect(reloaded).toEqual(next);
    store.close();
  });

  it("persists defaultPermissionMode", () => {
    const store = openStore();
    const next = saveSettings(store, { defaultPermissionMode: "acceptEdits" });
    expect(next.defaultPermissionMode).toBe("acceptEdits");
    expect(loadSettings(store).defaultPermissionMode).toBe("acceptEdits");
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

  it("persists providers and active model selection", () => {
    const store = openStore();
    const next = saveSettings(store, {
      providers: [
        {
          id: "gw",
          name: "Gateway",
          baseUrl: "https://example.com",
          apiKey: "sk-abc",
          models: {
            haiku: "h1",
            sonnet: "s1",
            opus: "o1",
          },
        },
      ],
      activeProviderId: "gw",
      activeModelAlias: "opus",
    });
    expect(next.providers).toHaveLength(1);
    expect(next.activeProviderId).toBe("gw");
    expect(next.activeModelAlias).toBe("opus");
    // defaultModel tracks the Claude alias for ACP matching
    expect(next.defaultModel).toBe("opus");

    const reloaded = loadSettings(store);
    expect(reloaded.providers?.[0]?.apiKey).toBe("sk-abc");
    expect(reloaded.activeModelAlias).toBe("opus");
    store.close();
  });

  it("clears activeProviderId when providers are emptied", () => {
    const store = openStore();
    saveSettings(store, {
      providers: [
        {
          id: "gw",
          name: "Gateway",
          baseUrl: "",
          apiKey: "",
          models: { haiku: "", sonnet: "", opus: "" },
        },
      ],
      activeProviderId: "gw",
    });
    const next = saveSettings(store, { providers: [] });
    expect(next.activeProviderId).toBeNull();
    store.close();
  });
});

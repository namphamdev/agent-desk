import { describe, expect, it } from "vitest";
import {
  buildGrokConfigToml,
  buildGrokProviderEnv,
  ensureGrokConfigForProvider,
  GROK_PROVIDER_API_KEY_ENV,
  GROK_PROVIDER_MODEL_ID,
  isGrokStyleAgent,
  normalizeGrokBaseUrl,
} from "./grok-config";
import type { ProviderConfig } from "../shared/rpc";

const sample: ProviderConfig = {
  id: "p1",
  name: "Gateway",
  baseUrl: "https://proxy.example.com/v1",
  apiKey: "sk-test-key",
  models: {
    haiku: "vendor/haiku-fast",
    sonnet: "vendor/sonnet-pro",
    opus: "vendor/opus-max",
  },
};

describe("grok-config", () => {
  it("isGrokStyleAgent matches grok agent stdio", () => {
    expect(
      isGrokStyleAgent({
        id: "grok-build",
        name: "Grok",
        command: "grok",
        args: ["agent", "stdio"],
      }),
    ).toBe(true);
    expect(
      isGrokStyleAgent({
        id: "claude-code",
        name: "Claude",
        command: "claude-agent-acp",
        args: [],
      }),
    ).toBe(false);
  });

  it("normalizeGrokBaseUrl appends /v1 when missing", () => {
    expect(normalizeGrokBaseUrl("https://proxy.example.com")).toBe(
      "https://proxy.example.com/v1",
    );
    expect(normalizeGrokBaseUrl("https://proxy.example.com/")).toBe(
      "https://proxy.example.com/v1",
    );
    expect(normalizeGrokBaseUrl("https://proxy.example.com/v1")).toBe(
      "https://proxy.example.com/v1",
    );
    expect(normalizeGrokBaseUrl("https://proxy.example.com/v1/")).toBe(
      "https://proxy.example.com/v1",
    );
  });

  it("buildGrokConfigToml sets api_backend messages and selected model", () => {
    const toml = buildGrokConfigToml(sample, "sonnet");
    expect(toml).toContain('api_backend = "messages"');
    expect(toml).toContain(`default = "${GROK_PROVIDER_MODEL_ID}"`);
    expect(toml).toContain(`[model."${GROK_PROVIDER_MODEL_ID}"]`);
    expect(toml).toContain('model = "vendor/sonnet-pro"');
    expect(toml).toContain('base_url = "https://proxy.example.com/v1"');
    expect(toml).toContain(`env_key = "${GROK_PROVIDER_API_KEY_ENV}"`);
    expect(toml).toContain("disable_web_search = true");
    expect(toml).toContain('session_summary = "vendor/sonnet-pro"');
  });

  it("buildGrokConfigToml appends /v1 when provider base lacks it", () => {
    const toml = buildGrokConfigToml(
      { ...sample, baseUrl: "https://gateway.example.com" },
      "sonnet",
    );
    expect(toml).toContain('base_url = "https://gateway.example.com/v1"');
  });

  it("buildGrokConfigToml escapes quotes in provider fields", () => {
    const toml = buildGrokConfigToml(
      {
        ...sample,
        name: 'Acme "Labs"',
        baseUrl: 'https://x.example/v1?q="a"',
        models: { ...sample.models, sonnet: 'model"with"quotes' },
      },
      "sonnet",
    );
    expect(toml).toContain('name = "Acme \\"Labs\\""');
    expect(toml).toContain('model = "model\\"with\\"quotes"');
  });

  it("buildGrokProviderEnv injects API key", () => {
    expect(buildGrokProviderEnv(sample)).toEqual({
      [GROK_PROVIDER_API_KEY_ENV]: "sk-test-key",
    });
    expect(buildGrokProviderEnv(null)).toBeNull();
    expect(
      buildGrokProviderEnv({ ...sample, apiKey: "  " }),
    ).toBeNull();
  });

  it("ensureGrokConfigForProvider writes toml when provider is ready", async () => {
    let writtenPath = "";
    let written = "";
    const result = await ensureGrokConfigForProvider(
      {
        providers: [sample],
        activeProviderId: "p1",
        activeModelAlias: "opus",
      },
      {
        env: { GROK_HOME: "C:\\tmp\\fake-grok-home" },
        writeFile: async (path, contents) => {
          writtenPath = path;
          written = contents;
        },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wrote).toBe(true);
    expect(writtenPath.replace(/\\/g, "/")).toMatch(
      /fake-grok-home\/config\.toml$/,
    );
    expect(written).toContain('api_backend = "messages"');
    expect(written).toContain('model = "vendor/opus-max"');
  });

  it("ensureGrokConfigForProvider skips without base URL or model", async () => {
    let writes = 0;
    const writeFile = async () => {
      writes += 1;
    };
    const noProvider = await ensureGrokConfigForProvider(
      { providers: [], activeProviderId: null, activeModelAlias: "sonnet" },
      { writeFile },
    );
    expect(noProvider).toMatchObject({ wrote: false, reason: "no-provider" });

    const noBase = await ensureGrokConfigForProvider(
      {
        providers: [{ ...sample, baseUrl: "" }],
        activeProviderId: "p1",
        activeModelAlias: "sonnet",
      },
      { writeFile },
    );
    expect(noBase).toMatchObject({ wrote: false, reason: "no-base-url" });

    // Empty model map still writes: resolveProviderModel falls back to alias.
    const aliasFallback = await ensureGrokConfigForProvider(
      {
        providers: [
          {
            ...sample,
            models: { haiku: "", sonnet: "", opus: "" },
          },
        ],
        activeProviderId: "p1",
        activeModelAlias: "sonnet",
      },
      { writeFile },
    );
    expect(aliasFallback).toMatchObject({ ok: true, wrote: true });
    expect(writes).toBe(1);
  });
});

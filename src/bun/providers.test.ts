import { describe, expect, it } from "vitest";
import {
  buildClaudeCodeSessionMeta,
  buildProviderEnv,
  createEmptyProvider,
  normalizeModelAlias,
  normalizeProviders,
  providerConnectionKey,
  resolveActiveProvider,
  resolveProviderModel,
} from "./providers";
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

describe("providers", () => {
  it("createEmptyProvider fills defaults", () => {
    const p = createEmptyProvider({ name: "  My API  " });
    expect(p.name).toBe("My API");
    expect(p.baseUrl).toBe("");
    expect(p.apiKey).toBe("");
    expect(p.models).toEqual({ haiku: "", sonnet: "", opus: "" });
    expect(p.id).toMatch(/^prov-/);
  });

  it("normalizeProviders drops invalid entries", () => {
    const out = normalizeProviders([
      null,
      { id: "ok", name: "A", baseUrl: " https://x ", apiKey: "k", models: { haiku: "h" } },
      { name: "no-id" },
      "string",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "ok",
      name: "A",
      baseUrl: "https://x",
      apiKey: "k",
      models: { haiku: "h", sonnet: "", opus: "" },
    });
  });

  it("normalizeModelAlias accepts haiku/sonnet/opus only", () => {
    expect(normalizeModelAlias("OPUS")).toBe("opus");
    expect(normalizeModelAlias("gpt-4")).toBe("sonnet");
    expect(normalizeModelAlias(undefined, "haiku")).toBe("haiku");
  });

  it("resolveActiveProvider picks by id then falls back", () => {
    const p2 = { ...sample, id: "p2", name: "Other" };
    expect(
      resolveActiveProvider({
        providers: [sample, p2],
        activeProviderId: "p2",
      })?.id,
    ).toBe("p2");
    expect(
      resolveActiveProvider({
        providers: [sample, p2],
        activeProviderId: "missing",
      })?.id,
    ).toBe("p1");
    expect(
      resolveActiveProvider({ providers: [], activeProviderId: "p1" }),
    ).toBeNull();
  });

  it("resolveProviderModel prefers mapped id then alias", () => {
    expect(resolveProviderModel(sample, "sonnet")).toBe("vendor/sonnet-pro");
    expect(
      resolveProviderModel(
        { ...sample, models: { haiku: "", sonnet: "", opus: "" } },
        "sonnet",
      ),
    ).toBe("sonnet");
    expect(resolveProviderModel(null, "opus")).toBe("opus");
  });

  it("buildProviderEnv sets ANTHROPIC_* vars", () => {
    const env = buildProviderEnv(sample, "opus");
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://proxy.example.com/v1",
      ANTHROPIC_API_KEY: "sk-test-key",
      ANTHROPIC_AUTH_TOKEN: "sk-test-key",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "vendor/haiku-fast",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "vendor/sonnet-pro",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "vendor/opus-max",
      ANTHROPIC_MODEL: "vendor/opus-max",
    });
  });

  it("buildProviderEnv returns null without a provider", () => {
    expect(buildProviderEnv(null, "sonnet")).toBeNull();
  });

  it("buildProviderEnv always includes full key set (empty clears parent)", () => {
    const env = buildProviderEnv(
      {
        id: "bare",
        name: "Bare",
        baseUrl: "",
        apiKey: "",
        models: { haiku: "", sonnet: "", opus: "" },
      },
      "haiku",
    );
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: "",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "",
      ANTHROPIC_MODEL: "haiku",
    });
  });

  it("buildClaudeCodeSessionMeta always registers browser MCP awareness", () => {
    const meta = buildClaudeCodeSessionMeta(sample, "sonnet");
    const baseEnv = buildProviderEnv(sample, "sonnet")!;
    expect(meta).toMatchObject({
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
      },
      claudeCode: {
        options: {
          env: {
            ...baseEnv,
            ENABLE_TOOL_SEARCH: "",
          },
          model: "sonnet",
          settingSources: ["project", "local"],
        },
      },
    });
    expect(String((meta as { systemPrompt: { append: string } }).systemPrompt.append)).toContain(
      "browser_navigate",
    );

    // Without app provider, still return meta so MCP tools stay discoverable.
    const noProvider = buildClaudeCodeSessionMeta(null, "sonnet");
    expect(noProvider).toBeDefined();
    expect(
      (noProvider as { claudeCode: { options: { env: { ENABLE_TOOL_SEARCH: string } } } })
        .claudeCode.options.env.ENABLE_TOOL_SEARCH,
    ).toBe("");
    expect(
      (noProvider as { claudeCode: { options: { settingSources: string[] } } })
        .claudeCode.options.settingSources,
    ).toEqual(["user", "project", "local"]);
  });

  it("providerConnectionKey changes when credentials or model change", () => {
    const base = {
      providers: [sample],
      activeProviderId: "p1",
      activeModelAlias: "sonnet" as const,
    };
    const a = providerConnectionKey(base);
    const b = providerConnectionKey({
      ...base,
      activeModelAlias: "opus",
    });
    const c = providerConnectionKey({
      ...base,
      providers: [{ ...sample, apiKey: "other" }],
    });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(providerConnectionKey({ providers: [], activeProviderId: null })).toBe(
      "none:sonnet",
    );
  });
});

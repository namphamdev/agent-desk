/**
 * One-shot ACP turn to draft a git commit message (no UI session).
 * Spawns a short-lived agent process, prompts, collects agent text, disposes.
 */
import type { AgentInfo, AppSettings } from "../shared/rpc";
import type { SessionUpdate } from "../session/types";
import { AcpClient } from "./acp-client";
import {
  buildCommitContext,
  buildCommitMessagePrompt,
  parseCommitMessageResponse,
  type GitCommitMessage,
} from "./git-status";
import {
  buildClaudeCodeSessionMeta,
  buildProviderEnv,
  normalizeModelAlias,
  resolveActiveProvider,
  withBrowserMcpAlwaysLoaded,
} from "./providers";
import {
  buildGrokProviderEnv,
  ensureGrokConfigForProvider,
  GROK_PROVIDER_MODEL_ID,
  isGrokStyleAgent,
} from "./grok-config";
import {
  withGrokAgentSpawnArgs,
} from "./session-manager/agent-connection";

function isClaudeStyleAgent(
  agent: Pick<AgentInfo, "id" | "command" | "name">,
): boolean {
  const id = agent.id.toLowerCase();
  if (id === "claude-code" || id === "claude" || id.startsWith("claude-")) {
    return true;
  }
  const cmd =
    agent.command.replace(/\\/g, "/").split("/").pop() ?? agent.command;
  const base = cmd.replace(/\.exe$/i, "").toLowerCase();
  return (
    base === "claude-agent-acp" ||
    base === "claude-code-acp" ||
    base === "claude"
  );
}

function extractText(update: SessionUpdate): string {
  if (
    update.sessionUpdate === "agent_message_chunk" &&
    update.content.type === "text"
  ) {
    return update.content.text;
  }
  return "";
}

export type GenerateCommitMessageResult =
  | { ok: true; subject: string; body: string; raw: string }
  | { ok: false; error: string };

/**
 * Use the configured ACP agent to draft subject + body from git changes.
 * Does not stage, commit, or touch chat sessions.
 */
export async function generateCommitMessageViaAcp(opts: {
  cwd: string;
  agents: AgentInfo[];
  settings: AppSettings;
  agentId?: string;
  /** Abort after this many ms (default 120s). */
  timeoutMs?: number;
}): Promise<GenerateCommitMessageResult> {
  const cwd = opts.cwd?.trim();
  if (!cwd) return { ok: false, error: "No project folder." };

  const ctx = await buildCommitContext(cwd);
  if (!ctx.ok) return ctx;

  const agentId =
    opts.agentId?.trim() ||
    opts.settings.defaultAgentId ||
    opts.agents[0]?.id;
  const agent = opts.agents.find((a) => a.id === agentId);
  if (!agent) {
    return {
      ok: false,
      error: agentId
        ? `Unknown agent: ${agentId}`
        : "No ACP agent configured. Add one in Settings.",
    };
  }

  const provider = resolveActiveProvider(opts.settings);
  const modelAlias = normalizeModelAlias(
    opts.settings.activeModelAlias,
    "sonnet",
  );
  const usesClaude = isClaudeStyleAgent(agent);
  const usesGrok = isGrokStyleAgent(agent);

  if (usesGrok) {
    try {
      const grokCfg = await ensureGrokConfigForProvider(opts.settings);
      if (!grokCfg.ok) {
        return {
          ok: false,
          error: `Grok config failed: ${grokCfg.error}`,
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Grok config failed: ${message}` };
    }
  }

  const providerEnv = usesClaude
    ? buildProviderEnv(provider, modelAlias)
    : usesGrok
      ? buildGrokProviderEnv(provider)
      : null;

  const sessionMeta = usesClaude
    ? buildClaudeCodeSessionMeta(provider, modelAlias)
    : undefined;

  const pinGrokModel = usesGrok && !!provider?.baseUrl?.trim();
  const spawnAgent = usesGrok
    ? withGrokAgentSpawnArgs(agent, {
        // Prefer auto-approve so the agent cannot hang on tool permissions.
        defaultPermissionMode: "bypassPermissions",
        defaultEffort: opts.settings.defaultEffort ?? "low",
        modelId: pinGrokModel ? GROK_PROVIDER_MODEL_ID : undefined,
      })
    : agent;

  let chunks = "";
  let client: AcpClient | null = null;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  try {
    client = new AcpClient(
      spawnAgent,
      {
        enableFs: false,
        enableBrowserMcp: false,
        onUpdate: (_sid, update) => {
          chunks += extractText(update);
        },
        onPermission: async (params) => {
          // Never run tools for commit-message drafting.
          const reject =
            params.options?.find((o) => o.kind === "reject_once") ??
            params.options?.find((o) => o.kind === "reject_always") ??
            params.options?.[0];
          if (reject) {
            return {
              outcome: {
                outcome: "selected",
                optionId: reject.optionId,
              },
            };
          }
          return { outcome: { outcome: "cancelled" } };
        },
        onError: (err) => {
          console.warn("[git-commit-msg] agent error:", err);
        },
      },
      {
        ...(usesClaude
          ? {
              env: withBrowserMcpAlwaysLoaded(providerEnv ?? {}),
              sessionMeta,
            }
          : usesGrok
            ? {
                env: providerEnv ?? {
                  GROK_DEFAULT_MODEL: GROK_PROVIDER_MODEL_ID,
                  GROK_IMAGE_GEN: "0",
                },
                fallbackPermissionMode: "bypassPermissions",
                fallbackEffort: "low",
              }
            : {}),
      },
    );

    await client.connect();
    const handle = await client.openSession(cwd);
    handle.beginUpdates();

    const prompt = buildCommitMessagePrompt(ctx.summary);
    const turn = Promise.race([
      handle.prompt(prompt),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("Timed out waiting for commit message.")),
          timeoutMs,
        );
      }),
    ]);

    await turn;

    const raw = chunks.trim();
    if (!raw) {
      return {
        ok: false,
        error:
          "Agent returned an empty response. Try again or write the message manually.",
      };
    }

    const parsed: GitCommitMessage = parseCommitMessageResponse(raw);
    if (!parsed.subject) {
      return { ok: false, error: "Could not parse a commit subject from the agent." };
    }
    return {
      ok: true,
      subject: parsed.subject,
      body: parsed.body,
      raw,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    try {
      await client?.dispose();
    } catch {
      /* ignore */
    }
  }
}

import { describe, expect, it } from "vitest";
import {
  withGrokAgentSpawnArgs,
  withGrokAlwaysApproveArgs,
} from "./agent-connection";
import type { AgentInfo } from "../../shared/rpc";

const grok: AgentInfo = {
  id: "grok-build",
  name: "Grok Build (ACP)",
  command: "grok",
  args: ["agent", "stdio"],
};

describe("withGrokAgentSpawnArgs", () => {
  it("inserts --always-approve after agent for bypass/yolo defaults", () => {
    const next = withGrokAgentSpawnArgs(grok, {
      defaultPermissionMode: "bypassPermissions",
    });
    expect(next.args).toEqual(["agent", "--always-approve", "stdio"]);
  });

  it("inserts --effort for defaultEffort", () => {
    const next = withGrokAgentSpawnArgs(grok, { defaultEffort: "low" });
    expect(next.args).toEqual(["agent", "--effort", "low", "stdio"]);
  });

  it("pins catalog model with -m", () => {
    const next = withGrokAgentSpawnArgs(grok, { modelId: "agent-desk" });
    expect(next.args).toEqual(["agent", "-m", "agent-desk", "stdio"]);
  });

  it("combines model, always-approve, and effort", () => {
    const next = withGrokAgentSpawnArgs(grok, {
      modelId: "agent-desk",
      defaultPermissionMode: "yolo",
      defaultEffort: "high",
    });
    expect(next.args).toEqual([
      "agent",
      "-m",
      "agent-desk",
      "--always-approve",
      "--effort",
      "high",
      "stdio",
    ]);
  });

  it("combines always-approve and effort", () => {
    const next = withGrokAgentSpawnArgs(grok, {
      defaultPermissionMode: "yolo",
      defaultEffort: "high",
    });
    expect(next.args).toEqual([
      "agent",
      "--always-approve",
      "--effort",
      "high",
      "stdio",
    ]);
  });

  it("maps max → xhigh", () => {
    const next = withGrokAgentSpawnArgs(grok, { defaultEffort: "max" });
    expect(next.args).toEqual(["agent", "--effort", "xhigh", "stdio"]);
  });

  it("leaves args unchanged when no yolo/effort", () => {
    expect(
      withGrokAgentSpawnArgs(grok, {
        defaultPermissionMode: "default",
        defaultEffort: "",
      }).args,
    ).toEqual(["agent", "stdio"]);
  });

  it("is idempotent when flags already present", () => {
    const already: AgentInfo = {
      ...grok,
      args: ["agent", "--always-approve", "--effort", "medium", "stdio"],
    };
    expect(
      withGrokAgentSpawnArgs(already, {
        defaultPermissionMode: "yolo",
        defaultEffort: "high",
      }).args,
    ).toEqual(["agent", "--always-approve", "--effort", "medium", "stdio"]);
  });
});

describe("withGrokAlwaysApproveArgs (compat)", () => {
  it("still inserts always-approve", () => {
    expect(withGrokAlwaysApproveArgs(grok, "bypassPermissions").args).toEqual([
      "agent",
      "--always-approve",
      "stdio",
    ]);
  });
});

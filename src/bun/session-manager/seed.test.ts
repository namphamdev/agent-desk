import { describe, expect, it } from "vitest";
import { formatSeededPrompt, seedUpdateForRole } from "./seed";

describe("formatSeededPrompt", () => {
  it("frames continue purpose for forked messages", () => {
    const out = formatSeededPrompt("prior msg", "follow up", "continue");
    expect(out).toContain("Continue from it");
    expect(out).toContain("prior msg");
    expect(out).toContain("follow up");
  });

  it("frames review purpose without continue language", () => {
    const out = formatSeededPrompt("# summary", "Review please", "review");
    expect(out).toContain("review those changes");
    expect(out).not.toContain("Continue from it");
    expect(out).toContain("# summary");
    expect(out).toContain("Review please");
  });

  it("defaults to continue", () => {
    expect(formatSeededPrompt("a", "b")).toContain("Continue from it");
  });
});

describe("seedUpdateForRole", () => {
  it("maps roles to session updates", () => {
    expect(seedUpdateForRole("hi", "user").sessionUpdate).toBe(
      "user_message_chunk",
    );
    expect(seedUpdateForRole("hi", "agent").sessionUpdate).toBe(
      "agent_message_chunk",
    );
    expect(seedUpdateForRole("hi", "thought").sessionUpdate).toBe(
      "thought_sequence_chunk",
    );
  });
});

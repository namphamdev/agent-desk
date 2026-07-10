import type { SessionUpdate } from "../../session/types";

/** Persist seed context as a timeline message of the original role. */
export function seedUpdateForRole(
  text: string,
  role: "user" | "agent" | "thought",
): SessionUpdate {
  const content = { type: "text" as const, text };
  if (role === "user") {
    return { sessionUpdate: "user_message_chunk", content };
  }
  if (role === "thought") {
    return { sessionUpdate: "thought_sequence_chunk", content };
  }
  return { sessionUpdate: "agent_message_chunk", content };
}

/**
 * Wrap the user's first prompt so the agent receives forked message context.
 * The seed is already shown in the UI timeline; this is for the model only.
 */
export function formatSeededPrompt(seed: string, userText: string): string {
  return [
    "The following is starting context for this thread (from a prior message). Continue from it.",
    "",
    "---",
    seed,
    "---",
    "",
    userText,
  ].join("\n");
}

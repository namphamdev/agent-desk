import { describe, expect, it } from "vitest";
import {
  normalizeGrokAskUserQuestion,
  parseGrokAskUserQuestionParams,
  toGrokAskUserQuestionResponse,
} from "./user-question";

describe("parseGrokAskUserQuestionParams", () => {
  it("accepts camelCase and snake_case ids", () => {
    const a = parseGrokAskUserQuestionParams({
      sessionId: "s1",
      toolCallId: "t1",
      questions: [],
    });
    expect(a.sessionId).toBe("s1");
    expect(a.toolCallId).toBe("t1");

    const b = parseGrokAskUserQuestionParams({
      session_id: "s2",
      tool_call_id: "t2",
      questions: [],
    });
    expect(b.sessionId).toBe("s2");
    expect(b.toolCallId).toBe("t2");
  });
});

describe("normalizeGrokAskUserQuestion", () => {
  it("keeps question text and option labels for answers map keys", () => {
    const parsed = normalizeGrokAskUserQuestion({
      sessionId: "sess",
      questions: [
        {
          question: "How aggressive should the reorg be?",
          multi_select: false,
          options: [
            {
              label: "Clean layout (Recommended)",
              description: "Move code into a clear tree",
            },
            { label: "Docs-only" },
          ],
        },
        {
          question: "Pick colors",
          multiSelect: true,
          options: [{ label: "Red" }, { label: "Blue" }],
        },
      ],
    });

    expect(parsed.sessionId).toBe("sess");
    expect(parsed.questions).toHaveLength(2);
    expect(parsed.questions[0]?.question).toBe(
      "How aggressive should the reorg be?",
    );
    expect(parsed.questions[0]?.options[0]?.label).toBe(
      "Clean layout (Recommended)",
    );
    expect(parsed.questions[1]?.multiSelect).toBe(true);
  });

  it("drops questions without text", () => {
    const parsed = normalizeGrokAskUserQuestion({
      sessionId: "s",
      questions: [{ options: [{ label: "A" }] }, { question: "Ok?" }],
    });
    expect(parsed.questions).toEqual([
      { question: "Ok?", options: [] },
    ]);
  });
});

describe("toGrokAskUserQuestionResponse", () => {
  it("emits Grok wire variants", () => {
    expect(
      toGrokAskUserQuestionResponse({
        action: "accepted",
        answers: { Q: "A" },
        partialAnswers: true,
      }),
    ).toEqual({
      answers: { Q: "A" },
      partial_answers: true,
    });

    expect(
      toGrokAskUserQuestionResponse({ action: "skip_interview" }),
    ).toEqual({ skip_interview: true });

    expect(
      toGrokAskUserQuestionResponse({
        action: "chat_about_this",
        message: "Need more context",
      }),
    ).toEqual({
      chat_about_this: true,
      message: "Need more context",
    });
  });
});

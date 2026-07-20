import { describe, expect, it } from "vitest";
import {
  shouldFocusPromptInput,
  type PromptFocusTarget,
} from "./promptFocus";

function target(
  partial: Partial<PromptFocusTarget> & { tagName: string },
): PromptFocusTarget {
  return {
    tagName: partial.tagName,
    isContentEditable: partial.isContentEditable ?? false,
    closest: partial.closest ?? (() => null),
  };
}

describe("shouldFocusPromptInput", () => {
  const prompt = target({ tagName: "TEXTAREA" });

  it("focuses when nothing useful is active", () => {
    expect(
      shouldFocusPromptInput({
        disabled: false,
        activeElement: null,
        promptElement: prompt,
      }),
    ).toBe(true);
    expect(
      shouldFocusPromptInput({
        disabled: false,
        activeElement: target({ tagName: "BODY" }),
        promptElement: prompt,
      }),
    ).toBe(true);
    expect(
      shouldFocusPromptInput({
        disabled: false,
        activeElement: target({ tagName: "DIV" }),
        promptElement: prompt,
      }),
    ).toBe(true);
  });

  it("skips when the prompt is disabled", () => {
    expect(
      shouldFocusPromptInput({
        disabled: true,
        activeElement: null,
        promptElement: prompt,
      }),
    ).toBe(false);
  });

  it("skips when the prompt already has focus", () => {
    expect(
      shouldFocusPromptInput({
        disabled: false,
        activeElement: prompt,
        promptElement: prompt,
      }),
    ).toBe(false);
  });

  it("skips when another text field is focused", () => {
    expect(
      shouldFocusPromptInput({
        disabled: false,
        activeElement: target({ tagName: "INPUT" }),
        promptElement: prompt,
      }),
    ).toBe(false);
    expect(
      shouldFocusPromptInput({
        disabled: false,
        activeElement: target({ tagName: "TEXTAREA" }),
        promptElement: prompt,
      }),
    ).toBe(false);
    expect(
      shouldFocusPromptInput({
        disabled: false,
        activeElement: target({
          tagName: "DIV",
          isContentEditable: true,
        }),
        promptElement: prompt,
      }),
    ).toBe(false);
  });

  it("skips when focus is inside a dialog", () => {
    const dialogBtn = target({
      tagName: "BUTTON",
      closest: (sel) =>
        sel.includes('role="dialog"') ? ({} as Element) : null,
    });
    expect(
      shouldFocusPromptInput({
        disabled: false,
        activeElement: dialogBtn,
        promptElement: prompt,
      }),
    ).toBe(false);
  });
});

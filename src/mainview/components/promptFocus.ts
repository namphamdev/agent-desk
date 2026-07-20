/**
 * Decide whether the chat prompt should steal keyboard focus.
 * Used when switching sessions or when the OS window becomes active again.
 */

export type PromptFocusTarget = {
  tagName: string;
  isContentEditable: boolean;
  closest: (selector: string) => Element | null;
};

export type PromptFocusDecision = {
  /** Prompt is disabled (e.g. agent connecting). */
  disabled: boolean;
  /** Currently focused element, or null/body when nothing useful is focused. */
  activeElement: PromptFocusTarget | null;
  /** The prompt textarea itself (so we no-op if it already has focus). */
  promptElement: PromptFocusTarget | null;
};

/**
 * Returns true when it is safe to call focus() on the prompt input.
 * Skips when a modal/dialog is open, or another text field already has focus
 * (browser omnibox, settings search, sidebar rename, etc.).
 */
export function shouldFocusPromptInput(d: PromptFocusDecision): boolean {
  if (d.disabled) return false;

  const active = d.activeElement;
  if (!active) return true;

  // Already on the prompt — nothing to do (caller may still no-op on focus).
  if (d.promptElement && active === d.promptElement) return false;

  // Leave focus inside open overlays / dialogs.
  if (
    active.closest(
      '[role="dialog"], [role="alertdialog"], [data-slot="dialog-content"], [data-slot="sheet-content"], [data-slot="alert-dialog-content"]',
    )
  ) {
    return false;
  }

  // Do not yank focus out of another editable control.
  const tag = active.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return false;
  }
  if (active.isContentEditable) return false;

  return true;
}

// Markdown block rendering metrics — port of MarkdownBlockView.swift's MD enum.
// Every constant here mirrors the desktop values so the two apps read the same:
// body 14/22, headings (19/27, 16/24, 15/22, 14/22), code 12.5/18, block gap 12.
//
// Font sizes are scaled by the user's minimum-font-size preference via
// Appearance.scaledFontSize(). Layout numbers (padding, gap, radius) are
// palette- and scale-independent and stay fixed.

import { Appearance } from '../theme/Appearance';

export const MD = {
  get textSize() { return Appearance.scaledFontSize(14); },
  get lineHeight() { return Appearance.scaledFontSize(22); },
  blockGap: 12,
  get codeTextSize() { return Appearance.scaledFontSize(12.5); },
  get codeLineHeight() { return Appearance.scaledFontSize(18); },
  codePaddingX: 12,
  codePaddingY: 10,
  inlineCodeRadius: 4.5,

  headingMetrics(level: number): { size: number; line: number } {
    const scale = Appearance.fontScale;
    switch (level) {
      case 1: return { size: 19 * scale, line: 27 * scale };
      case 2: return { size: 16 * scale, line: 24 * scale };
      case 3: return { size: 15 * scale, line: 22 * scale };
      default: return { size: 14 * scale, line: 22 * scale };
    }
  },
} as const;

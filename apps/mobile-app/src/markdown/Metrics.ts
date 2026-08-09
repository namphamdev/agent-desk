// Markdown block rendering metrics — port of MarkdownBlockView.swift's MD enum.
// Every constant here mirrors the desktop values so the two apps read the same:
// body 14/22, headings (19/27, 16/24, 15/22, 14/22), code 12.5/18, block gap 12.

export const MD = {
  textSize: 14,
  lineHeight: 22,
  blockGap: 12,
  codeTextSize: 12.5,
  codeLineHeight: 18,
  codePaddingX: 12,
  codePaddingY: 10,
  inlineCodeRadius: 4.5,

  headingMetrics(level: number): { size: number; line: number } {
    switch (level) {
      case 1: return { size: 19, line: 27 };
      case 2: return { size: 16, line: 24 };
      case 3: return { size: 15, line: 22 };
      default: return { size: 14, line: 22 };
    }
  },
} as const;

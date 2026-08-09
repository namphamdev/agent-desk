// Always-dark monochrome theme — direct port of Theme.swift (and crates/ui
// src/theme.rs). Colors are precomputed from the same oklch definitions so
// every surface lands on identical sRGB values on iOS, Android, and desktop.

import { greyHex, neutralHex, oklchHex, whiteAlpha, withAlpha } from './color';

// Precomputed oklch palette.
const SURFACE_RAISED_L = 0.235;
const TEXT_L = 0.922;
const TEXT_MUTED_L = 0.708;
const TEXT_FAINT_L = 0.556;

const ACCENT = oklchHex(0.673, 0.182, 276.935); // indigo-400
const ACCENT_STRONG = oklchHex(0.585, 0.233, 277.117); // indigo-500
const DANGER = oklchHex(0.704, 0.191, 22.216); // red-400
const DANGER_SOFT = oklchHex(0.808, 0.114, 19.571); // red-300
const WARNING = oklchHex(0.828, 0.189, 84.429); // amber-400

const STATUS_WORKING = oklchHex(0.718, 0.202, 349.761); // pink-400
const STATUS_COMPLETED = oklchHex(0.765, 0.177, 163.223); // emerald-400

// Claude brand orange — kept even on the mono surface (icons.rs claude_brand).
export const CLAUDE_BRAND = '#D97757';

const INLINE_CODE_TEXT = oklchHex(0.811, 0.111, 293.571); // violet-300
const INLINE_CODE_VIOLET = oklchHex(0.702, 0.183, 293.541); // violet-400

const TOKEN_KEYWORD = oklchHex(0.709, 0.129, 20.0); // soft rose
const TOKEN_STRING = oklchHex(0.77, 0.11, 168.0); // soft green
const TOKEN_NUMBER = oklchHex(0.78, 0.12, 80.0); // soft amber

/**
 * The full theme. Plain object — components read fields directly so RN's
 * style cascade works without context plumbing.
 */
export const Theme = {
  // Paint: neutral surfaces.
  bg: greyHex(6),
  surface: greyHex(13),
  surfaceRaised: neutralHex(SURFACE_RAISED_L),
  elementHover: whiteAlpha(0.06),
  elementActive: whiteAlpha(0.1),
  border: whiteAlpha(0.08),
  borderStrong: whiteAlpha(0.14),

  // Paint: text.
  text: neutralHex(TEXT_L),
  textMuted: neutralHex(TEXT_MUTED_L),
  textFaint: neutralHex(TEXT_FAINT_L),

  // Paint: accents.
  accent: ACCENT,
  accentStrong: ACCENT_STRONG,
  danger: DANGER,
  dangerSoft: DANGER_SOFT,
  warning: WARNING,

  // Paint: status dots.
  statusWorking: STATUS_WORKING,
  statusCompleted: STATUS_COMPLETED,
  claudeBrand: CLAUDE_BRAND,

  // Paint: markdown inline code.
  inlineCodeText: INLINE_CODE_TEXT,
  inlineCodeWash: withAlpha(INLINE_CODE_VIOLET, 0.12),

  // Paint: syntax tokens.
  tokenKeyword: TOKEN_KEYWORD,
  tokenString: TOKEN_STRING,
  tokenNumber: TOKEN_NUMBER,

  // Layout numbers (the iOS constants, in dp).
  bubbleRadius: 16,
  panelRadius: 10,
  controlRadius: 6,
  spaceXS: 4,
  spaceSM: 8,
  spaceMD: 12,
  spaceLG: 16,
} as const;

export type ThemeType = typeof Theme;

// Fonts: the same Geist family the iOS app bundles. RN's font resolve requires
// the static weight cut's PostScript name; matches the convention.
export const Fonts = {
  sans: 'Geist',
  sansMedium: 'Geist-Medium',
  sansSemiBold: 'Geist-SemiBold',
  sansBold: 'Geist-Bold',
  mono: 'GeistMono-Regular',
} as const;

export type FontWeight = 'regular' | 'medium' | 'semibold' | 'bold';

/** Resolve the PostScript family name for a given logical weight. */
export function sansFamily(weight: FontWeight = 'regular'): string {
  switch (weight) {
    case 'medium': return Fonts.sansMedium;
    case 'semibold': return Fonts.sansSemiBold;
    case 'bold': return Fonts.sansBold;
    default: return Fonts.sans;
  }
}

/** fontFamily for a TextStyle — picks the right Geist cut by weight. */
export function sansFont(weight: FontWeight = 'regular'): string {
  return sansFamily(weight);
}

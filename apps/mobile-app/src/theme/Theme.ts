// Theme — port of Theme.swift (and crates/ui src/theme.rs). Supports both dark
// and light palettes. `Theme` is a getter-backed object so reads always reflect
// the currently active scheme; components re-render via `useAppearance`.

import { blackAlpha, greyHex, neutralHex, oklchHex, whiteAlpha, withAlpha } from './color';

// Shared oklch accent definitions (used by both palettes).
const ACCENT = oklchHex(0.673, 0.182, 276.935); // indigo-400
const ACCENT_STRONG = oklchHex(0.585, 0.233, 277.117); // indigo-500

const STATUS_WORKING = oklchHex(0.718, 0.202, 349.761); // pink-400
const STATUS_COMPLETED = oklchHex(0.765, 0.177, 163.223); // emerald-400

// Claude brand orange — kept even on the mono surface (icons.rs claude_brand).
export const CLAUDE_BRAND = '#D97757';

interface Palette {
  bg: string;
  surface: string;
  surfaceRaised: string;
  elementHover: string;
  elementActive: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  accentStrong: string;
  danger: string;
  dangerSoft: string;
  warning: string;
  statusWorking: string;
  statusCompleted: string;
  claudeBrand: string;
  inlineCodeText: string;
  inlineCodeWash: string;
  tokenKeyword: string;
  tokenString: string;
  tokenNumber: string;
}

// Dark palette — the original always-dark monochrome values.
const DARK: Palette = {
  bg: greyHex(6),
  surface: greyHex(13),
  surfaceRaised: neutralHex(0.235),
  elementHover: whiteAlpha(0.06),
  elementActive: whiteAlpha(0.1),
  border: whiteAlpha(0.08),
  borderStrong: whiteAlpha(0.14),

  text: neutralHex(0.922),
  textMuted: neutralHex(0.708),
  textFaint: neutralHex(0.556),

  accent: ACCENT,
  accentStrong: ACCENT_STRONG,
  danger: oklchHex(0.704, 0.191, 22.216), // red-400
  dangerSoft: oklchHex(0.808, 0.114, 19.571), // red-300
  warning: oklchHex(0.828, 0.189, 84.429), // amber-400

  statusWorking: STATUS_WORKING,
  statusCompleted: STATUS_COMPLETED,
  claudeBrand: CLAUDE_BRAND,

  inlineCodeText: oklchHex(0.811, 0.111, 293.571), // violet-300
  inlineCodeWash: withAlpha(oklchHex(0.702, 0.183, 293.541), 0.12),

  tokenKeyword: oklchHex(0.709, 0.129, 20.0),
  tokenString: oklchHex(0.77, 0.11, 168.0),
  tokenNumber: oklchHex(0.78, 0.12, 80.0),
};

// Light palette — derived from the same oklch definitions, mirrored across the
// L axis so surfaces read as warm paper rather than inverted dark.
const LIGHT: Palette = {
  bg: greyHex(250), // #fafafa
  surface: greyHex(252), // #fcfcfc
  surfaceRaised: greyHex(255),
  elementHover: blackAlpha(0.04),
  elementActive: blackAlpha(0.07),
  border: blackAlpha(0.08),
  borderStrong: blackAlpha(0.14),

  text: neutralHex(0.18),
  textMuted: neutralHex(0.42),
  textFaint: neutralHex(0.58),

  accent: ACCENT,
  accentStrong: ACCENT_STRONG,
  danger: oklchHex(0.578, 0.215, 22.216), // red-500 (darker for contrast)
  dangerSoft: oklchHex(0.5, 0.2, 19.571),
  warning: oklchHex(0.65, 0.18, 60.0), // amber-600

  statusWorking: oklchHex(0.55, 0.2, 349.761),
  statusCompleted: oklchHex(0.55, 0.16, 163.223),
  claudeBrand: CLAUDE_BRAND,

  inlineCodeText: oklchHex(0.4, 0.13, 293.571), // deeper violet for paper
  inlineCodeWash: withAlpha(oklchHex(0.5, 0.18, 293.541), 0.1),

  tokenKeyword: oklchHex(0.48, 0.16, 20.0),
  tokenString: oklchHex(0.4, 0.11, 168.0),
  tokenNumber: oklchHex(0.45, 0.14, 80.0),
};

export type ThemeScheme = 'dark' | 'light';

let activeScheme: ThemeScheme = 'dark';

/** Switch the active palette. Called by AppRoot when the appearance changes. */
export function setActiveScheme(scheme: ThemeScheme): void {
  activeScheme = scheme;
}

/** Read the currently active scheme. */
export function getActiveScheme(): ThemeScheme {
  return activeScheme;
}

function palette(): Palette {
  return activeScheme === 'light' ? LIGHT : DARK;
}

/**
 * Overlay alpha — returns white-alpha on dark surfaces, black-alpha on light.
 * Use in inline styles for hairlines and washes so a single expression works
 * in both palettes. (Module-level StyleSheets that capture this at import
 * time will be stale on scheme switch; prefer inline styles or `useStyles`.)
 */
export function overlay(alpha: number): string {
  return activeScheme === 'light' ? blackAlpha(alpha) : whiteAlpha(alpha);
}

/**
 * Getter-backed theme object. Field reads always reflect the active palette,
 * so any component subscribed to `useAppearance` sees fresh values on the
 * next render without threading a new object through props.
 */
export const Theme: Palette & {
  bubbleRadius: number;
  panelRadius: number;
  controlRadius: number;
  spaceXS: number;
  spaceSM: number;
  spaceMD: number;
  spaceLG: number;
} = {
  get bg() { return palette().bg; },
  get surface() { return palette().surface; },
  get surfaceRaised() { return palette().surfaceRaised; },
  get elementHover() { return palette().elementHover; },
  get elementActive() { return palette().elementActive; },
  get border() { return palette().border; },
  get borderStrong() { return palette().borderStrong; },
  get text() { return palette().text; },
  get textMuted() { return palette().textMuted; },
  get textFaint() { return palette().textFaint; },
  get accent() { return palette().accent; },
  get accentStrong() { return palette().accentStrong; },
  get danger() { return palette().danger; },
  get dangerSoft() { return palette().dangerSoft; },
  get warning() { return palette().warning; },
  get statusWorking() { return palette().statusWorking; },
  get statusCompleted() { return palette().statusCompleted; },
  get claudeBrand() { return palette().claudeBrand; },
  get inlineCodeText() { return palette().inlineCodeText; },
  get inlineCodeWash() { return palette().inlineCodeWash; },
  get tokenKeyword() { return palette().tokenKeyword; },
  get tokenString() { return palette().tokenString; },
  get tokenNumber() { return palette().tokenNumber; },

  // Layout numbers (the iOS constants, in dp) — palette-independent.
  bubbleRadius: 16,
  panelRadius: 10,
  controlRadius: 6,
  spaceXS: 4,
  spaceSM: 8,
  spaceMD: 12,
  spaceLG: 16,
};

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

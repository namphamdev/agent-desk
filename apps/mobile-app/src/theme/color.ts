// oklch → sRGB conversion, byte-compatible with the iOS Theme.swift port
// and the desktop crates/ui/src/theme.rs. Numbers drive layout, colors are paint.
//
// Inputs: L 0..1, C, H degrees. Output: [r, g, b] each 0..1, clamped.

export function oklchToSrgb(l: number, c: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);

  // OKLab → LMS (cube roots undone)
  const l_ = l + 0.39633778 * a + 0.21580376 * b;
  const m_ = l - 0.105561346 * a - 0.06385417 * b;
  const s_ = l - 0.08948418 * a - 1.2914855 * b;
  const l3 = l_ * l_ * l_;
  const m3 = m_ * m_ * m_;
  const s3 = s_ * s_ * s_;

  // LMS → linear sRGB
  const r = 4.0767417 * l3 - 3.3077116 * m3 + 0.23096993 * s3;
  const g = -1.268438 * l3 + 2.6097574 * m3 - 0.3413194 * s3;
  const bl = -0.0041960863 * l3 - 0.7034186 * m3 + 1.7076147 * s3;

  return [gammaEncode(r), gammaEncode(g), gammaEncode(bl)];
}

function gammaEncode(x: number): number {
  const clamped = Math.min(Math.max(x, 0), 1);
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

function rgbToHex(r: number, g: number, b: number): string {
  const toByte = (v: number) => Math.round(Math.min(Math.max(v, 0), 1) * 255)
    .toString(16)
    .padStart(2, '0');
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

/** oklch(L, C, Hdegrees) → #rrggbb */
export function oklchHex(l: number, c: number, hDeg: number): string {
  const [r, g, b] = oklchToSrgb(l, c, hDeg);
  return rgbToHex(r, g, b);
}

/** Neutral (chroma 0) tone by lightness — r == g == b exactly. */
export function neutralHex(lightness: number): string {
  return oklchHex(lightness, 0, 0);
}

/** 8-bit channel value → hex, e.g. grey(13) === #0d0d0d. */
export function greyHex(value: number): string {
  const v = Math.min(Math.max(value, 0), 255);
  const hex = Math.round(v).toString(16).padStart(2, '0');
  return `#${hex}${hex}${hex}`;
}

/** Hex color + alpha → rgba() string (alpha 0..1). */
export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Mix alpha into white — the hairline/wash primitive. */
export function whiteAlpha(alpha: number): string {
  return `rgba(255, 255, 255, ${alpha})`;
}

export function parseHex(hex: string): { r: number; g: number; b: number } {
  let h = hex.replace('#', '');
  if (h.length === 3) {
    h = h.split('').map((c) => c + c).join('');
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return { r, g, b };
}

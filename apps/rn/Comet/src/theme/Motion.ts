// Animation kit — port of Motion.swift (crates/ui/src/motion.rs).
// Reduced-motion is honored at call sites via motionTransition helpers.

// Signature entrance: 500ms cubic-bezier(0.16, 1, 0.3, 1), translateY 4→0.
export const Motion = {
  fadeIn: { duration: 500, easing: (t: number) => cubicBezier(t, 0.16, 1, 0.3, 1) },
  fadeQuick: { duration: 150, easing: (t: number) => cubicBezier(t, 0.25, 0.1, 0.25, 1) },
  menuIn: { duration: 140, easing: (t: number) => cubicBezier(t, 0.25, 0.1, 0.25, 1) },
  dialogIn: { duration: 180, easing: (t: number) => cubicBezier(t, 0.25, 0.1, 0.25, 1) },
  resize: { duration: 200, easing: (t: number) => cubicBezier(t, 0, 0, 0.58, 1) },
  collapse: { duration: 180, easing: (t: number) => cubicBezier(t, 0, 0, 0.58, 1) },
  resort: { duration: 260, easing: (t: number) => cubicBezier(t, 0.22, 1, 0.36, 1) },
  hoverFade: { duration: 150, easing: (t: number) => cubicBezier(t, 0.4, 0, 0.2, 1) },

  // WorkingIndicator wave period (GRADIENT_SPIN) and loader pulse.
  gradientSpinPeriod: 0.75,
  cometPulsePeriod: 2.4,

  flavourWords: [
    'Thinking', 'Pondering', 'Scheming', 'Brewing', 'Weaving', 'Tinkering',
    'Musing', 'Composing', 'Sifting', 'Untangling', 'Distilling', 'Sketching',
    'Plotting', 'Riffing', 'Combobulating', 'Percolating', 'Marinating',
    'Noodling', 'Puzzling', 'Conjuring',
  ],
  flavourRotateSecs: 7,
} as const;

/** FNV-1a hash — matches the desktop's per-chat flavour seeding. */
export function flavourSeed(chatId: string): bigint {
  // Use BigInt to match UInt64 arithmetic.
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < chatId.length; i++) {
    hash ^= BigInt(chatId.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash;
}

export function flavourWord(seed: bigint, elapsedSecs: number): string {
  const safe = Math.max(0, Math.floor(elapsedSecs));
  const idx = Number((seed + BigInt(Math.floor(safe / Motion.flavourRotateSecs))) %
    BigInt(Motion.flavourWords.length));
  return Motion.flavourWords[idx];
}

export function formatElapsed(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Cubic Bezier (single-input) — ported from CSS easing constants. */
export function cubicBezier(t: number, x1: number, y1: number, x2: number, y2: number): number {
  // Newton-Raphson on x(t) = t to find parameter for given progress t.
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  let guess = t;
  for (let i = 0; i < 8; i++) {
    const x = bezierAxis(guess, x1, x2) - t;
    if (Math.abs(x) < 1e-6) break;
    const dx = bezierDeriv(guess, x1, x2);
    if (Math.abs(dx) < 1e-6) break;
    guess -= x / dx;
  }
  return bezierAxis(guess, y1, y2);
}

function bezierAxis(t: number, a: number, b: number): number {
  const u = 1 - t;
  return 3 * a * u * u * t + 3 * b * u * t * t + t * t * t;
}

function bezierDeriv(t: number, a: number, b: number): number {
  const u = 1 - t;
  return 3 * a * u * u + 6 * b * u * t + 3 * t * t;
}

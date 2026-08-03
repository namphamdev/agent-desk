// Streaming fade-in veil — TS port of Veil.swift. Paint-only: newly appended
// text dissolves in by multiplying a fading alpha into its color. Fade
// duration tracks the append cadence (EMA of inter-chunk gaps); a re-attach
// seeds the baseline so already-streamed text never re-fades.

const EMA_SEED_MS = 160;
const MIN_FADE_MS = 120;
const MAX_FADE_MS = 400;
const CURVE_POW = 1.6;
const GAP_CLAMP_MS = 1000;

interface VeilSpan {
  start: number;
  end: number;
  startMs: number;
  durationMs: number;
}

export class RowVeil {
  private spans: VeilSpan[] = [];
  private settledLength: number;
  private emaMs = EMA_SEED_MS;
  private lastAppendMs: number | null = null;

  constructor(seededLength = 0) {
    this.settledLength = seededLength;
  }

  /** Register growth to `newLength`; the delta becomes a fading span. */
  noteLength(newLength: number): void {
    const covered = this.settledLength + this.coveredLength();
    if (newLength <= covered) return;
    const now = Date.now();
    if (this.lastAppendMs !== null) {
      const gap = Math.min(now - this.lastAppendMs, GAP_CLAMP_MS);
      this.emaMs = this.emaMs * 0.7 + gap * 0.3;
    }
    this.lastAppendMs = now;
    // Fast-stream boost: concurrent chunks fade slightly slower.
    const active = this.spans.filter((s) => now - s.startMs < s.durationMs).length;
    const boost = 1 + 0.3 * Math.max(0, active - 2);
    const duration = Math.min(Math.max(this.emaMs * 3, MIN_FADE_MS), MAX_FADE_MS) * boost;
    this.spans.push({ start: covered, end: newLength, startMs: now, durationMs: duration });
    this.prune(now);
  }

  private coveredLength(): number {
    return this.spans.reduce((acc, s) => acc + (s.end - s.start), 0);
  }

  private prune(now: number): void {
    let absorbed = 0;
    for (const span of this.spans) {
      if (now - span.startMs >= span.durationMs) {
        absorbed = Math.max(absorbed, span.end);
      } else {
        break;
      }
    }
    if (absorbed > 0) {
      this.settledLength = Math.max(this.settledLength, absorbed);
      this.spans = this.spans.filter((s) => s.end > absorbed);
    }
  }

  get isFading(): boolean {
    const now = Date.now();
    return this.spans.some((s) => now - s.startMs < s.durationMs);
  }

  static opacity(progress: number): number {
    const p = Math.min(Math.max(progress, 0), 1);
    return 1 - Math.pow(1 - p, CURVE_POW);
  }

  /** Contiguous (range, alpha) segments over a text of `totalLength`. */
  segments(totalLength: number): Array<{ start: number; end: number; alpha: number }> {
    const now = Date.now();
    const out: Array<{ start: number; end: number; alpha: number }> = [];
    let cursor = 0;
    const sorted = [...this.spans].sort((a, b) => a.start - b.start);
    for (const span of sorted) {
      const lower = Math.min(span.start, totalLength);
      const upper = Math.min(span.end, totalLength);
      if (lower > cursor) out.push({ start: cursor, end: lower, alpha: 1 });
      if (upper > lower) {
        const progress = Math.min(Math.max((now - span.startMs) / span.durationMs, 0), 1);
        out.push({ start: lower, end: upper, alpha: RowVeil.opacity(progress) });
      }
      cursor = Math.max(cursor, upper);
    }
    if (cursor < totalLength) out.push({ start: cursor, end: totalLength, alpha: 1 });
    return out;
  }
}

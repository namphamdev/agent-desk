/** Screen / frame geometry helpers for window placement. */

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DisplayInfo = {
  bounds: Rect;
  workArea: Rect;
  isPrimary?: boolean;
};

/** True if point is inside the half-open rectangle [x, x+w) × [y, y+h). */
export function pointInRect(x: number, y: number, r: Rect): boolean {
  return (
    x >= r.x &&
    x < r.x + r.width &&
    y >= r.y &&
    y < r.y + r.height
  );
}

/** Display whose bounds contain the point, or null. */
export function displayForPoint(
  displays: DisplayInfo[],
  x: number,
  y: number,
): DisplayInfo | null {
  return displays.find((d) => pointInRect(x, y, d.bounds)) ?? null;
}

/**
 * Work area (screen minus taskbar/dock) for the display under the window
 * center. Falls back to primary, then first display, then the frame itself.
 */
export function workAreaForFrame(
  displays: DisplayInfo[],
  frame: Rect,
): Rect {
  if (displays.length === 0) {
    return { ...frame };
  }
  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height / 2;
  const hit =
    displayForPoint(displays, cx, cy) ??
    displays.find((d) => d.isPrimary) ??
    displays[0]!;
  return { ...hit.workArea };
}

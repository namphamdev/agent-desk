import { describe, expect, it } from "bun:test";
import {
  displayForPoint,
  workAreaForFrame,
  type DisplayInfo,
} from "./window-geometry";

const primary: DisplayInfo = {
  isPrimary: true,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  // 40px taskbar at bottom
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};

const secondary: DisplayInfo = {
  isPrimary: false,
  bounds: { x: 1920, y: 0, width: 1440, height: 900 },
  workArea: { x: 1920, y: 0, width: 1440, height: 860 },
};

describe("displayForPoint", () => {
  it("finds the display containing the point", () => {
    expect(displayForPoint([primary, secondary], 100, 100)).toBe(primary);
    expect(displayForPoint([primary, secondary], 2000, 50)).toBe(secondary);
  });

  it("returns null when outside all displays", () => {
    expect(displayForPoint([primary], -10, 10)).toBeNull();
  });
});

describe("workAreaForFrame", () => {
  it("uses work area of the display under the window center", () => {
    const frame = { x: 100, y: 100, width: 1280, height: 840 };
    expect(workAreaForFrame([primary, secondary], frame)).toEqual(
      primary.workArea,
    );
  });

  it("picks secondary when the window is centered there", () => {
    const frame = { x: 2000, y: 40, width: 800, height: 600 };
    expect(workAreaForFrame([primary, secondary], frame)).toEqual(
      secondary.workArea,
    );
  });

  it("falls back to primary when center is off-screen", () => {
    const frame = { x: -5000, y: -5000, width: 100, height: 100 };
    expect(workAreaForFrame([primary, secondary], frame)).toEqual(
      primary.workArea,
    );
  });

  it("returns a copy of the frame when no displays are known", () => {
    const frame = { x: 10, y: 20, width: 30, height: 40 };
    expect(workAreaForFrame([], frame)).toEqual(frame);
  });

  it("excludes taskbar height from the maximized size", () => {
    const frame = { x: 160, y: 120, width: 1280, height: 840 };
    const area = workAreaForFrame([primary], frame);
    expect(area.height).toBe(1040);
    expect(primary.bounds.height - area.height).toBe(40);
  });
});

// The actual comet mark — the desktop's 34-cell logo
// (crates/ui/assets/icons/comet-logo.svg), rendered with rounded rects at
// the same cells and tinted by `color`.

import React from 'react';
import { Svg, Rect } from 'react-native-svg';

import { Theme } from './Theme';

const CELLS: Array<{ x: number; y: number }> = [
  { x: 0, y: 600 }, { x: 0, y: 720 }, { x: 240, y: 840 }, { x: 240, y: 720 },
  { x: 120, y: 840 }, { x: 120, y: 600 }, { x: 240, y: 600 }, { x: 0, y: 480 },
  { x: 0, y: 360 }, { x: 480, y: 840 }, { x: 480, y: 720 }, { x: 120, y: 360 },
  { x: 120, y: 240 }, { x: 240, y: 360 }, { x: 600, y: 720 }, { x: 480, y: 600 },
  { x: 360, y: 360 }, { x: 240, y: 240 }, { x: 600, y: 600 }, { x: 720, y: 600 },
  { x: 720, y: 480 }, { x: 240, y: 120 }, { x: 600, y: 380 }, { x: 720, y: 240 },
  { x: 720, y: 0 }, { x: 480, y: 240 }, { x: 480, y: 0 }, { x: 120, y: 480 },
  { x: 240, y: 480 }, { x: 360, y: 840 }, { x: 360, y: 720 }, { x: 360, y: 600 },
  { x: 360, y: 480 }, { x: 120, y: 720 },
];

interface CometMarkProps {
  size?: number;
  color?: string;
}

export function CometMark({ size = 72, color = Theme.text }: CometMarkProps) {
  const aspect = 820 / 940;
  const w = size;
  const h = size / aspect;
  return (
    <Svg width={w} height={h} viewBox="0 0 820 940" fill="none">
      {CELLS.map((cell, i) => (
        <Rect
          key={i}
          x={cell.x}
          y={cell.y}
          width={100}
          height={100}
          rx={16}
          ry={16}
          fill={color}
        />
      ))}
    </Svg>
  );
}

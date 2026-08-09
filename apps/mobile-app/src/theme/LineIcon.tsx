// Stroked UI glyphs — the desktop's hand-drawn Solar-Linear-style icons
// (crates/ui/assets/icons), rendered via react-native-svg with the same path
// data, stroked at the same 1.5/24 weight with round caps/joins.

import React from 'react';
import { Svg, Path, Circle } from 'react-native-svg';

import { Theme } from './Theme';

export type LineIconKind =
  | 'gitBranch'
  | 'gitCommit'
  | 'folder'
  | 'folderWithFiles'
  | 'plus'
  | 'minus'
  | 'undo'
  | 'check'
  | 'upload'
  | 'download'
  | 'sparkles'
  | 'ban';

interface LineIconDef {
  paths: string[];
  circles: Array<{ cx: number; cy: number; r: number }>;
}

const LINE_ICONS: Record<LineIconKind, LineIconDef> = {
  gitBranch: {
    paths: ['M6.5 7.75v8.5', 'M17.5 9.75c0 2.9-2.6 4.35-6.2 4.72c-1.9.2-3.3.9-4 2.03'],
    circles: [
      { cx: 6.5, cy: 5.5, r: 2.25 },
      { cx: 6.5, cy: 18.5, r: 2.25 },
      { cx: 17.5, cy: 7.5, r: 2.25 },
    ],
  },
  folder: {
    paths: [
      'M18 10h-5',
      'M2 6.95c0-.883 0-1.324.07-1.692A4 4 0 0 1 5.257 2.07C5.626 2 6.068 2 6.95 2c.386 0 .58 0 .766.017a4 4 0 0 1 2.18.904c.144.119.28.255.554.529L11 4c.816.816 1.224 1.224 1.712 1.495a4 4 0 0 0 .848.352C14.098 6 14.675 6 15.828 6h.374c2.632 0 3.949 0 4.804.77q.119.105.224.224c.77.855.77 2.172.77 4.804V14c0 3.771 0 5.657-1.172 6.828S17.771 22 14 22h-4c-3.771 0-5.657 0-6.828-1.172S2 17.771 2 14z',
    ],
    circles: [],
  },
  folderWithFiles: {
    paths: [
      'M18 10h-5',
      'M10 3h6.5c.464 0 .697 0 .892.026a3 3 0 0 1 2.582 2.582c.026.195.026.428.026.892',
      'M2 6.95c0-.883 0-1.324.07-1.692A4 4 0 0 1 5.257 2.07C5.626 2 6.068 2 6.95 2c.386 0 .58 0 .766.017a4 4 0 0 1 2.18.904c.144.119.28.255.554.529L11 4c.816.816 1.224 1.224 1.712 1.495a4 4 0 0 0 .848.352C14.098 6 14.675 6 15.828 6h.374c2.632 0 3.949 0 4.804.77q.119.105.224.224c.77.855.77 2.172.77 4.804V14c0 3.771 0 5.657-1.172 6.828S17.771 22 14 22h-4c-3.771 0-5.657 0-6.828-1.172S2 17.771 2 14z',
    ],
    circles: [],
  },
  gitCommit: {
    paths: ['M12 8v8', 'M5 12H2', 'M22 12h-3'],
    circles: [{ cx: 12, cy: 12, r: 3 }],
  },
  plus: {
    paths: ['M12 5v14', 'M5 12h14'],
    circles: [],
  },
  minus: {
    paths: ['M5 12h14'],
    circles: [],
  },
  undo: {
    paths: [
      'M9 14L4 9l5-5',
      'M4 9h11a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5h-4',
    ],
    circles: [],
  },
  check: {
    paths: ['M5 12.5l4.5 4.5L19 7.5'],
    circles: [],
  },
  upload: {
    paths: [
      'M12 16V4',
      'M7 9l5-5 5 5',
      'M5 20h14',
    ],
    circles: [],
  },
  download: {
    paths: [
      'M12 4v12',
      'M7 11l5 5 5-5',
      'M5 20h14',
    ],
    circles: [],
  },
  sparkles: {
    paths: [
      'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
      'M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z',
    ],
    circles: [],
  },
  ban: {
    paths: ['M19 5L5 19'],
    circles: [{ cx: 12, cy: 12, r: 9 }],
  },
};

interface LineIconProps {
  icon: LineIconKind;
  size?: number;
  color?: string;
}

export function LineIcon({ icon, size = 14, color = Theme.textMuted }: LineIconProps) {
  const def = LINE_ICONS[icon];
  const strokeWidth = (1.5 * size) / 24;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {def.paths.map((d, i) => (
        <Path
          key={`p-${i}`}
          d={d}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {def.circles.map((c, i) => (
        <Circle
          key={`c-${i}`}
          cx={c.cx}
          cy={c.cy}
          r={c.r}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
        />
      ))}
    </Svg>
  );
}

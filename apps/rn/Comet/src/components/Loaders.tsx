// Loaders + status indicators — RN port of Loaders.swift.
// Gradient spin (3x3 cell grid with sunrise tints, per-row phase), mini
// spinner (2x3 perimeter), comet pulse (5 cells, cosine wave).

import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, View } from 'react-native';

import { Motion } from '../theme/Motion';
import { Theme } from '../theme/Theme';
import { withAlpha } from '../theme/color';

const ROW_TINTS = [
  withAlpha('#B6D3EF', 1),
  withAlpha('#EDB185', 1),
  withAlpha('#F888A0', 1),
];

const DIM = 0.1;

// gspin_opacity: full at 0, ease down to dim by 45%, hold to 92%, rise to 1.
function opacityAt(phase: number): number {
  const p = ((phase % 1) + 1) % 1;
  if (p < 0.45) {
    const t = p / 0.45;
    return 1 - (1 - DIM) * (t * t * (3 - 2 * t));
  }
  if (p < 0.92) return DIM;
  const t = (p - 0.92) / 0.08;
  return DIM + (1 - DIM) * t;
}

/** 3×3 working spinner. */
export function WorkingSpinner({ cellSize = 2.5 }: { cellSize?: number }) {
  const [tick, setTick] = useState(0);
  const raf = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    const start = Date.now();
    raf.current = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      setTick(elapsed / Motion.gradientSpinPeriod);
    }, 1000 / 30);
    return () => {
      if (raf.current) clearInterval(raf.current);
    };
  }, []);

  return (
    <View style={{ flexDirection: 'column', gap: cellSize * 0.8 }}>
      {[0, 1, 2].map((row) => (
        <View key={row} style={{ flexDirection: 'row', gap: cellSize * 0.8 }}>
          {[0, 1, 2].map((col) => {
            const dx = col - 1;
            const dy = 2 - row;
            const dist = Math.sqrt(dx * dx + dy * dy) / 2.5;
            return (
              <View
                key={col}
                style={{
                  width: cellSize,
                  height: cellSize,
                  backgroundColor: ROW_TINTS[row],
                  opacity: opacityAt(tick - dist),
                }}
              />
            );
          })}
        </View>
      ))}
    </View>
  );
}

/** 2×3 mini spinner — perimeter ring, clockwise. */
export function MiniSpinner({ cellSize = 2 }: { cellSize?: number }) {
  const ring = [
    { row: 0, col: 0 }, { row: 0, col: 1 },
    { row: 1, col: 1 }, { row: 2, col: 1 },
    { row: 2, col: 0 }, { row: 1, col: 0 },
  ];
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      setTick(elapsed / Motion.gradientSpinPeriod);
    }, 1000 / 30);
    return () => clearInterval(id);
  }, []);

  return (
    <View style={{ flexDirection: 'column', gap: cellSize * 0.8 }}>
      {[0, 1, 2].map((row) => (
        <View key={row} style={{ flexDirection: 'row', gap: cellSize * 0.8 }}>
          {[0, 1].map((col) => {
            const ix = ring.findIndex((r) => r.row === row && r.col === col);
            const phase = ix / ring.length;
            return (
              <View
                key={col}
                style={{
                  width: cellSize,
                  height: cellSize,
                  backgroundColor: ROW_TINTS[row],
                  opacity: opacityAt(tick - phase),
                }}
              />
            );
          })}
        </View>
      ))}
    </View>
  );
}

/** comet-pulse: 5 cells, cosine wave, stagger 0.15/2.4. */
export function CometPulse({ cellSize = 6 }: { cellSize?: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      setTick(elapsed);
    }, 1000 / 30);
    return () => clearInterval(id);
  }, []);

  return (
    <View style={{ flexDirection: 'row', gap: cellSize / 2 }}>
      {[0, 1, 2, 3, 4].map((ix) => {
        const phase = ((tick / Motion.cometPulsePeriod - ix * (0.15 / 2.4)) % 1 + 1) % 1;
        const wave = (1 - Math.cos(phase * 2 * Math.PI)) / 2;
        return (
          <View
            key={ix}
            style={{
              width: cellSize,
              height: cellSize,
              borderRadius: cellSize * 0.25,
              backgroundColor: Theme.text,
              opacity: 0.08 + 0.92 * wave,
              transform: [{ scale: 0.9 + 0.1 * wave }],
            }}
          />
        );
      })}
    </View>
  );
}

// MARK: - Status dot

export function indicatorDotColor(indicator: 'working' | 'awaitingInput' | 'errored' | 'completed' | 'idle'): string {
  switch (indicator) {
    case 'working': return withAlpha(Theme.statusWorking, 0.85);
    case 'awaitingInput': return withAlpha(Theme.accent, 0.9);
    case 'errored': return Theme.danger;
    case 'completed': return withAlpha(Theme.statusCompleted, 0.9);
    case 'idle': return 'rgba(255,255,255,0.14)';
  }
}

/** The 6pt leading rail. Working swaps in the mini spinner. */
export function StatusRail({ indicator }: { indicator: 'working' | 'awaitingInput' | 'errored' | 'completed' | 'idle' }) {
  return (
    <View style={{ width: 6, height: 10, justifyContent: 'center', alignItems: 'center' }}>
      {indicator === 'working' ? (
        <MiniSpinner />
      ) : (
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: indicatorDotColor(indicator),
          }}
        />
      )}
    </View>
  );
}

// Easing helper for FadeIn transitions used elsewhere.
export const FadeEasing = Easing.bezier(0.16, 1, 0.3, 1);
export const AnimatedOpacity = Animated.createAnimatedComponent(View);

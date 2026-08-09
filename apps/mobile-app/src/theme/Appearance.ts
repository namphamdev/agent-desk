// Appearance preferences — persisted user choices for theme mode (dark/light/
// system) and minimum font size. Components subscribe via `useAppearance` so
// React re-renders when the user changes settings.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useMemo, useState } from 'react';

export type ThemeMode = 'system' | 'dark' | 'light';

const KEY_THEME_MODE = 'appearance.themeMode';
const KEY_MIN_FONT_SIZE = 'appearance.minFontSize';

/**
 * Minimum body font size in dp. The user picks the floor; fonts scale up from
 * there proportionally. Default 14 matches the pre-existing MD.textSize.
 */
export const DEFAULT_MIN_FONT_SIZE = 14;
export const MIN_FONT_SIZE_FLOOR = 12;
export const MIN_FONT_SIZE_CEIL = 22;

export const FONT_SIZE_OPTIONS: number[] = [
  12, 13, 14, 15, 16, 17, 18, 20, 22,
];

type Listener = () => void;

class AppearanceManager {
  themeMode: ThemeMode = 'system';
  minFontSize: number = DEFAULT_MIN_FONT_SIZE;
  private listeners = new Set<Listener>();
  private hydrated = false;
  private hydratePromise: Promise<void> | null = null;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  /** Resolve to a concrete palette key given the device's system preference. */
  effectiveScheme(systemPref: 'light' | 'dark'): 'dark' | 'light' {
    if (this.themeMode === 'system') return systemPref;
    return this.themeMode;
  }

  /** Multiplier applied to base font sizes. minFontSize acts as the floor for
   * the body text size (14 baseline); other sizes scale by the same ratio so
   * headings, code, and meta stay proportional. */
  get fontScale(): number {
    return this.minFontSize / DEFAULT_MIN_FONT_SIZE;
  }

  /** Scale a base font size by the user's minimum-font-size preference. */
  scaledFontSize(base: number): number {
    return Math.round(base * this.fontScale * 10) / 10;
  }

  async hydrate(): Promise<void> {
    if (this.hydrated) return this.hydratePromise ?? Promise.resolve();
    if (this.hydratePromise) return this.hydratePromise;
    this.hydratePromise = (async () => {
      const [mode, size] = await Promise.all([
        AsyncStorage.getItem(KEY_THEME_MODE),
        AsyncStorage.getItem(KEY_MIN_FONT_SIZE),
      ]);
      if (mode === 'dark' || mode === 'light' || mode === 'system') {
        this.themeMode = mode;
      }
      const parsed = size ? parseInt(size, 10) : NaN;
      if (!Number.isNaN(parsed)) {
        this.minFontSize = Math.min(
          Math.max(parsed, MIN_FONT_SIZE_FLOOR),
          MIN_FONT_SIZE_CEIL,
        );
      }
      this.hydrated = true;
      this.notify();
    })();
    return this.hydratePromise;
  }

  setThemeMode(mode: ThemeMode): void {
    this.themeMode = mode;
    void AsyncStorage.setItem(KEY_THEME_MODE, mode);
    this.notify();
  }

  setMinFontSize(size: number): void {
    const clamped = Math.min(Math.max(size, MIN_FONT_SIZE_FLOOR), MIN_FONT_SIZE_CEIL);
    this.minFontSize = clamped;
    void AsyncStorage.setItem(KEY_MIN_FONT_SIZE, String(clamped));
    this.notify();
  }
}

export const Appearance = new AppearanceManager();

/**
 * React hook — re-renders the calling component whenever the appearance
 * preferences change. Returns the manager so components can read the latest
 * values directly.
 */
export function useAppearance(): AppearanceManager {
  const [, setN] = useState(0);
  useEffect(() => Appearance.subscribe(() => setN((n) => n + 1)), []);
  return Appearance;
}

/**
 * Memoized themed-styles factory. The factory re-runs whenever the active
 * scheme or font scale changes, so Theme.* reads inside StyleSheet.create
 * always reflect the current palette. Use for StyleSheet objects that
 * reference theme colors.
 *
 *   const styles = useThemedStyles(() => StyleSheet.create({ ... }), []);
 */
export function useThemedStyles<T>(factory: () => T, deps: unknown[] = []): T {
  // Subscribe so we re-render on appearance changes.
  const [, setN] = useState(0);
  useEffect(() => Appearance.subscribe(() => setN((n) => n + 1)), []);
  // Re-run the factory when the scheme or font scale changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(factory, [Appearance.themeMode, Appearance.minFontSize, ...deps]);
}

/**
 * Font-size scaler — short alias for `Appearance.scaledFontSize(base)`.
 * Apply to every `fontSize: <number>` so the user's minimum-font-size
 * preference is honored app-wide. Must be called at render time (inline
 * styles) or inside a `useThemedStyles` factory so it re-evaluates on
 * appearance changes.
 *
 *   fontSize: fs(14)
 */
export function fs(base: number): number {
  return Appearance.scaledFontSize(base);
}

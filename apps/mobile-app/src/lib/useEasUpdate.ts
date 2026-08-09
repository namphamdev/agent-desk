// EAS Update hook — checks for a new update from EAS, exposes the available
// update (with its changelog message), and drives fetch + reload.
//
// Only meaningful in a release build. In Expo Go / dev the Updates API rejects,
// so we no-op there and report `available: null`.
//
// The changelog text comes from the update message passed to
// `eas update --message` — EAS stores it on the manifest as
// `extra.easUpdateMessage`.

import { useCallback, useRef, useState } from 'react';
import * as Updates from 'expo-updates';

export interface EasUpdateInfo {
  /** Human-readable changelog from `eas update --message`. May be empty. */
  message: string;
  /** ISO timestamp the update was created on the server. */
  createdAt: string;
  /** UUID of the available update. */
  id: string;
}

export interface UseEasUpdateState {
  /** True while a check is in flight. */
  checking: boolean;
  /** True while the update bundle is downloading. */
  downloading: boolean;
  /** The available update, once a check finds one. */
  available: EasUpdateInfo | null;
  /** Error from the last check/fetch, if any. */
  error: string | null;
}

export interface UseEasUpdate extends UseEasUpdateState {
  /** Ask the server for a newer update. Sets `available` if one exists. */
  checkForUpdate: () => Promise<EasUpdateInfo | null>;
  /** Download the available update and restart into it. */
  downloadAndReload: () => Promise<void>;
  /** Clear the `available` info (dismiss the prompt). */
  dismiss: () => void;
}

export function useEasUpdate(): UseEasUpdate {
  const [state, setState] = useState<UseEasUpdateState>({
    checking: false,
    downloading: false,
    available: null,
    error: null,
  });

  // expo-updates is only wired up in release builds; in dev / Expo Go the
  // native module throws on checkForUpdateAsync. isEnabled is a build-time
  // constant, safe to read once into a ref.
  const enabledRef = useRef<boolean>(Updates.isEnabled);

  // Keep the latest available info accessible to downloadAndReload without a
  // stale-closure refetch.
  const availableRef = useRef<EasUpdateInfo | null>(null);

  const checkForUpdate = useCallback(async (): Promise<EasUpdateInfo | null> => {
    if (!enabledRef.current) return null;
    setState((s) => ({ ...s, checking: true, error: null }));
    try {
      const result = await Updates.checkForUpdateAsync();
      if (result.isAvailable && result.manifest) {
        const manifest = result.manifest as {
          extra?: { easUpdateMessage?: string; [k: string]: unknown };
          createdAt: string;
          id: string;
        };
        const info: EasUpdateInfo = {
          message: manifest.extra?.easUpdateMessage ?? '',
          createdAt: manifest.createdAt,
          id: manifest.id,
        };
        availableRef.current = info;
        setState((s) => ({ ...s, available: info, checking: false }));
        return info;
      } else {
        availableRef.current = null;
        setState((s) => ({ ...s, available: null, checking: false }));
        return null;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState((s) => ({ ...s, checking: false, error: msg }));
      throw e;
    }
  }, []);

  const downloadAndReload = useCallback(async () => {
    if (!enabledRef.current || !availableRef.current) return;
    setState((s) => ({ ...s, downloading: true, error: null }));
    try {
      await Updates.fetchUpdateAsync();
      await Updates.reloadAsync();
      // reloadAsync restarts the app; this line only runs if reload failed.
      setState((s) => ({ ...s, downloading: false }));
    } catch (e) {
      setState((s) => ({
        ...s,
        downloading: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  }, []);

  const dismiss = useCallback(() => {
    availableRef.current = null;
    setState((s) => ({ ...s, available: null }));
  }, []);

  return { ...state, checkForUpdate, downloadAndReload, dismiss };
}

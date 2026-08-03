// React bindings for the model — `useAppModel` re-renders subscribers on
// every notify(). The hook stores a forceUpdate counter; components read
// model fields directly so React always sees fresh values.

import { useEffect, useState, useSyncExternalStore } from 'react';

import { AppModel } from '../app/AppModel';
import type { SessionStore } from '../sync/SessionStore';
import type { WorkspaceStore } from '../sync/WorkspaceStore';

export function useAppModel(model: AppModel): void {
  const subscribe = (cb: () => void) => model.subscribe(cb);
  const snap = () => model.phase;
  useSyncExternalStore(subscribe, snap, snap);
}

export function useWorkspaceStore(store: WorkspaceStore | undefined): void {
  const subscribe = (cb: () => void) => (store ? store.subscribe(cb) : () => {});
  const snap = () => store?.chats ?? null;
  useSyncExternalStore(subscribe, snap, snap);
}

export function useSessionStore(store: SessionStore): void {
  const subscribe = (cb: () => void) => store.subscribe(cb);
  const snap = () => store.revision;
  useSyncExternalStore(subscribe, snap, snap);
}

// Force-update hook for one-off re-renders tied to a store's notification.
export function useForceUpdateOnNotify(model: AppModel): number {
  const [n, setN] = useState(0);
  useEffect(() => model.subscribe(() => setN((x) => x + 1)), [model]);
  return n;
}

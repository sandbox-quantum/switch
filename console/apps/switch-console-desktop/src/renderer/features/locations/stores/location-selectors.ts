import { appState } from '@renderer/lib/stores/app-state';
import type { Location } from '@shared/core/locations/locations';
import {
  isUnmountedLocation,
  isUnregisteredLocation,
  type MountedLocation,
  type LocationStore,
} from './location';
import type { LocationManagerStore } from './location-manager';
import type { LocationSettingsStore } from './location-settings-store';
import type { LocationViewStore } from './location-view';

/** Returns the LocationManagerStore from appState. Call only inside `observer` components (or other MobX reactions). */
export function getLocationManagerStore(): LocationManagerStore {
  return appState.locations;
}

/** Call only inside `observer` components (or other MobX reactions). */
export function getLocationStore(locationId: string): LocationStore | undefined {
  return getLocationManagerStore().locations.get(locationId);
}

/** Summary for routing the location shell; call only inside `observer` (or other MobX reactions). */
export type LocationViewKind =
  | 'missing'
  | 'creating'
  | 'bootstrapping'
  | 'mount_error'
  | 'path_not_found'
  | 'idle_unmounted'
  | 'ready';

export function locationViewKind(store: LocationStore | undefined): LocationViewKind {
  if (!store) return 'missing';
  if (isUnregisteredLocation(store)) return 'creating';
  if (isUnmountedLocation(store)) {
    if (store.phase === 'opening') return 'bootstrapping';
    if (store.phase === 'error') {
      if (store.errorCode === 'path-not-found') return 'path_not_found';
      return 'mount_error';
    }
    return 'idle_unmounted';
  }
  return 'ready';
}

/** Returns the mounted location payload if ready, otherwise undefined. */
export function asMounted(store: LocationStore | undefined): MountedLocation | undefined {
  return store?.mountedLocation ?? undefined;
}

/** Returns the id of the first mounted location, or undefined if none are mounted. */
export function firstMountedLocationId(): string | undefined {
  for (const [id, store] of getLocationManagerStore().locations.entries()) {
    if (asMounted(store)) return id;
  }
  return undefined;
}

export function mountedLocationData(store: LocationStore | undefined): Location | null {
  return store?.mountedLocation?.data ?? null;
}

/** Returns the display name from any location store variant. */
export function locationDisplayName(store: LocationStore | undefined): string | undefined {
  return store?.name ?? undefined;
}

export function unmountedMountErrorMessage(store: LocationStore | undefined): string {
  if (store && isUnmountedLocation(store) && store.phase === 'error') {
    if (store.errorCode === 'path-not-found') {
      return `No location found at ${store.error ?? 'the configured path'}`;
    }
    return store.error ?? 'Failed to open location';
  }
  return 'Failed to open location';
}

/** Returns the LocationSettingsStore for a mounted location, or undefined if not ready. */
export function getLocationSettingsStore(locationId: string): LocationSettingsStore | undefined {
  return asMounted(getLocationStore(locationId))?.settings;
}

/** Returns the LocationViewStore for a mounted location, or undefined if not ready. */
export function getLocationViewStore(locationId: string): LocationViewStore | undefined {
  return asMounted(getLocationStore(locationId))?.view;
}

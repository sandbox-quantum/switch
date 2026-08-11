import { makeAutoObservable, observable } from 'mobx';
import { SessionManagerStore } from '@renderer/features/sessions/stores/session-manager';
import { snapshotRegistry } from '@renderer/lib/stores/snapshot-registry';
import type { Location } from '@shared/core/locations/locations';
import type { LocationViewSnapshot } from '@shared/view-state';
import { LocationSettingsStore } from './location-settings-store';
import { LocationViewStore } from './location-view';

export type UnregisteredLocationPhase =
  | 'registering' // onboarding the agent + creating the location row
  | 'error';

export type UnmountedLocationPhase = 'opening' | 'error' | 'closing' | 'idle';

export type LocationMode = 'pick';

/**
 * Holds all mounted-only state for a location. Created atomically by
 * LocationStore.transitionToMounted and disposed on unmount or deletion.
 */
export class MountedLocation {
  readonly sessionManager: SessionManagerStore;
  readonly view: LocationViewStore;
  readonly settings: LocationSettingsStore;
  readonly data: Location;

  private _snapshotDisposer: (() => void) | null = null;

  get snapshot(): LocationViewSnapshot {
    return {
      activeView: this.view.activeView,
      sessionViewTab: this.view.sessionView.tab,
    };
  }

  constructor(data: Location, savedSnapshot?: LocationViewSnapshot) {
    this.data = data;
    this.view = new LocationViewStore();
    this.settings = new LocationSettingsStore(data.id);
    this.sessionManager = new SessionManagerStore(data.id, this.settings);

    if (savedSnapshot) this.view.restoreSnapshot(savedSnapshot);

    makeAutoObservable(this, {
      sessionManager: false,
      view: false,
      settings: false,
    });

    this._snapshotDisposer = snapshotRegistry.register(`location:${data.id}`, () => this.snapshot);
  }

  dispose(): void {
    this.settings.dispose();
    this._snapshotDisposer?.();
    this._snapshotDisposer = null;
  }
}

/**
 * Container class — holds a stable reference in the ObservableMap across all
 * lifecycle transitions. Transitioning replaces `mountedLocation` atomically
 * rather than nulling out individual fields.
 */
export class LocationStore {
  state: 'unregistered' | 'unmounted' | 'mounted';
  id: string;
  name: string | null;
  data: Location | null;
  createdAt: string;
  phase: UnregisteredLocationPhase | UnmountedLocationPhase | null;
  error: string | undefined = undefined;
  errorCode: 'path-not-found' | 'ssh-disconnected' | undefined = undefined;
  mode: LocationMode | null;
  mountedLocation: MountedLocation | null = null;

  constructor(
    state: LocationStore['state'],
    id: string,
    name: string | null,
    data: Location | null,
    phase: UnregisteredLocationPhase | UnmountedLocationPhase | null,
    mode: LocationMode | null = null
  ) {
    this.state = state;
    this.id = id;
    this.name = name;
    this.data = data;
    this.createdAt = data?.createdAt ?? new Date().toISOString();
    this.phase = phase;
    this.mode = mode;
    makeAutoObservable(this, { mountedLocation: observable.ref });
  }

  transitionToMounted(data: Location, savedSnapshot?: LocationViewSnapshot): void {
    this.mountedLocation = new MountedLocation(data, savedSnapshot);
    this.data = data;
    this.id = data.id;
    this.name = data.name;
    this.createdAt = data.createdAt;
    this.state = 'mounted';
    this.phase = null;
    this.error = undefined;
    this.errorCode = undefined;
  }

  transitionToUnmounted(data: Location, phase: UnmountedLocationPhase = 'opening'): void {
    this.mountedLocation?.dispose();
    this.mountedLocation = null;
    this.data = data;
    this.id = data.id;
    this.name = data.name;
    this.createdAt = data.createdAt;
    this.state = 'unmounted';
    this.phase = phase;
    this.error = undefined;
    this.errorCode = undefined;
  }

  transitionToUnregistered(
    id: string,
    name: string,
    phase: UnregisteredLocationPhase,
    mode: LocationMode
  ): void {
    this.mountedLocation?.dispose();
    this.mountedLocation = null;
    this.data = null;
    this.id = id;
    this.name = name;
    this.state = 'unregistered';
    this.phase = phase;
    this.mode = mode;
    this.error = undefined;
  }
}

export type UnregisteredLocation = LocationStore & {
  state: 'unregistered';
  id: string;
  name: string;
  phase: UnregisteredLocationPhase;
  mode: LocationMode;
  error: string | undefined;
};

export type UnmountedLocation = LocationStore & {
  state: 'unmounted';
  data: Location;
  phase: UnmountedLocationPhase;
  error: string | undefined;
  errorCode: 'path-not-found' | 'ssh-disconnected' | undefined;
};

export function isUnregisteredLocation(p: LocationStore): p is UnregisteredLocation {
  return p.state === 'unregistered';
}

export function isUnmountedLocation(p: LocationStore): p is UnmountedLocation {
  return p.state === 'unmounted';
}

export function isMountedLocation(p: LocationStore): p is LocationStore & {
  state: 'mounted';
  mountedLocation: MountedLocation;
  data: Location;
} {
  return p.state === 'mounted';
}

export function createUnregisteredLocation(
  id: string,
  name: string,
  phase: UnregisteredLocationPhase,
  mode: LocationMode = 'pick'
): LocationStore {
  return new LocationStore('unregistered', id, name, null, phase, mode);
}

export function createUnmountedLocation(
  data: Location,
  phase: UnmountedLocationPhase = 'opening'
): LocationStore {
  return new LocationStore('unmounted', data.id, data.name, data, phase);
}

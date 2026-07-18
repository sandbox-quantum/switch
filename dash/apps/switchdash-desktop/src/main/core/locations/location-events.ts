import { HookCore, type Hookable } from '@main/lib/hookable';
import { log } from '@main/lib/logger';
import type { Location } from '@shared/core/locations/locations';

export type LocationCrudHooks = {
  'location:created': (location: Location) => void | Promise<void>;
  'location:deleted': (locationId: string) => void | Promise<void>;
};

class LocationEvents implements Hookable<LocationCrudHooks> {
  private readonly _core = new HookCore<LocationCrudHooks>((name, e) =>
    log.error(`LocationEvents: ${String(name)} hook error`, e)
  );

  on<K extends keyof LocationCrudHooks>(name: K, handler: LocationCrudHooks[K]) {
    return this._core.on(name, handler);
  }

  _emit<K extends keyof LocationCrudHooks>(
    name: K,
    ...args: Parameters<LocationCrudHooks[K]>
  ): void {
    this._core.callHookBackground(name, ...args);
  }
}

export const locationEvents = new LocationEvents();

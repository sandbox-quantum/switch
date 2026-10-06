import { err, ok, type Result } from '@switch-console/shared';
import type { IInitializable } from '@switch-console/shared';
import { events } from '@main/lib/events';
import { HookCore, type Hookable } from '@main/lib/hookable';
import { log } from '@main/lib/logger';
import {
  type LocationSettings,
  type LocationSettingsPage,
} from '@shared/core/location-settings/location-settings';
import { locationSettingsChangedChannel } from '@shared/core/locations/locationEvents';
import type { UpdateLocationSettingsError } from '@shared/core/locations/locations';
import { locationManager } from '../location-manager';
import type { LocationProvider } from '../location-provider';

export type LocationSettingsHooks = {
  'location-settings:changed': (event: {
    locationId: string;
    settings: LocationSettings;
  }) => void | Promise<void>;
};

export class LocationSettingsService implements Hookable<LocationSettingsHooks>, IInitializable {
  private readonly _hooks = new HookCore<LocationSettingsHooks>((name, e) =>
    log.error(`LocationSettingsService: ${String(name)} hook error`, e)
  );
  private _disposeRendererBridge: (() => void) | null = null;

  on<K extends keyof LocationSettingsHooks>(name: K, handler: LocationSettingsHooks[K]) {
    return this._hooks.on(name, handler);
  }

  initialize(): void {
    this._disposeRendererBridge?.();
    this._disposeRendererBridge = this.on('location-settings:changed', ({ locationId }) => {
      events.emit(locationSettingsChangedChannel, { locationId });
    });
  }

  async getLocationSettingsPage(
    locationId: string
  ): Promise<Result<LocationSettingsPage, UpdateLocationSettingsError>> {
    const location = this.requireLocation(locationId);
    if (!location.success) return location;
    return ok(await this.getLocationSettingsPageForLocation(location.data));
  }

  async updateLocationSettings(
    locationId: string,
    settings: LocationSettings
  ): Promise<Result<LocationSettings, UpdateLocationSettingsError>> {
    const location = this.requireLocation(locationId);
    if (!location.success) return location;

    const result = await location.data.settings.update(settings);
    if (!result.success) return result;

    const updatedSettings = await location.data.settings.get();
    this.emitSettingsChanged(locationId, updatedSettings);
    return ok(updatedSettings);
  }

  private requireLocation(
    locationId: string
  ): Result<LocationProvider, UpdateLocationSettingsError> {
    const location = locationManager.getLocation(locationId);
    return location ? ok(location) : err({ type: 'location-not-found' });
  }

  private async getLocationSettingsPageForLocation(
    location: LocationProvider
  ): Promise<LocationSettingsPage> {
    return { settings: await location.settings.get() };
  }

  private emitSettingsChanged(locationId: string, settings: LocationSettings): void {
    this._hooks.callHookBackground('location-settings:changed', { locationId, settings });
  }
}

export const locationSettingsService = new LocationSettingsService();

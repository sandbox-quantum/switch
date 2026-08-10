import { err, ok, type Result } from '@switch-console/shared';
import type { IInitializable } from '@switch-console/shared';
import { events } from '@main/lib/events';
import { HookCore, type Hookable } from '@main/lib/hookable';
import { log } from '@main/lib/logger';
import {
  type MigrateLocationConfigRequest,
  type MigrateLocationConfigResult,
  type LocationSettingsPatch,
  type LocationSettings,
  type LocationSettingsPage,
  type WriteLocationConfigRequest,
} from '@shared/core/location-settings/location-settings';
import { hasConfiguredShareableLocationSettings } from '@shared/core/location-settings/location-settings-fields';
import { locationSettingsChangedChannel } from '@shared/core/locations/locationEvents';
import type { UpdateLocationSettingsError } from '@shared/core/locations/locations';
import { locationManager } from '../location-manager';
import type { LocationProvider } from '../location-provider';
import {
  inspectLocationConfigMigrations,
  migrateLocationConfigFromProvider,
} from './sharing/config-migration';
import { computeLocationSettingsOverrideState } from './sharing/location-settings-override-state';
import {
  getLocationSettingsWriteTargets,
  resolveAllLocationSettingsTargets,
} from './sharing/location-settings-target-resolver';
import { shareLocationSettingsToConfig as writeSharedLocationSettingsToConfig } from './sharing/share-location-settings-to-config';

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

  async patchLocationSettings(
    locationId: string,
    patch: LocationSettingsPatch
  ): Promise<Result<LocationSettings, UpdateLocationSettingsError>> {
    const location = this.requireLocation(locationId);
    if (!location.success) return location;

    const result = await location.data.settings.patch(patch);
    if (!result.success) return result;

    const updatedSettings = await location.data.settings.get();
    this.emitSettingsChanged(locationId, updatedSettings);
    return ok(updatedSettings);
  }

  async shareLocationSettingsToConfig(
    locationId: string,
    request: WriteLocationConfigRequest
  ): Promise<Result<LocationSettingsPage, UpdateLocationSettingsError>> {
    const location = this.requireLocation(locationId);
    if (!location.success) return location;

    const resolvedTargets = await resolveAllLocationSettingsTargets(location.data);
    const result = await writeSharedLocationSettingsToConfig(
      location.data,
      request,
      resolvedTargets
    );
    if (!result.success) return result;

    const page = await this.getLocationSettingsPageForLocation(location.data);
    this.emitSettingsChanged(locationId, page.settings);
    return ok(page);
  }

  async migrateLocationConfig(
    locationId: string,
    request: MigrateLocationConfigRequest
  ): Promise<Result<MigrateLocationConfigResult, UpdateLocationSettingsError>> {
    const location = this.requireLocation(locationId);
    if (!location.success) return location;

    const settings = await location.data.settings.get();
    if (hasConfiguredShareableLocationSettings(settings)) {
      return err({
        type: 'write-config-failed',
        message: 'Shareable location settings are already configured.',
      });
    }

    const result = await migrateLocationConfigFromProvider(location.data, request);
    if (!result.success) return result;

    const page = await this.getLocationSettingsPageForLocation(location.data);
    this.emitSettingsChanged(locationId, page.settings);
    return ok({ page, migration: result.data });
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
    const settings = await location.settings.get();
    const defaults = {
      worktreeDirectory: await location.settings.getDefaultWorktreeDirectory(),
    };
    const resolvedTargets = await resolveAllLocationSettingsTargets(location);
    const writeTargets = getLocationSettingsWriteTargets(resolvedTargets);
    const overrideState = await computeLocationSettingsOverrideState(resolvedTargets);
    const configMigrations = hasConfiguredShareableLocationSettings(settings)
      ? []
      : await inspectLocationConfigMigrations(location.fs);
    return {
      settings,
      defaults,
      writeTargets,
      overrideState,
      configMigrations,
      shouldPromptConfigMigration: configMigrations.length > 0,
    };
  }

  private emitSettingsChanged(locationId: string, settings: LocationSettings): void {
    this._hooks.callHookBackground('location-settings:changed', { locationId, settings });
  }
}

export const locationSettingsService = new LocationSettingsService();

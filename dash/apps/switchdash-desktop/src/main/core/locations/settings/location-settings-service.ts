import { err, ok, type Result } from '@switchdash/shared';
import type { IInitializable } from '@switchdash/shared';
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
import { hasConfiguredShareableProjectSettings } from '@shared/core/location-settings/location-settings-fields';
import { locationSettingsChangedChannel } from '@shared/core/locations/locationEvents';
import type { UpdateLocationSettingsError } from '@shared/core/locations/locations';
import { locationManager } from '../location-manager';
import type { LocationProvider } from '../location-provider';
import {
  inspectProjectConfigMigrations,
  migrateProjectConfigFromProvider,
} from './sharing/config-migration';
import { computeLocationSettingsOverrideState } from './sharing/location-settings-override-state';
import {
  getLocationSettingsWriteTargets,
  resolveAllLocationSettingsTargets,
} from './sharing/location-settings-target-resolver';
import { shareLocationSettingsToConfig as writeSharedProjectSettingsToConfig } from './sharing/share-location-settings-to-config';

export type ProjectSettingsHooks = {
  'project-settings:changed': (event: {
    locationId: string;
    settings: LocationSettings;
  }) => void | Promise<void>;
};

export class LocationSettingsService implements Hookable<ProjectSettingsHooks>, IInitializable {
  private readonly _hooks = new HookCore<ProjectSettingsHooks>((name, e) =>
    log.error(`LocationSettingsService: ${String(name)} hook error`, e)
  );
  private _disposeRendererBridge: (() => void) | null = null;

  on<K extends keyof ProjectSettingsHooks>(name: K, handler: ProjectSettingsHooks[K]) {
    return this._hooks.on(name, handler);
  }

  initialize(): void {
    this._disposeRendererBridge?.();
    this._disposeRendererBridge = this.on('project-settings:changed', ({ locationId }) => {
      events.emit(locationSettingsChangedChannel, { locationId });
    });
  }

  async getLocationSettingsPage(
    locationId: string
  ): Promise<Result<LocationSettingsPage, UpdateLocationSettingsError>> {
    const project = this.requireProject(locationId);
    if (!project.success) return project;
    return ok(await this.getProjectSettingsPageForProject(project.data));
  }

  async updateLocationSettings(
    locationId: string,
    settings: LocationSettings
  ): Promise<Result<LocationSettings, UpdateLocationSettingsError>> {
    const project = this.requireProject(locationId);
    if (!project.success) return project;

    const result = await project.data.settings.update(settings);
    if (!result.success) return result;

    const updatedSettings = await project.data.settings.get();
    this.emitSettingsChanged(locationId, updatedSettings);
    return ok(updatedSettings);
  }

  async patchLocationSettings(
    locationId: string,
    patch: LocationSettingsPatch
  ): Promise<Result<LocationSettings, UpdateLocationSettingsError>> {
    const project = this.requireProject(locationId);
    if (!project.success) return project;

    const result = await project.data.settings.patch(patch);
    if (!result.success) return result;

    const updatedSettings = await project.data.settings.get();
    this.emitSettingsChanged(locationId, updatedSettings);
    return ok(updatedSettings);
  }

  async shareLocationSettingsToConfig(
    locationId: string,
    request: WriteLocationConfigRequest
  ): Promise<Result<LocationSettingsPage, UpdateLocationSettingsError>> {
    const project = this.requireProject(locationId);
    if (!project.success) return project;

    const resolvedTargets = await resolveAllLocationSettingsTargets(project.data);
    const result = await writeSharedProjectSettingsToConfig(project.data, request, resolvedTargets);
    if (!result.success) return result;

    const page = await this.getProjectSettingsPageForProject(project.data);
    this.emitSettingsChanged(locationId, page.settings);
    return ok(page);
  }

  async migrateLocationConfig(
    locationId: string,
    request: MigrateLocationConfigRequest
  ): Promise<Result<MigrateLocationConfigResult, UpdateLocationSettingsError>> {
    const project = this.requireProject(locationId);
    if (!project.success) return project;

    const settings = await project.data.settings.get();
    if (hasConfiguredShareableProjectSettings(settings)) {
      return err({
        type: 'write-config-failed',
        message: 'Shareable project settings are already configured.',
      });
    }

    const result = await migrateProjectConfigFromProvider(project.data, request);
    if (!result.success) return result;

    const page = await this.getProjectSettingsPageForProject(project.data);
    this.emitSettingsChanged(locationId, page.settings);
    return ok({ page, migration: result.data });
  }

  private requireProject(locationId: string): Result<LocationProvider, UpdateLocationSettingsError> {
    const project = locationManager.getLocation(locationId);
    return project ? ok(project) : err({ type: 'location-not-found' });
  }

  private async getProjectSettingsPageForProject(
    project: LocationProvider
  ): Promise<LocationSettingsPage> {
    const settings = await project.settings.get();
    const defaults = {
      worktreeDirectory: await project.settings.getDefaultWorktreeDirectory(),
    };
    const resolvedTargets = await resolveAllLocationSettingsTargets(project);
    const writeTargets = getLocationSettingsWriteTargets(resolvedTargets);
    const overrideState = await computeLocationSettingsOverrideState(resolvedTargets);
    const configMigrations = hasConfiguredShareableProjectSettings(settings)
      ? []
      : await inspectProjectConfigMigrations(project.fs);
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
    this._hooks.callHookBackground('project-settings:changed', { locationId, settings });
  }
}

export const locationSettingsService = new LocationSettingsService();

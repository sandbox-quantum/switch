import type { Result } from '@switchdash/shared';
import { events, rpc } from '@renderer/lib/ipc';
import { Resource } from '@renderer/lib/stores/resource';
import { fsWatchEventChannel } from '@shared/core/fs/fsEvents';
import {
  LOCATION_CONFIG_FILE,
  type MigrateLocationConfigRequest,
  type MigrateLocationConfigResult,
  type LocationConfigMigration,
  type LocationSettings,
  type LocationSettingsOverrideState,
  type LocationSettingsPage,
  type LocationSettingsWriteTargetOption,
  type WriteLocationConfigRequest,
} from '@shared/core/location-settings/location-settings';
import { locationSettingsChangedChannel } from '@shared/core/locations/locationEvents';
import type { UpdateLocationSettingsError } from '@shared/core/locations/locations';

export class LocationSettingsStore {
  readonly pageData: Resource<LocationSettingsPage>;
  private readonly _unsubscribeConfigWatch: () => void;
  private readonly _unsubscribeSettingsChanged: () => void;

  constructor(private readonly locationId: string) {
    this.pageData = new Resource(async () => {
      const result = await rpc.locations.getLocationSettingsPage(locationId);
      if (!result.success) {
        throw new Error(
          result.error.type === 'location-not-found'
            ? `Project ${locationId} not found`
            : 'Failed to load project settings'
        );
      }
      return result.data;
    }, [{ kind: 'demand' }]);

    this._unsubscribeConfigWatch = events.on(fsWatchEventChannel, (data) => {
      if (data.locationId !== locationId) return;
      if (
        data.events.some(
          (event) => event.path === LOCATION_CONFIG_FILE || event.oldPath === LOCATION_CONFIG_FILE
        )
      ) {
        this.pageData.invalidate();
      }
    });

    this._unsubscribeSettingsChanged = events.on(locationSettingsChangedChannel, (data) => {
      if (data.locationId === locationId) {
        this.pageData.invalidate();
      }
    });
  }

  get settings(): LocationSettings | null {
    return this.pageData.data?.settings ?? null;
  }

  get defaults(): LocationSettingsPage['defaults'] | null {
    return this.pageData.data?.defaults ?? null;
  }

  get writeTargets(): LocationSettingsWriteTargetOption[] | null {
    return this.pageData.data?.writeTargets ?? null;
  }

  get overrideState(): LocationSettingsOverrideState | null {
    return this.pageData.data?.overrideState ?? null;
  }

  get configMigrations(): LocationConfigMigration[] | null {
    return this.pageData.data?.configMigrations ?? null;
  }

  get shouldPromptConfigMigration(): boolean {
    return this.pageData.data?.shouldPromptConfigMigration ?? false;
  }

  async load(): Promise<LocationSettingsPage | null> {
    await this.pageData.load();
    return this.pageData.data;
  }

  async save(
    settings: LocationSettings
  ): Promise<Result<LocationSettings, UpdateLocationSettingsError>> {
    const result = await rpc.locations.updateLocationSettings(this.locationId, settings);
    if (result.success) {
      const current = this.pageData.data;
      if (current) this.pageData.setValue({ ...current, settings: result.data });
      else this.pageData.invalidate();
    }
    return result;
  }

  async writeConfigToRepo(
    request: WriteLocationConfigRequest
  ): Promise<Result<LocationSettingsPage, UpdateLocationSettingsError>> {
    const result = await rpc.locations.shareLocationSettingsToConfig(this.locationId, request);
    if (result.success) {
      this.pageData.setValue(result.data);
    }
    return result;
  }

  async migrateProjectConfig(
    request: MigrateLocationConfigRequest
  ): Promise<Result<MigrateLocationConfigResult, UpdateLocationSettingsError>> {
    const result = await rpc.locations.migrateLocationConfig(this.locationId, request);
    if (result.success) {
      this.pageData.setValue(result.data.page);
    }
    return result;
  }

  dispose(): void {
    this._unsubscribeConfigWatch();
    this._unsubscribeSettingsChanged();
    this.pageData.dispose();
  }
}

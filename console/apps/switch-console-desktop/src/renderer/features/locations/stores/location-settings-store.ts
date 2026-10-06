import type { Result } from '@switch-console/shared';
import { events, rpc } from '@renderer/lib/ipc';
import { Resource } from '@renderer/lib/stores/resource';
import {
  type LocationSettings,
  type LocationSettingsPage,
} from '@shared/core/location-settings/location-settings';
import { locationSettingsChangedChannel } from '@shared/core/locations/locationEvents';
import type { UpdateLocationSettingsError } from '@shared/core/locations/locations';

export class LocationSettingsStore {
  readonly pageData: Resource<LocationSettingsPage>;
  private readonly _unsubscribeSettingsChanged: () => void;

  constructor(private readonly locationId: string) {
    this.pageData = new Resource(async () => {
      const result = await rpc.locations.getLocationSettingsPage(locationId);
      if (!result.success) {
        throw new Error(
          result.error.type === 'location-not-found'
            ? `Location ${locationId} not found`
            : 'Failed to load location settings'
        );
      }
      return result.data;
    }, [{ kind: 'demand' }]);

    this._unsubscribeSettingsChanged = events.on(locationSettingsChangedChannel, (data) => {
      if (data.locationId === locationId) {
        this.pageData.invalidate();
      }
    });
  }

  get settings(): LocationSettings | null {
    return this.pageData.data?.settings ?? null;
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

  dispose(): void {
    this._unsubscribeSettingsChanged();
    this.pageData.dispose();
  }
}

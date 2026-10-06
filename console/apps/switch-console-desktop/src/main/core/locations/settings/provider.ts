import type { Result } from '@switch-console/shared';
import type { LocationSettings } from '@shared/core/location-settings/location-settings';
import type { UpdateLocationSettingsError } from '@shared/core/locations/locations';

export interface LocationSettingsProvider {
  get(): Promise<LocationSettings>;
  update(settings: LocationSettings): Promise<Result<void, UpdateLocationSettingsError>>;
  ensure(): Promise<void>;
}

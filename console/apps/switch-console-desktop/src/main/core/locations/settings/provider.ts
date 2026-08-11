import type { Result } from '@switch-console/shared';
import type {
  LocationSettings,
  LocationSettingsPatch,
} from '@shared/core/location-settings/location-settings';
import type { UpdateLocationSettingsError } from '@shared/core/locations/locations';
export type { LocationSettingsPatch };

export interface LocationSettingsProvider {
  getDefaultWorktreeDirectory(): Promise<string>;
  getWorktreeDirectory(): Promise<string>;
  get(): Promise<LocationSettings>;
  update(settings: LocationSettings): Promise<Result<void, UpdateLocationSettingsError>>;
  patch(patch: LocationSettingsPatch): Promise<Result<void, UpdateLocationSettingsError>>;
  ensure(): Promise<void>;
}

import { createRPCController } from '@shared/lib/ipc/rpc';
import { inspectLocationPath } from './operations/inspect-location-path';
import { openLocation } from './operations/open-location';
import { countLocationsUsingGithubAccount } from './settings/count-locations-using-github-account';
import { locationSettingsService } from './settings/location-settings-service';
import { getLocations } from './store';

export const locationsController = createRPCController({
  getLocations,
  inspectLocationPath,
  openLocation,
  getLocationSettingsPage: (locationId: string) =>
    locationSettingsService.getLocationSettingsPage(locationId),
  updateLocationSettings: (locationId, settings) =>
    locationSettingsService.updateLocationSettings(locationId, settings),
  patchLocationSettings: (locationId, patch) =>
    locationSettingsService.patchLocationSettings(locationId, patch),
  shareLocationSettingsToConfig: (locationId, request) =>
    locationSettingsService.shareLocationSettingsToConfig(locationId, request),
  migrateLocationConfig: (locationId, request) =>
    locationSettingsService.migrateLocationConfig(locationId, request),
  countLocationsUsingGithubAccount,
});

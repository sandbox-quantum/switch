import { locationRuntimeRegistry } from '@main/core/locations/location-runtime-registry';
import { getEffectiveSessionSettings } from '@main/core/locations/settings/effective-session-settings';
import type { LocationSettings } from '@shared/core/location-settings/location-settings';
import { createRPCController } from '@shared/lib/ipc/rpc';

async function getSettings(locationId: string): Promise<LocationSettings> {
  const runtime = locationRuntimeRegistry.get(locationId);
  if (!runtime) {
    throw new Error(`No live runtime for location ${locationId}`);
  }

  return getEffectiveSessionSettings({
    locationSettings: runtime.settings,
    sessionFs: runtime.fs,
  });
}

export const locationRuntimeSettingsController = createRPCController({
  getSettings,
});

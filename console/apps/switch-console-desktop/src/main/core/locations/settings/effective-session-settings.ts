import type { FileSystemProvider } from '@main/core/fs/types';
import { log } from '@main/lib/logger';
import {
  shareableLocationSettingsSchema,
  type LocationSettings,
} from '@shared/core/location-settings/location-settings';
import { mergeShareableLocationSettings } from '@shared/core/location-settings/location-settings-fields';
import type { LocationSettingsProvider } from './provider';

export async function getEffectiveSessionSettings(args: {
  locationSettings: LocationSettingsProvider;
  sessionFs: FileSystemProvider;
}): Promise<LocationSettings> {
  const { locationSettings, sessionFs } = args;
  const parsedSettings = shareableLocationSettingsSchema.safeParse(await locationSettings.get());
  const localShareableSettings = parsedSettings.success ? parsedSettings.data : {};
  const exists = await sessionFs.exists('.switchdash.json');
  if (!exists) {
    return mergeShareableLocationSettings(localShareableSettings);
  }

  try {
    const { content } = await sessionFs.read('.switchdash.json');
    const locationFileSettings = shareableLocationSettingsSchema.parse(JSON.parse(content));
    return mergeShareableLocationSettings(locationFileSettings, localShareableSettings);
  } catch (err) {
    log.warn('Failed to parse session .switchdash.json, falling back to location settings', err);
    return mergeShareableLocationSettings(localShareableSettings);
  }
}

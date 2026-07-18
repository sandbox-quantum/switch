import type { FileSystemProvider } from '@main/core/fs/types';
import { log } from '@main/lib/logger';
import {
  defaultShareableProjectSettings,
  shareableLocationSettingsSchema,
  type LocationSettings,
} from '@shared/core/location-settings/location-settings';
import { mergeShareableProjectSettings } from '@shared/core/location-settings/location-settings-fields';
import type { LocationSettingsProvider } from './provider';

export async function getEffectiveSessionSettings(args: {
  locationSettings: LocationSettingsProvider;
  sessionFs: FileSystemProvider;
}): Promise<LocationSettings> {
  const { locationSettings, sessionFs } = args;
  const parsedSettings = shareableLocationSettingsSchema.safeParse(await locationSettings.get());
  const localShareableSettings = parsedSettings.success ? parsedSettings.data : {};
  const defaults = defaultShareableProjectSettings();
  const exists = await sessionFs.exists('.switchdash.json');
  if (!exists) {
    return mergeShareableProjectSettings(defaults, localShareableSettings);
  }

  try {
    const { content } = await sessionFs.read('.switchdash.json');
    const projectFileSettings = shareableLocationSettingsSchema.parse(JSON.parse(content));
    return mergeShareableProjectSettings(defaults, projectFileSettings, localShareableSettings);
  } catch (err) {
    log.warn('Failed to parse session .switchdash.json, falling back to project settings', err);
    return mergeShareableProjectSettings(defaults, localShareableSettings);
  }
}

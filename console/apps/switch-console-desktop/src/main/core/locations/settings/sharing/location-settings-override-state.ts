import { log } from '@main/lib/logger';
import {
  emptyLocationSettingsOverrideState,
  SHAREABLE_LOCATION_SETTINGS_WRITE_FIELDS,
  shareableLocationSettingsSchema,
  type LocationSettingsOverrideState,
} from '@shared/core/location-settings/location-settings';
import { SHAREABLE_FIELD_ACCESSORS } from '@shared/core/location-settings/location-settings-fields';
import type { LocationSettingsResolvedTarget } from './location-settings-target-resolver';
import { CONFIG_FILE } from './switch-console-config-file';

export async function computeLocationSettingsOverrideState(
  targets: LocationSettingsResolvedTarget[]
): Promise<LocationSettingsOverrideState> {
  const state = emptyLocationSettingsOverrideState();

  for (const resolved of targets) {
    try {
      if (!(await resolved.fs.exists(CONFIG_FILE))) continue;

      const { content } = await resolved.fs.read(CONFIG_FILE);
      const parsed = shareableLocationSettingsSchema.safeParse(JSON.parse(content));
      if (!parsed.success) continue;

      for (const field of SHAREABLE_LOCATION_SETTINGS_WRITE_FIELDS) {
        const value = SHAREABLE_FIELD_ACCESSORS[field].displayValue(parsed.data);
        if (!value) continue;

        state[field].push({
          label: resolved.label,
          path: resolved.path,
          value,
        });
      }
    } catch (error) {
      log.warn('Failed to inspect location settings override source', error);
    }
  }

  return state;
}

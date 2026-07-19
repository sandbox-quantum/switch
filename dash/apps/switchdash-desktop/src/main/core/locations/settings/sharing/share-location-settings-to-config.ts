import { err, ok, type Result } from '@switchdash/shared';
import { log } from '@main/lib/logger';
import type { WriteLocationConfigRequest } from '@shared/core/location-settings/location-settings';
import type { UpdateLocationSettingsError } from '@shared/core/locations/locations';
import type { LocationProvider } from '../../location-provider';
import {
  resolveLocationSettingsTarget,
  type LocationSettingsResolvedTarget,
} from './location-settings-target-resolver';
import {
  CONFIG_FILE,
  parseSwitchdashConfigObject,
  patchShareableLocationSettingsFields,
} from './switchdash-config-file';

function writeConfigFailed(message: string): Result<void, UpdateLocationSettingsError> {
  return err({ type: 'write-config-failed', message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function shareLocationSettingsToConfig(
  location: LocationProvider,
  request: WriteLocationConfigRequest,
  resolvedTargets: LocationSettingsResolvedTarget[]
): Promise<Result<void, UpdateLocationSettingsError>> {
  try {
    const target = await resolveLocationSettingsTarget(location, request, resolvedTargets);
    if (!target) {
      return writeConfigFailed('Could not resolve the selected working copy.');
    }

    const localSettings = await location.settings.get();
    let config: Record<string, unknown>;
    try {
      if (await target.fs.exists(CONFIG_FILE)) {
        const { content } = await target.fs.read(CONFIG_FILE);
        config = parseSwitchdashConfigObject(content);
      } else {
        config = {};
      }
    } catch (error) {
      const message = `Could not read existing ${CONFIG_FILE}: ${errorMessage(error)}`;
      log.warn('Failed to read location config before writing', error);
      return writeConfigFailed(message);
    }

    const writtenFields = patchShareableLocationSettingsFields(
      config,
      localSettings,
      request.fields
    );

    const writeResult = await target.fs.write(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
    if (!writeResult.success) {
      log.warn('Failed to write location config file', writeResult.error);
      return writeConfigFailed(writeResult.error ?? `Failed to write ${CONFIG_FILE}.`);
    }

    const clearResult = await location.settings.patch({ clearShareableFields: writtenFields });
    if (!clearResult.success) {
      log.warn('Failed to clear shareable location settings', clearResult.error);
      return writeConfigFailed(
        `Wrote ${CONFIG_FILE}, but failed to clear shared location settings.`
      );
    }

    return ok();
  } catch (error) {
    log.warn('Failed to write location config to repo', error);
    return writeConfigFailed(errorMessage(error));
  }
}

import { err, ok, type Result } from '@switchdash/shared';
import z from 'zod';
import type { FileSystemProvider } from '@main/core/fs/types';
import { log } from '@main/lib/logger';
import {
  type MigrateLocationConfigRequest,
  type LocationConfigMigration,
  type ShareableLocationSettings,
  type ShareableLocationSettingsWriteField,
} from '@shared/core/location-settings/location-settings';
import { mergeShareableLocationSettings } from '@shared/core/location-settings/location-settings-fields';
import type { UpdateLocationSettingsError } from '@shared/core/locations/locations';
import type { LocationProvider } from '../../location-provider';
import { parseJsonObject } from '../location-settings-json';
import type { LocationConfigMigrator } from './config-migration';
import { CONFIG_FILE } from './switchdash-config-file';

const CONDUCTOR_CONFIG_FILE = 'conductor.json';
const CONDUCTOR_WORKTREE_INCLUDE_FILE = '.worktreeinclude';

const conductorConfigSchema = z
  .object({
    scripts: z
      .object({
        setup: z.string().optional(),
        run: z.string().optional(),
        archive: z.string().optional(),
      })
      .optional(),
    runScriptMode: z.enum(['concurrent', 'nonconcurrent']).optional(),
    enterpriseDataPrivacy: z.boolean().optional(),
  })
  .passthrough();

type ConductorMigrationData = {
  settings: ShareableLocationSettings;
  files: string[];
  fields: ShareableLocationSettingsWriteField[];
  unsupportedFields: string[];
};

function writeConfigFailed(message: string): Result<never, UpdateLocationSettingsError> {
  return err({ type: 'write-config-failed', message });
}

function trimmedText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseWorktreeInclude(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function toConductorMigration(data: ConductorMigrationData): LocationConfigMigration | null {
  if (data.fields.length === 0) return null;
  return {
    provider: 'conductor',
    label: 'Conductor',
    files: data.files,
    fields: data.fields,
    unsupportedFields: data.unsupportedFields,
  };
}

async function readConductorMigrationData(
  fs: Pick<FileSystemProvider, 'exists' | 'read'>
): Promise<ConductorMigrationData> {
  const data: ConductorMigrationData = {
    settings: {},
    files: [],
    fields: [],
    unsupportedFields: [],
  };

  const hasConductorConfig = await fs.exists(CONDUCTOR_CONFIG_FILE);
  if (hasConductorConfig) {
    const { content } = await fs.read(CONDUCTOR_CONFIG_FILE);
    const conductorConfig = conductorConfigSchema.parse(parseJsonObject(content));
    data.files.push(CONDUCTOR_CONFIG_FILE);

    const setup = trimmedText(conductorConfig.scripts?.setup);
    const run = trimmedText(conductorConfig.scripts?.run);
    const archive = trimmedText(conductorConfig.scripts?.archive);

    if (setup) {
      data.settings.scripts ??= {};
      data.settings.scripts.setup = setup;
      data.fields.push('scripts.setup');
    }
    if (run) {
      data.settings.scripts ??= {};
      data.settings.scripts.run = run;
      data.fields.push('scripts.run');
    }
    if (archive) {
      data.settings.scripts ??= {};
      data.settings.scripts.teardown = archive;
      data.fields.push('scripts.teardown');
    }

    if (conductorConfig.runScriptMode !== undefined) data.unsupportedFields.push('runScriptMode');
    if (conductorConfig.enterpriseDataPrivacy !== undefined) {
      data.unsupportedFields.push('enterpriseDataPrivacy');
    }
  }

  if (await fs.exists(CONDUCTOR_WORKTREE_INCLUDE_FILE)) {
    const { content } = await fs.read(CONDUCTOR_WORKTREE_INCLUDE_FILE);
    const patterns = parseWorktreeInclude(content);
    if (patterns.length > 0) {
      data.files.push(CONDUCTOR_WORKTREE_INCLUDE_FILE);
      data.settings.preservePatterns = patterns;
      data.fields.push('preservePatterns');
    }
  }

  return data;
}

async function migrateConductorConfig(
  location: LocationProvider,
  request: MigrateLocationConfigRequest
): Promise<Result<LocationConfigMigration, UpdateLocationSettingsError>> {
  try {
    const data = await readConductorMigrationData(location.fs);
    const migration = toConductorMigration(data);
    if (!migration) {
      return writeConfigFailed('No supported Conductor settings were found.');
    }

    if (request.destination === 'local') {
      const currentSettings = await location.settings.get();
      const shareableSettings = mergeShareableLocationSettings(currentSettings, data.settings);
      const updateResult = await location.settings.update({
        ...currentSettings,
        ...shareableSettings,
      });
      if (!updateResult.success) return updateResult;
      return ok(migration);
    }

    const writeResult = await location.fs.write(
      CONFIG_FILE,
      `${JSON.stringify(data.settings, null, 2)}\n`
    );
    if (!writeResult.success) {
      log.warn('Failed to write migrated location config file', writeResult.error);
      return writeConfigFailed(writeResult.error ?? `Failed to write ${CONFIG_FILE}.`);
    }

    const clearResult = await location.settings.patch({ clearShareableFields: data.fields });
    if (!clearResult.success) {
      log.warn('Failed to clear imported local location settings', clearResult.error);
      return writeConfigFailed(
        `Wrote ${CONFIG_FILE}, but failed to clear local location settings.`
      );
    }

    return ok(migration);
  } catch (error) {
    log.warn('Failed to migrate Conductor config to location config', error);
    return writeConfigFailed(error instanceof Error ? error.message : String(error));
  }
}

export const conductorConfigMigrator: LocationConfigMigrator = {
  provider: 'conductor',
  inspect: async (fs) => toConductorMigration(await readConductorMigrationData(fs)),
  migrate: migrateConductorConfig,
};

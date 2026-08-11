import { err, ok, type Result } from '@switch-console/shared';
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
import { CONFIG_FILE } from './switch-console-config-file';

const PASEO_CONFIG_FILE = 'paseo.json';

const paseoCommandSchema = z.union([z.string(), z.array(z.string())]);

const paseoScriptSchema = z
  .object({
    command: z.string().optional(),
    type: z.string().optional(),
    port: z.number().optional(),
  })
  .passthrough();

const paseoConfigSchema = z
  .object({
    worktree: z
      .object({
        setup: paseoCommandSchema.optional(),
        teardown: paseoCommandSchema.optional(),
        terminals: z.array(z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
    scripts: z.record(z.string(), paseoScriptSchema).optional(),
  })
  .passthrough();

type PaseoMigrationData = {
  settings: ShareableLocationSettings;
  files: string[];
  fields: ShareableLocationSettingsWriteField[];
  unsupportedFields: string[];
};

function writeConfigFailed(message: string): Result<never, UpdateLocationSettingsError> {
  return err({ type: 'write-config-failed', message });
}

function normalizeCommand(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;

  const commands = Array.isArray(value) ? value : [value];
  const normalized = commands.map((command) => command.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized.join('\n') : undefined;
}

function setScript(
  settings: ShareableLocationSettings,
  field: ShareableLocationSettingsWriteField,
  value: string
): void {
  settings.scripts ??= {};
  if (field === 'scripts.setup') settings.scripts.setup = value;
  if (field === 'scripts.teardown') settings.scripts.teardown = value;
}

function addScript(
  data: PaseoMigrationData,
  field: ShareableLocationSettingsWriteField,
  value: string | undefined
): void {
  if (!value) return;
  setScript(data.settings, field, value);
  data.fields.push(field);
}

function toPaseoMigration(data: PaseoMigrationData): LocationConfigMigration | null {
  if (data.fields.length === 0) return null;
  return {
    provider: 'paseo',
    label: 'Paseo',
    files: data.files,
    fields: data.fields,
    unsupportedFields: data.unsupportedFields,
  };
}

function addUnsupportedScripts(
  data: PaseoMigrationData,
  scripts: z.infer<typeof paseoConfigSchema>['scripts']
): void {
  if (!scripts) return;

  for (const [name, script] of Object.entries(scripts)) {
    if (script.command !== undefined) data.unsupportedFields.push(`scripts.${name}.command`);
    if (script.type !== undefined) data.unsupportedFields.push(`scripts.${name}.type`);
    if (script.port !== undefined) data.unsupportedFields.push(`scripts.${name}.port`);
  }
}

async function readPaseoMigrationData(
  fs: Pick<FileSystemProvider, 'exists' | 'read'>
): Promise<PaseoMigrationData> {
  const data: PaseoMigrationData = {
    settings: {},
    files: [],
    fields: [],
    unsupportedFields: [],
  };

  if (!(await fs.exists(PASEO_CONFIG_FILE))) return data;

  const { content } = await fs.read(PASEO_CONFIG_FILE);
  const paseoConfig = paseoConfigSchema.parse(parseJsonObject(content));
  data.files.push(PASEO_CONFIG_FILE);

  addScript(data, 'scripts.setup', normalizeCommand(paseoConfig.worktree?.setup));
  addScript(data, 'scripts.teardown', normalizeCommand(paseoConfig.worktree?.teardown));
  addUnsupportedScripts(data, paseoConfig.scripts);

  if (paseoConfig.worktree?.terminals !== undefined) {
    data.unsupportedFields.push('worktree.terminals');
  }

  return data;
}

async function migratePaseoConfig(
  location: LocationProvider,
  request: MigrateLocationConfigRequest
): Promise<Result<LocationConfigMigration, UpdateLocationSettingsError>> {
  try {
    const data = await readPaseoMigrationData(location.fs);
    const migration = toPaseoMigration(data);
    if (!migration) {
      return writeConfigFailed('No supported Paseo settings were found.');
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
    log.warn('Failed to migrate Paseo config to location config', error);
    return writeConfigFailed(error instanceof Error ? error.message : String(error));
  }
}

export const paseoConfigMigrator: LocationConfigMigrator = {
  provider: 'paseo',
  inspect: async (fs) => toPaseoMigration(await readPaseoMigrationData(fs)),
  migrate: migratePaseoConfig,
};

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

const SUPERSET_CONFIG_FILE = '.superset/config.json';

const supersetScriptOverrideSchema = z
  .object({
    before: z.array(z.string()).optional(),
    after: z.array(z.string()).optional(),
  })
  .passthrough();

const supersetScriptSchema = z.union([z.array(z.string()), supersetScriptOverrideSchema]);

const supersetConfigSchema = z
  .object({
    setup: supersetScriptSchema.optional(),
    teardown: supersetScriptSchema.optional(),
    run: supersetScriptSchema.optional(),
  })
  .passthrough();

type SupersetScriptConfig = z.infer<typeof supersetScriptSchema>;

type SupersetMigrationData = {
  settings: ShareableLocationSettings;
  files: string[];
  fields: ShareableLocationSettingsWriteField[];
  unsupportedFields: string[];
};

const SUPERSET_SCRIPT_FIELDS = [
  { source: 'setup', target: 'scripts.setup' },
  { source: 'run', target: 'scripts.run' },
  { source: 'teardown', target: 'scripts.teardown' },
] as const satisfies Array<{
  source: 'setup' | 'run' | 'teardown';
  target: ShareableLocationSettingsWriteField;
}>;

function writeConfigFailed(message: string): Result<never, UpdateLocationSettingsError> {
  return err({ type: 'write-config-failed', message });
}

function normalizeCommands(commands: string[]): string | undefined {
  const normalized = commands.map((command) => command.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized.join('\n') : undefined;
}

function addUnsupportedOverrideFields(
  data: SupersetMigrationData,
  source: 'setup' | 'run' | 'teardown',
  script: SupersetScriptConfig
): void {
  if (Array.isArray(script)) return;
  if (script.before !== undefined) data.unsupportedFields.push(`${source}.before`);
  if (script.after !== undefined) data.unsupportedFields.push(`${source}.after`);
}

function setScript(
  settings: ShareableLocationSettings,
  field: ShareableLocationSettingsWriteField,
  value: string
): void {
  settings.scripts ??= {};
  if (field === 'scripts.setup') settings.scripts.setup = value;
  if (field === 'scripts.run') settings.scripts.run = value;
  if (field === 'scripts.teardown') settings.scripts.teardown = value;
}

function toSupersetMigration(data: SupersetMigrationData): LocationConfigMigration | null {
  if (data.fields.length === 0) return null;
  return {
    provider: 'superset',
    label: 'Superset',
    files: data.files,
    fields: data.fields,
    unsupportedFields: data.unsupportedFields,
  };
}

async function readSupersetMigrationData(
  fs: Pick<FileSystemProvider, 'exists' | 'read'>
): Promise<SupersetMigrationData> {
  const data: SupersetMigrationData = {
    settings: {},
    files: [],
    fields: [],
    unsupportedFields: [],
  };

  if (!(await fs.exists(SUPERSET_CONFIG_FILE))) return data;

  const { content } = await fs.read(SUPERSET_CONFIG_FILE);
  const config = supersetConfigSchema.parse(parseJsonObject(content));
  data.files.push(SUPERSET_CONFIG_FILE);

  for (const { source, target } of SUPERSET_SCRIPT_FIELDS) {
    const script = config[source];
    if (script === undefined) continue;

    if (Array.isArray(script)) {
      const value = normalizeCommands(script);
      if (!value) continue;
      setScript(data.settings, target, value);
      data.fields.push(target);
      continue;
    }

    addUnsupportedOverrideFields(data, source, script);
  }

  return data;
}

async function migrateSupersetConfig(
  location: LocationProvider,
  request: MigrateLocationConfigRequest
): Promise<Result<LocationConfigMigration, UpdateLocationSettingsError>> {
  try {
    const data = await readSupersetMigrationData(location.fs);
    const migration = toSupersetMigration(data);
    if (!migration) {
      return writeConfigFailed('No supported Superset settings were found.');
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
    log.warn('Failed to migrate Superset config to location config', error);
    return writeConfigFailed(error instanceof Error ? error.message : String(error));
  }
}

export const supersetConfigMigrator: LocationConfigMigrator = {
  provider: 'superset',
  inspect: async (fs) => toSupersetMigration(await readSupersetMigrationData(fs)),
  migrate: migrateSupersetConfig,
};

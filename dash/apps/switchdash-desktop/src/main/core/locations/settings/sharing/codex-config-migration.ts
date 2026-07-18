import { err, ok, type Result } from '@switchdash/shared';
import * as toml from 'smol-toml';
import z from 'zod';
import type { FileSystemProvider } from '@main/core/fs/types';
import { log } from '@main/lib/logger';
import {
  type MigrateLocationConfigRequest,
  type LocationConfigMigration,
  type ShareableLocationSettings,
  type ShareableLocationSettingsWriteField,
} from '@shared/core/location-settings/location-settings';
import { mergeShareableProjectSettings } from '@shared/core/location-settings/location-settings-fields';
import type { UpdateLocationSettingsError } from '@shared/core/locations/locations';
import type { LocationProvider } from '../../location-provider';
import type { ProjectConfigMigrator } from './config-migration';
import { CONFIG_FILE } from './switchdash-config-file';

const CODEX_ENVIRONMENT_FILE = '.codex/environments/environment.toml';

const codexScriptSectionSchema = z
  .object({
    script: z.string().optional(),
  })
  .passthrough();

const codexActionSchema = z
  .object({
    name: z.string().optional(),
    icon: z.string().optional(),
    command: z.string().optional(),
  })
  .passthrough();

const codexEnvironmentSchema = z
  .object({
    setup: codexScriptSectionSchema.optional(),
    cleanup: codexScriptSectionSchema.optional(),
    actions: z.array(codexActionSchema).optional(),
  })
  .passthrough();

type CodexMigrationData = {
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
  data: CodexMigrationData,
  field: ShareableLocationSettingsWriteField,
  value: string | undefined
): void {
  if (!value) return;
  setScript(data.settings, field, value);
  data.fields.push(field);
}

function actionLabel(action: z.infer<typeof codexActionSchema>, index: number): string {
  const name = action.name?.trim();
  return name ? name : String(index);
}

function addUnsupportedActions(
  data: CodexMigrationData,
  actions: z.infer<typeof codexEnvironmentSchema>['actions']
): void {
  if (!actions) return;

  actions.forEach((action, index) => {
    const label = actionLabel(action, index);
    if (action.command !== undefined) data.unsupportedFields.push(`actions.${label}.command`);
    if (action.icon !== undefined) data.unsupportedFields.push(`actions.${label}.icon`);
  });
}

function toCodexMigration(data: CodexMigrationData): LocationConfigMigration | null {
  if (data.fields.length === 0) return null;
  return {
    provider: 'codex',
    label: 'Codex',
    files: data.files,
    fields: data.fields,
    unsupportedFields: data.unsupportedFields,
  };
}

async function readCodexMigrationData(
  fs: Pick<FileSystemProvider, 'exists' | 'read'>
): Promise<CodexMigrationData> {
  const data: CodexMigrationData = {
    settings: {},
    files: [],
    fields: [],
    unsupportedFields: [],
  };

  if (!(await fs.exists(CODEX_ENVIRONMENT_FILE))) return data;

  const { content } = await fs.read(CODEX_ENVIRONMENT_FILE);
  const codexEnvironment = codexEnvironmentSchema.parse(toml.parse(content));
  data.files.push(CODEX_ENVIRONMENT_FILE);

  addScript(data, 'scripts.setup', trimmedText(codexEnvironment.setup?.script));
  addScript(data, 'scripts.teardown', trimmedText(codexEnvironment.cleanup?.script));
  addUnsupportedActions(data, codexEnvironment.actions);

  return data;
}

async function migrateCodexConfig(
  project: LocationProvider,
  request: MigrateLocationConfigRequest
): Promise<Result<LocationConfigMigration, UpdateLocationSettingsError>> {
  try {
    const data = await readCodexMigrationData(project.fs);
    const migration = toCodexMigration(data);
    if (!migration) {
      return writeConfigFailed('No supported Codex settings were found.');
    }

    if (request.destination === 'local') {
      const currentSettings = await project.settings.get();
      const shareableSettings = mergeShareableProjectSettings(currentSettings, data.settings);
      const updateResult = await project.settings.update({
        ...currentSettings,
        ...shareableSettings,
      });
      if (!updateResult.success) return updateResult;
      return ok(migration);
    }

    const writeResult = await project.fs.write(
      CONFIG_FILE,
      `${JSON.stringify(data.settings, null, 2)}\n`
    );
    if (!writeResult.success) {
      log.warn('Failed to write migrated project config file', writeResult.error);
      return writeConfigFailed(writeResult.error ?? `Failed to write ${CONFIG_FILE}.`);
    }

    const clearResult = await project.settings.patch({ clearShareableFields: data.fields });
    if (!clearResult.success) {
      log.warn('Failed to clear imported local project settings', clearResult.error);
      return writeConfigFailed(`Wrote ${CONFIG_FILE}, but failed to clear local project settings.`);
    }

    return ok(migration);
  } catch (error) {
    log.warn('Failed to migrate Codex config to project config', error);
    return writeConfigFailed(error instanceof Error ? error.message : String(error));
  }
}

export const codexConfigMigrator: ProjectConfigMigrator = {
  provider: 'codex',
  inspect: async (fs) => toCodexMigration(await readCodexMigrationData(fs)),
  migrate: migrateCodexConfig,
};

import type { Result } from '@switchdash/shared';
import type { FileSystemProvider } from '@main/core/fs/types';
import { log } from '@main/lib/logger';
import {
  baseProjectSettingsSchema,
  legacyBaseProjectSettingsSchema,
  legacyProjectConfigSchema,
  shareableLocationSettingsSchema,
  type BaseLocationSettings,
  type ShareableLocationSettings,
} from '@shared/core/location-settings/location-settings';
import { mergeShareableProjectSettings } from '@shared/core/location-settings/location-settings-fields';
import type { UpdateLocationSettingsError } from '@shared/core/locations/locations';
import {
  hasLegacyShareableConfigMigrated,
  serializeShareableProjectSettings,
} from './legacy-shareable-migration-marker';
import { compactUndefined, parseJsonObject, readJson } from './location-settings-json';
import type { ProjectSettingsStorage, StoredLocationSettings } from './location-settings-storage';

export type LegacyProjectSettingsMigrationArgs = {
  locationId: string;
  row: StoredLocationSettings | undefined;
  configReader: Pick<FileSystemProvider, 'exists' | 'read'> | undefined;
  storage: ProjectSettingsStorage;
  git?: ProjectSettingsGitInspector;
  normalizeStoredWorktreeDirectory: (
    worktreeDirectory: string
  ) => Promise<Result<string, UpdateLocationSettingsError>>;
};

export type ProjectSettingsGitInspector = {
  isFileCleanlyTracked(filePath: string): Promise<boolean>;
};

async function readLegacyProjectConfig(
  configReader: Pick<FileSystemProvider, 'exists' | 'read'> | undefined
): Promise<BaseLocationSettings | undefined> {
  if (!configReader) return undefined;
  try {
    if (!(await configReader.exists('.switchdash.json'))) return undefined;
    const { content } = await configReader.read('.switchdash.json');
    const parsed = legacyProjectConfigSchema.safeParse(parseJsonObject(content));
    if (!parsed.success) {
      log.warn('Failed to parse legacy .switchdash.json for migration', parsed.error);
      return undefined;
    }
    return parsed.data;
  } catch (error) {
    log.warn('Failed to read legacy .switchdash.json for migration', error);
    return undefined;
  }
}

export async function migrateLegacyProjectSettingsIfNeeded({
  locationId,
  row,
  configReader,
  storage,
  git,
  normalizeStoredWorktreeDirectory,
}: LegacyProjectSettingsMigrationArgs): Promise<void> {
  if (!row) return;

  const baseAlreadyMigrated = Boolean(row.legacyConfigMigratedAt);
  const shareableAlreadyMigrated = hasLegacyShareableConfigMigrated(
    row.shareableSettingsJson
  );
  if (baseAlreadyMigrated && shareableAlreadyMigrated) return;

  const current = readJson(
    row.baseSettingsJson,
    legacyBaseProjectSettingsSchema,
    'base project settings'
  );
  const currentShareable = readJson(
    row.shareableSettingsJson,
    shareableLocationSettingsSchema,
    'shareable project settings'
  );
  const legacy = await readLegacyProjectConfig(configReader);
  const next: BaseLocationSettings = baseProjectSettingsSchema.parse(current);
  let nextShareable: ShareableLocationSettings | undefined;

  if (legacy && !baseAlreadyMigrated) {
    if (legacy.worktreeDirectory !== undefined) {
      const normalized = await normalizeStoredWorktreeDirectory(legacy.worktreeDirectory);
      if (normalized.success) next.worktreeDirectory = normalized.data;
    }
    if (legacy.tmux !== undefined) next.tmux = legacy.tmux;
    if (legacy.workspaceProvider !== undefined) {
      next.workspaceProvider = legacy.workspaceProvider;
    }
  }

  if (legacy && !shareableAlreadyMigrated) {
    if ((await git?.isFileCleanlyTracked('.switchdash.json')) === false) {
      const legacyShareable = shareableLocationSettingsSchema.parse(legacy);
      nextShareable = mergeShareableProjectSettings(currentShareable, legacyShareable);
    }
  }

  const update: Partial<StoredLocationSettings> = {
    ...(nextShareable
      ? {
          shareableSettingsJson: serializeShareableProjectSettings(nextShareable, {
            previousRaw: row.shareableSettingsJson,
            markLegacyShareableConfigMigrated: true,
          }),
        }
      : {}),
  };

  if (!baseAlreadyMigrated) {
    update.baseSettingsJson = JSON.stringify(compactUndefined(next));
    update.legacyConfigMigratedAt = new Date().toISOString();
  }

  if (Object.keys(update).length > 0) {
    await storage.update(locationId, update);
  }
}

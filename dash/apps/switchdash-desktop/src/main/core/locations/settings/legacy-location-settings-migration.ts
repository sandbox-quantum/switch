import type { Result } from '@switchdash/shared';
import type { FileSystemProvider } from '@main/core/fs/types';
import { log } from '@main/lib/logger';
import {
  baseLocationSettingsSchema,
  legacyBaseLocationSettingsSchema,
  legacyLocationConfigSchema,
  shareableLocationSettingsSchema,
  type BaseLocationSettings,
  type ShareableLocationSettings,
} from '@shared/core/location-settings/location-settings';
import { mergeShareableLocationSettings } from '@shared/core/location-settings/location-settings-fields';
import type { UpdateLocationSettingsError } from '@shared/core/locations/locations';
import {
  hasLegacyShareableConfigMigrated,
  serializeShareableLocationSettings,
} from './legacy-shareable-migration-marker';
import { compactUndefined, parseJsonObject, readJson } from './location-settings-json';
import type { LocationSettingsStorage, StoredLocationSettings } from './location-settings-storage';

export type LegacyLocationSettingsMigrationArgs = {
  locationId: string;
  row: StoredLocationSettings | undefined;
  configReader: Pick<FileSystemProvider, 'exists' | 'read'> | undefined;
  storage: LocationSettingsStorage;
  git?: LocationSettingsGitInspector;
  normalizeStoredWorktreeDirectory: (
    worktreeDirectory: string
  ) => Promise<Result<string, UpdateLocationSettingsError>>;
};

export type LocationSettingsGitInspector = {
  isFileCleanlyTracked(filePath: string): Promise<boolean>;
};

async function readLegacyLocationConfig(
  configReader: Pick<FileSystemProvider, 'exists' | 'read'> | undefined
): Promise<BaseLocationSettings | undefined> {
  if (!configReader) return undefined;
  try {
    if (!(await configReader.exists('.switchdash.json'))) return undefined;
    const { content } = await configReader.read('.switchdash.json');
    const parsed = legacyLocationConfigSchema.safeParse(parseJsonObject(content));
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

export async function migrateLegacyLocationSettingsIfNeeded({
  locationId,
  row,
  configReader,
  storage,
  git,
  normalizeStoredWorktreeDirectory,
}: LegacyLocationSettingsMigrationArgs): Promise<void> {
  if (!row) return;

  const baseAlreadyMigrated = Boolean(row.legacyConfigMigratedAt);
  const shareableAlreadyMigrated = hasLegacyShareableConfigMigrated(row.shareableSettingsJson);
  if (baseAlreadyMigrated && shareableAlreadyMigrated) return;

  const current = readJson(
    row.baseSettingsJson,
    legacyBaseLocationSettingsSchema,
    'base location settings'
  );
  const currentShareable = readJson(
    row.shareableSettingsJson,
    shareableLocationSettingsSchema,
    'shareable location settings'
  );
  const legacy = await readLegacyLocationConfig(configReader);
  const next: BaseLocationSettings = baseLocationSettingsSchema.parse(current);
  let nextShareable: ShareableLocationSettings | undefined;

  if (legacy && !baseAlreadyMigrated) {
    if (legacy.worktreeDirectory !== undefined) {
      const normalized = await normalizeStoredWorktreeDirectory(legacy.worktreeDirectory);
      if (normalized.success) next.worktreeDirectory = normalized.data;
    }
    if (legacy.tmux !== undefined) next.tmux = legacy.tmux;
    if (legacy.locationProvider !== undefined) {
      next.locationProvider = legacy.locationProvider;
    }
  }

  if (legacy && !shareableAlreadyMigrated) {
    if ((await git?.isFileCleanlyTracked('.switchdash.json')) === false) {
      const legacyShareable = shareableLocationSettingsSchema.parse(legacy);
      nextShareable = mergeShareableLocationSettings(currentShareable, legacyShareable);
    }
  }

  const update: Partial<StoredLocationSettings> = {
    ...(nextShareable
      ? {
          shareableSettingsJson: serializeShareableLocationSettings(nextShareable, {
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

import { err, ok, type Result } from '@switchdash/shared';
import type { FileSystemProvider } from '@main/core/fs/types';
import { appSettingsService } from '@main/core/settings/settings-service';
import { log } from '@main/lib/logger';
import {
  baseLocationSettingsSchema,
  DEFAULT_PRESERVE_PATTERNS,
  legacyBaseLocationSettingsSchema,
  locationSettingsSchema,
  shareableLocationSettingsSchema,
  type BaseLocationSettings,
  type LocationSettings,
  type ShareableLocationSettings,
} from '@shared/core/location-settings/location-settings';
import { SHAREABLE_FIELD_ACCESSORS } from '@shared/core/location-settings/location-settings-fields';
import type { UpdateLocationSettingsError } from '@shared/core/locations/locations';
import {
  migrateLegacyLocationSettingsIfNeeded,
  type LocationSettingsGitInspector,
} from '../legacy-location-settings-migration';
import { serializeShareableLocationSettings } from '../legacy-shareable-migration-marker';
import { compactUndefined, parseJsonObject, readJson } from '../location-settings-json';
import { LocationSettingsRepository } from '../location-settings-storage';
import type { LocationSettingsPatch, LocationSettingsProvider } from '../provider';
import { CONFIG_FILE } from '../sharing/switchdash-config-file';

export type DbLocationSettingsProviderOptions = {
  git?: LocationSettingsGitInspector;
};

export abstract class DbLocationSettingsProvider implements LocationSettingsProvider {
  private legacyMigrationPromise: Promise<void> | undefined;
  private readonly storage = new LocationSettingsRepository();

  protected constructor(
    private readonly locationId: string,
    protected readonly rootPath: string,
    private readonly configReader: Pick<FileSystemProvider, 'exists' | 'read'> | undefined,
    private readonly options: DbLocationSettingsProviderOptions = {}
  ) {}

  protected abstract defaultWorktreeDirectory(): Promise<string>;

  protected abstract validateWorktreeDirectory(
    worktreeDirectory: string | undefined
  ): Promise<Result<string | undefined, UpdateLocationSettingsError>>;

  protected abstract normalizeStoredWorktreeDirectory(
    worktreeDirectory: string
  ): Promise<Result<string, UpdateLocationSettingsError>>;

  protected async initialBaseLocationSettings(): Promise<BaseLocationSettings> {
    const locationDefaults = await appSettingsService.get('location');
    return {
      tmux: locationDefaults.tmuxByDefault,
    };
  }

  private async hasSharedPreservePatterns(): Promise<boolean> {
    if (!this.configReader) return false;
    try {
      if (!(await this.configReader.exists(CONFIG_FILE))) return false;
      const { content } = await this.configReader.read(CONFIG_FILE);
      const parsed = shareableLocationSettingsSchema.safeParse(parseJsonObject(content));
      if (!parsed.success) {
        log.warn('Failed to inspect shared location settings during initialization', parsed.error);
        return false;
      }
      return parsed.data.preservePatterns !== undefined;
    } catch (error) {
      log.warn('Failed to inspect shared location settings during initialization', error);
      return false;
    }
  }

  private async ensureRow(): Promise<void> {
    if (await this.storage.get(this.locationId)) return;

    const baseSettings = await this.initialBaseLocationSettings();
    const shareableSettings = (await this.hasSharedPreservePatterns())
      ? {}
      : { preservePatterns: [...DEFAULT_PRESERVE_PATTERNS] };
    await this.storage.insertIfMissing(this.locationId, {
      baseSettingsJson: JSON.stringify(compactUndefined(baseSettings)),
      shareableSettingsJson: serializeShareableLocationSettings(shareableSettings),
      legacyConfigMigratedAt: null,
    });
  }

  private async readSettingsRow(): Promise<{
    base: BaseLocationSettings;
    shareable: ShareableLocationSettings;
    legacyConfigMigratedAt: string | null;
  }> {
    await this.ensureRow();
    await this.migrateLegacyConfigIfNeeded();
    const row = await this.storage.get(this.locationId);
    if (!row) {
      return {
        base: await this.initialBaseLocationSettings(),
        shareable: {},
        legacyConfigMigratedAt: null,
      };
    }
    const baseSettings = readJson(
      row.baseSettingsJson,
      legacyBaseLocationSettingsSchema,
      'base location settings'
    );

    return {
      base: baseLocationSettingsSchema.parse(baseSettings),
      shareable: readJson(
        row.shareableSettingsJson,
        shareableLocationSettingsSchema,
        'shareable location settings'
      ),
      legacyConfigMigratedAt: row.legacyConfigMigratedAt,
    };
  }

  private async migrateLegacyConfigIfNeeded(git = this.options.git): Promise<void> {
    if (this.legacyMigrationPromise) {
      await this.legacyMigrationPromise;
      return;
    }

    this.legacyMigrationPromise = (async () => {
      const row = await this.storage.get(this.locationId);
      await migrateLegacyLocationSettingsIfNeeded({
        locationId: this.locationId,
        row,
        configReader: this.configReader,
        storage: this.storage,
        git,
        normalizeStoredWorktreeDirectory: (worktreeDirectory) =>
          this.normalizeStoredWorktreeDirectory(worktreeDirectory),
      });
    })();

    try {
      await this.legacyMigrationPromise;
    } catch (error) {
      this.legacyMigrationPromise = undefined;
      throw error;
    }
  }

  async ensure(options: DbLocationSettingsProviderOptions = {}): Promise<void> {
    await this.ensureRow();
    await this.migrateLegacyConfigIfNeeded(options.git);
  }

  async get(): Promise<LocationSettings> {
    const { base, shareable } = await this.readSettingsRow();
    return locationSettingsSchema.parse({ ...base, ...shareable });
  }

  async update(settings: LocationSettings): Promise<Result<void, UpdateLocationSettingsError>> {
    const parsed = locationSettingsSchema.safeParse(settings);
    if (!parsed.success) {
      return err({ type: 'invalid-settings' });
    }

    const nextSettings = parsed.data;
    const worktreeDirectoryResult = await this.validateWorktreeDirectory(
      nextSettings.worktreeDirectory
    );
    if (!worktreeDirectoryResult.success) {
      return worktreeDirectoryResult;
    }
    nextSettings.worktreeDirectory = worktreeDirectoryResult.data;

    const base = baseLocationSettingsSchema.parse(nextSettings);
    const shareable = shareableLocationSettingsSchema.parse(nextSettings);

    try {
      await this.ensure();
      const row = await this.storage.get(this.locationId);
      await this.storage.update(this.locationId, {
        baseSettingsJson: JSON.stringify(compactUndefined(base)),
        shareableSettingsJson: serializeShareableLocationSettings(shareable, {
          previousRaw: row?.shareableSettingsJson,
        }),
      });
      return ok();
    } catch (error) {
      log.warn('Failed to update location settings', error);
      return err({ type: 'error' });
    }
  }

  async patch(patch: LocationSettingsPatch): Promise<Result<void, UpdateLocationSettingsError>> {
    try {
      await this.ensure();
      const row = await this.storage.get(this.locationId);
      const base = row
        ? readJson(row.baseSettingsJson, legacyBaseLocationSettingsSchema, 'base location settings')
        : await this.initialBaseLocationSettings();
      const shareable = row
        ? readJson(
            row.shareableSettingsJson,
            shareableLocationSettingsSchema,
            'shareable location settings'
          )
        : {};

      for (const field of patch.clearShareableFields ?? []) {
        SHAREABLE_FIELD_ACCESSORS[field].clear(shareable);
      }

      const nextBase = baseLocationSettingsSchema.parse({
        ...base,
        ...(Object.hasOwn(patch, 'githubAccountId')
          ? { githubAccountId: patch.githubAccountId }
          : {}),
      });

      await this.storage.update(this.locationId, {
        baseSettingsJson: JSON.stringify(compactUndefined(nextBase)),
        shareableSettingsJson: serializeShareableLocationSettings(shareable, {
          previousRaw: row?.shareableSettingsJson,
        }),
      });
      return ok();
    } catch (error) {
      log.warn('Failed to clear shareable location settings', error);
      return err({ type: 'error' });
    }
  }

  async getDefaultWorktreeDirectory(): Promise<string> {
    return this.defaultWorktreeDirectory();
  }

  async getWorktreeDirectory(): Promise<string> {
    const settings = await this.get();
    const defaultWorktreeDirectory = await this.getDefaultWorktreeDirectory();
    if (settings.worktreeDirectory) {
      const normalized = await this.normalizeStoredWorktreeDirectory(settings.worktreeDirectory);
      if (normalized.success) {
        return normalized.data;
      }
      log.warn('LocationSettingsProvider: invalid worktreeDirectory, falling back to default', {
        worktreeDirectory: settings.worktreeDirectory,
        defaultWorktreeDirectory,
        error: normalized.error.type,
      });
    }
    return defaultWorktreeDirectory;
  }
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Result } from '@switchdash/shared';
import { appSettingsService } from '@main/core/settings/settings-service';
import type { UpdateLocationSettingsError } from '@shared/core/locations/locations';
import {
  normalizeWorktreeDirectory,
  resolveAndValidateWorktreeDirectory,
} from '../worktree-directory';
import {
  DbLocationSettingsProvider,
  type DbLocationSettingsProviderOptions,
} from './db-location-settings-provider';

async function getLocalDefaultWorktreeDirectory(): Promise<string> {
  return (await appSettingsService.get('localLocation')).defaultWorktreeDirectory;
}

const localPathPlatform = process.platform === 'win32' ? 'win32' : 'posix';

export class LocalLocationSettingsProvider extends DbLocationSettingsProvider {
  constructor(
    locationId: string,
    rootPath: string,
    options: DbLocationSettingsProviderOptions = {}
  ) {
    super(
      locationId,
      rootPath,
      {
        exists: async (filePath) => fs.existsSync(path.join(rootPath, filePath)),
        read: async (filePath) => {
          const content = await fs.promises.readFile(path.join(rootPath, filePath), 'utf8');
          return { content, truncated: false, totalSize: Buffer.byteLength(content) };
        },
      },
      options
    );
  }

  protected defaultWorktreeDirectory(): Promise<string> {
    return getLocalDefaultWorktreeDirectory();
  }

  protected validateWorktreeDirectory(
    worktreeDirectory: string | undefined
  ): Promise<Result<string | undefined, UpdateLocationSettingsError>> {
    return resolveAndValidateWorktreeDirectory(worktreeDirectory, {
      pathApi: path,
      pathPlatform: localPathPlatform,
      fs: {
        mkdir: async (p, options) => {
          await fs.promises.mkdir(p, options);
        },
        realPath: async (p) => fs.promises.realpath(p),
      },
      homeDirectory: os.homedir(),
    });
  }

  protected normalizeStoredWorktreeDirectory(
    worktreeDirectory: string
  ): Promise<Result<string, UpdateLocationSettingsError>> {
    return normalizeWorktreeDirectory(worktreeDirectory, {
      pathApi: path,
      pathPlatform: localPathPlatform,
      homeDirectory: os.homedir(),
    });
  }
}

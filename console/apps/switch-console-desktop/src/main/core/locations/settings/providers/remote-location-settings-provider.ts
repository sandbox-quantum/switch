import { posix as pathPosix } from 'node:path';
import { ok, type Result } from '@switch-console/shared';
import type { FileSystemProvider } from '@main/core/fs/types';
import type { UpdateLocationSettingsError } from '@shared/core/locations/locations';
import {
  DbLocationSettingsProvider,
  type DbLocationSettingsProviderOptions,
} from './db-location-settings-provider';

/**
 * DB-backed location settings for a remote (SSH) agent. Its working directory
 * lives on the host, so there is no local path to read/validate; the config
 * reader is backed by the SSH filesystem. Switch Console runs every session in the
 * remote working dir (no worktrees), so worktree-directory handling is a no-op.
 */
export class RemoteLocationSettingsProvider extends DbLocationSettingsProvider {
  constructor(
    locationId: string,
    remoteRepoDir: string,
    fs: Pick<FileSystemProvider, 'exists' | 'read'>,
    options: DbLocationSettingsProviderOptions = {}
  ) {
    super(locationId, remoteRepoDir, fs, options);
  }

  protected defaultWorktreeDirectory(): Promise<string> {
    return Promise.resolve(this.rootPath);
  }

  protected validateWorktreeDirectory(
    worktreeDirectory: string | undefined
  ): Promise<Result<string | undefined, UpdateLocationSettingsError>> {
    return Promise.resolve(ok(worktreeDirectory));
  }

  protected normalizeStoredWorktreeDirectory(
    worktreeDirectory: string
  ): Promise<Result<string, UpdateLocationSettingsError>> {
    return Promise.resolve(ok(pathPosix.normalize(worktreeDirectory)));
  }
}

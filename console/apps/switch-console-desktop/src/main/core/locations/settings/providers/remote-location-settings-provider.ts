import type { FileSystemProvider } from '@main/core/fs/types';
import {
  DbLocationSettingsProvider,
  type DbLocationSettingsProviderOptions,
} from './db-location-settings-provider';

/**
 * DB-backed location settings for a remote (SSH) agent. Its working directory
 * lives on the host, so there is no local path to read/validate; the config
 * reader is backed by the SSH filesystem.
 */
export class RemoteLocationSettingsProvider extends DbLocationSettingsProvider {
  constructor(
    locationId: string,
    fs: Pick<FileSystemProvider, 'exists' | 'read'>,
    options: DbLocationSettingsProviderOptions = {}
  ) {
    super(locationId, fs, options);
  }
}

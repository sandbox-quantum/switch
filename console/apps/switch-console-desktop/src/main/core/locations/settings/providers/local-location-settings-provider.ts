import fs from 'node:fs';
import path from 'node:path';
import {
  DbLocationSettingsProvider,
  type DbLocationSettingsProviderOptions,
} from './db-location-settings-provider';

export class LocalLocationSettingsProvider extends DbLocationSettingsProvider {
  constructor(
    locationId: string,
    rootPath: string,
    options: DbLocationSettingsProviderOptions = {}
  ) {
    super(
      locationId,
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
}

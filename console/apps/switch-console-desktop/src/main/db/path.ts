import { resolve } from 'node:path';
import { app } from 'electron';
import { resolveDefaultDatabasePath } from './database-file';
import { CURRENT_DB_FILENAME, LEGACY_DB_FILENAMES } from './default-path';

export interface ResolveDatabasePathOptions {
  userDataPath?: string;
}

export function resolveDatabasePath(options: ResolveDatabasePathOptions = {}): string {
  const explicitDbFile = process.env.SWITCHDASH_DB_FILE?.trim();
  if (explicitDbFile) {
    return resolve(explicitDbFile);
  }

  return resolveDefaultDatabasePath(options.userDataPath ?? app.getPath('userData'));
}

export const databaseFilenames = {
  current: CURRENT_DB_FILENAME,
  legacy: LEGACY_DB_FILENAMES,
};

import { homedir } from 'node:os';
import { join } from 'node:path';

export const CURRENT_DB_FILENAME = 'switchdash.db';

// Legacy database filenames from before the Switch Console rebrand, newest first.
// On first launch, if CURRENT_DB_FILENAME is absent, the newest existing legacy
// file is copied forward so upgrading installs keep their data. These names are
// the one place the pre-rebrand `emdash` identity is intentionally retained —
// see resolveDefaultDatabasePath() in ./database-file.ts.
export const LEGACY_DB_FILENAMES = ['emdash4.db', 'emdash3.db'] as const;

/**
 * Returns the platform-specific path of the userData directory `dirName`
 * without requiring the Electron `app` module, for code running outside
 * Electron (e.g. drizzle-kit CLI).
 */
export function resolveDefaultUserDataPath(dirName: string): string {
  const home = process.env.HOME ?? homedir();
  const platform = process.platform;

  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', dirName);
  }

  if (platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return join(appData, dirName);
  }

  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
  return join(xdgConfig, dirName);
}

/**
 * Returns the default database file path given a resolved userData directory.
 * Does not check for file existence or perform any migration — suitable for
 * contexts that only need a path (e.g. drizzle-kit config).
 */
export function defaultDbFilePath(userDataPath: string): string {
  return join(userDataPath, CURRENT_DB_FILENAME);
}

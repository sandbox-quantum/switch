import { IS_CANARY, USER_DATA_DIR_NAME } from '@shared/app-identity';

/** The variable that names another data folder, in the builds that read it. */
export const USER_DATA_DIR_ENV = 'SWITCH_CONSOLE_USER_DATA_DIR';

/**
 * The folder under the system's app-data directory this run keeps its data in.
 *
 * Several Consoles can run side by side on one machine when each keeps its
 * own: the server list, sessions, the local database and the managed local
 * server's files live there, and the managed server's Docker project is named
 * after it. Dev builds read SWITCH_CONSOLE_USER_DATA_DIR for one per worktree;
 * Canary reads it too, so a tester can start as a brand-new install without
 * touching the data their real one shares with stable. A stable build never
 * reads it.
 *
 * The name is a folder, not a path: anything else is refused at start rather
 * than resolved somewhere outside the app-data directory.
 */
export function userDataDirName(): string {
  const named = import.meta.env.DEV || IS_CANARY ? process.env[USER_DATA_DIR_ENV] : undefined;
  if (!named) return USER_DATA_DIR_NAME;
  return checkedFolderName(named);
}

/** `name` when it is one plain folder name; throws, naming the variable, otherwise. */
export function checkedFolderName(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error(
      `${USER_DATA_DIR_ENV} must be a folder name made of letters, digits, '.', '-' and '_', ` +
        `not a path: got ${JSON.stringify(name)}.`
    );
  }
  return name;
}

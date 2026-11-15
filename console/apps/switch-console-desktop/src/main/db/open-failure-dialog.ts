import { dirname, resolve } from 'node:path';
import { SWITCH_CONSOLE_RELEASES_URL } from '@shared/urls';
import { DatabaseFromNewerBuildError } from './initialize';

function newerBuildCause(error: DatabaseFromNewerBuildError, dataPath: string): string {
  // SWITCHDASH_DB_FILE can put the database anywhere, and moving aside the
  // folder it happens to sit in (or a data folder it is not in) is wrong.
  const inDataFolder = resolve(dirname(error.databasePath)) === resolve(dataPath);
  return [
    'The database was last opened by a newer or different build of the app (a Canary build, or one built from source, which share this folder), so this version cannot read it. It has not been changed.',
    // The updater runs after the database opens, so a refused build never
    // updates itself: without this, waiting for an update would wait forever.
    `To keep what is in it, open the build that last used it, or download a release newer than that build from ${SWITCH_CONSOLE_RELEASES_URL}. This version cannot update itself while it cannot start.`,
    inDataFolder
      ? 'To start empty instead, quit and move this folder aside; what was saved in it will not carry over:'
      : 'To start empty instead, quit and move this database file aside, with the -wal and -shm files beside it; what was saved in it will not carry over:',
    inDataFolder ? dataPath : error.databasePath,
  ].join('\n');
}

const GENERIC_CAUSE =
  'The usual causes are another copy of the app already running, a full disk, or the database file having been moved or made read-only. Closing the other copy and reopening is worth trying first.';

/**
 * The box shown when the database cannot be opened at boot.
 *
 * The one failure with no UI to fall back on: the app is about to quit, so
 * whatever the user needs to act has to be in this box. Name the cause and
 * remedy, where the log is, then the raw error under its own heading.
 */
export function databaseOpenFailureDialog(
  error: unknown,
  productName: string,
  dataPath: string,
  logPath: string | null | undefined
): { title: string; body: string } {
  const cause =
    error instanceof DatabaseFromNewerBuildError ? newerBuildCause(error, dataPath) : GENERIC_CAUSE;
  return {
    title: `${productName} could not open its database`,
    body: [
      `${productName} cannot start without it, so it is closing.`,
      '',
      cause,
      logPath ? `\nFull details are in the log: ${logPath}` : '',
      '',
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    ]
      .filter((line) => line !== '')
      .join('\n'),
  };
}

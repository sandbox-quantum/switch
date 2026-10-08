import { DatabaseFromNewerBuildError } from './initialize';

const NEWER_BUILD_CAUSE =
  'The database was last opened by a newer or different build of the app, most often a Canary build, which shares this database with the stable app. This version cannot read it, and has not changed it. Open the build that last used it, and keep using that one until a release of this version includes its changes.';

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
  logPath: string | null | undefined
): { title: string; body: string } {
  const cause = error instanceof DatabaseFromNewerBuildError ? NEWER_BUILD_CAUSE : GENERIC_CAUSE;
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

import { DatabaseFromNewerBuildError } from './initialize';

function newerBuildCause(dataPath: string): string {
  return [
    'The database was last opened by a newer or different build of the app (a Canary build, or one built from source, which share this folder), so this version cannot read it. It has not been changed.',
    'Open the build that last used it. If there is none to go back to, quit and move this folder aside to start empty; what was saved in it will not carry over:',
    dataPath,
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
    error instanceof DatabaseFromNewerBuildError ? newerBuildCause(dataPath) : GENERIC_CAUSE;
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

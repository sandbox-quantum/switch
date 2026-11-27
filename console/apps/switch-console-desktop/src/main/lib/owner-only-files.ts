import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';

/**
 * Modes that keep Console's data folder, database and log to their owner.
 * POSIX only: Windows has no mode bits, and an app-data folder there is its
 * user's own already.
 */
const HAS_MODE_BITS = process.platform !== 'win32';

/** Creates `dir` when absent and gives it mode 0700, whatever mode it had. */
export function makeDirOwnerOnly(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (HAS_MODE_BITS) chmodSync(dir, 0o700);
}

/**
 * Creates `file` empty when absent and gives it mode 0600, whatever mode it
 * had. Its content is left as it is.
 */
export function makeFileOwnerOnly(file: string): void {
  closeSync(openSync(file, 'a', 0o600));
  if (HAS_MODE_BITS) chmodSync(file, 0o600);
}

/** Gives each of `files` that exists mode 0600; one that does not is skipped. */
export function restrictExistingFilesToOwner(files: string[]): void {
  if (!HAS_MODE_BITS) return;
  for (const file of files) {
    try {
      chmodSync(file, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

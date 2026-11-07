import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from '@main/lib/logger';

const execFileAsync = promisify(execFile);

/**
 * Replace the inherited ACL on `path` with one granting the current user alone.
 *
 * A failure is logged rather than thrown: losing the operation over a
 * hardening step is worse than a degraded mode that says so out loud.
 */
async function restrictToOwner(path: string, grant: (account: string) => string): Promise<void> {
  const account = process.env.USERNAME;
  if (!account) {
    log.warn('fs: USERNAME unset; path left with inherited permissions', { path });
    return;
  }
  try {
    await execFileAsync('icacls', [path, '/inheritance:r', '/grant:r', grant(account)], {
      timeout: 15_000,
    });
  } catch (error) {
    log.warn('fs: could not restrict permissions; the path stays readable by other accounts', {
      path,
      error: String((error as Error)?.message ?? error),
    });
  }
}

/**
 * Windows has no mode bits: `chmod(path, 0o600)` only toggles the read-only
 * flag, so on its own it would leave a credential readable by every account on
 * the machine while looking protected.
 */
export function restrictWindowsFileToOwner(path: string): Promise<void> {
  return restrictToOwner(path, (account) => `${account}:F`);
}

/**
 * The directory counterpart of {@link restrictWindowsFileToOwner}, standing in
 * for `chmod(dir, 0o700)`. The grant is inheritable, so files already in the
 * directory that inherit their permissions, and any created in it later, are
 * restricted with it.
 */
export function restrictWindowsDirectoryToOwner(path: string): Promise<void> {
  return restrictToOwner(path, (account) => `${account}:(OI)(CI)F`);
}

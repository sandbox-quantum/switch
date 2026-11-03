import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from '@main/lib/logger';

const execFileAsync = promisify(execFile);

/**
 * Windows has no mode bits: `chmod(path, 0o600)` only toggles the read-only
 * flag, so on its own it would leave a credential readable by every account on
 * the machine while looking protected. Replace the inherited ACL with one that
 * grants the current user alone.
 *
 * A failure is logged rather than thrown: losing the operation over a
 * hardening step is worse than a degraded mode that says so out loud.
 */
export async function restrictWindowsFileToOwner(path: string): Promise<void> {
  const account = process.env.USERNAME;
  if (!account) {
    log.warn('fs: USERNAME unset; file left with inherited permissions', { path });
    return;
  }
  try {
    await execFileAsync('icacls', [path, '/inheritance:r', '/grant:r', `${account}:F`], {
      timeout: 15_000,
    });
  } catch (error) {
    log.warn('fs: could not restrict file permissions; it stays readable by other accounts', {
      path,
      error: String((error as Error)?.message ?? error),
    });
  }
}

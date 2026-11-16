import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { writeSecretFile } from '@main/core/providers/plugin-fs';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { hostKeyProblemsChannel } from '@shared/core/ssh/host-keys';
import { createConsoleKnownHosts } from './console-known-hosts';
import {
  prepareHostKeyCheck,
  type HostKeyTarget,
  type PreparedHostKeyCheck,
} from './host-key-check';
import { HostKeyTrustService } from './host-key-trust-service';

export const consoleKnownHosts = createConsoleKnownHosts(
  () => join(app.getPath('userData'), 'ssh', 'known_hosts'),
  writeSecretFile
);

export const hostKeyTrustService = new HostKeyTrustService({
  trust: (hostKeyName, key) => consoleKnownHosts.trust(hostKeyName, key),
  publish: (problems) => events.emit(hostKeyProblemsChannel, problems),
  log,
});

/**
 * A known_hosts file's text, or null when it does not exist. A file that
 * exists but cannot be read fails the connection: checking without it could
 * turn a host it vouches for into an "unknown" one, or miss a revocation.
 */
async function readKnownHostsFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new Error(
      `Could not read the known_hosts file ${path} to check the SSH host key: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export function checkHostKey(target: HostKeyTarget): Promise<PreparedHostKeyCheck> {
  return prepareHostKeyCheck(target, {
    readKnownHostsFile,
    consoleKnownHosts,
    reportProblem: (problem, key) => hostKeyTrustService.report(problem, key),
    reportVerified: (sshHost) => hostKeyTrustService.reportVerified(sshHost),
  });
}

import { join } from 'node:path';
import { app } from 'electron';

/** Root for the local managed stack's on-disk runtime artifacts (compose file +
 * env) and persisted metadata (ports.json), under the app's user-data dir so it
 * is per-install and easy to locate. */
export function localServerDir(): string {
  return join(app.getPath('userData'), 'local-switch-server');
}

/** Root for a remote managed host's DESKTOP-side metadata (ports.json), kept
 * per SSH host under user-data. The stack's compose file + `.env` live on the
 * remote host itself, not here. */
export function remoteServerStateDir(hostSlug: string): string {
  return join(app.getPath('userData'), 'remote-switch-server', hostSlug);
}

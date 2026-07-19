import { join } from 'node:path';
import { app } from 'electron';

/** Root for the managed stack's on-disk runtime artifacts (compose file + env),
 * under the app's user-data dir so it is per-install and easy to locate. */
export function localServerDir(): string {
  return join(app.getPath('userData'), 'local-switch-server');
}

/** Where the bundled compose is written so `docker compose -f <path>` can run
 * it. Docker cannot read a file inside the app bundle, so we materialise it. */
export function composeFilePath(): string {
  return join(localServerDir(), 'standalone-docker-compose.yml');
}

/** The generated `.env` docker compose interpolates. Secrets originate in the
 * encrypted store; this file is a derived runtime artifact (written 0600). */
export function envFilePath(): string {
  return join(localServerDir(), '.env');
}

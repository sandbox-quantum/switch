import { join } from 'node:path';
import { app } from 'electron';

/** Root for the local managed stack's on-disk runtime artifacts (compose file +
 * env) and persisted metadata (ports.json), under the app's user-data dir so it
 * is per-install and easy to locate. */
export function localServerDir(): string {
  return join(app.getPath('userData'), 'local-switch-server');
}

/**
 * Where a packaged Console keeps the native local server's bundle (see
 * native/bundle.ts), or null in a dev build, which has none.
 * `SWITCH_LOCAL_SERVER_BUNDLE` points a dev build at one built by
 * `pnpm run build:local-server`, to exercise the packaged path.
 */
export function localServerBundleRoot(): string | null {
  const override = process.env.SWITCH_LOCAL_SERVER_BUNDLE?.trim();
  if (override) return override;
  return app.isPackaged ? join(process.resourcesPath, 'local-server') : null;
}

/** Root for a remote managed host's DESKTOP-side metadata (ports.json), kept
 * per SSH host under user-data. The stack's compose file + `.env` live on the
 * remote host itself, not here. */
export function remoteServerStateDir(hostSlug: string): string {
  return join(app.getPath('userData'), 'remote-switch-server', hostSlug);
}

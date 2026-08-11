import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

const BUNDLE_DIR = 'dist-sidecar';

/**
 * Locate a built remote-runtime bundle on the local machine so it can be
 * deployed to a VM. In a packaged build it ships under `process.resourcesPath`
 * via electron-builder extraResources; in dev it lives at the app root next to
 * `pnpm run build:sidecar`'s output. Fails loud if neither exists — a remote
 * session cannot start without it.
 */
function resolveBundlePath(bundleName: string): string {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, BUNDLE_DIR, bundleName) : undefined,
    join(app.getAppPath(), BUNDLE_DIR, bundleName),
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `${bundleName} not found (looked in: ${candidates.join(', ')}). Run \`pnpm run build:sidecar\`.`
  );
}

/** The one agent-scoped remote runtime sidecar bundle. */
export function resolveSidecarBundlePath(): string {
  return resolveBundlePath('sidecar.mjs');
}

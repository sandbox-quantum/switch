import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Why Squirrel.Mac cannot replace the running app bundle.
 *
 * Squirrel.Mac's installer runs as the signed-in user and swaps the bundle in
 * place. When it cannot, it fails after the app has handed over, and macOS
 * relaunches the old version with nothing on screen to say why. These are the
 * causes that can be read before offering a restart.
 */
export type InstallBlocker =
  /** Gatekeeper is running the app from a randomised read-only mount. */
  | { reason: 'translocated'; bundlePath: string }
  /** The bundle belongs to another account, root after an installer or `sudo` copy. */
  | { reason: 'not_owned'; bundlePath: string }
  /** The bundle, or the folder it is replaced in, cannot be written. */
  | { reason: 'not_writable'; bundlePath: string; deniedPath: string };

/** The `.app` bundle that holds a macOS executable, or null outside a bundle. */
export function macAppBundlePath(executablePath: string): string | null {
  const match = /^(.+?\.app)(?:\/|$)/.exec(executablePath);
  return match?.[1] ?? null;
}

function isTranslocated(bundlePath: string): boolean {
  return bundlePath.includes('/AppTranslocation/');
}

async function isWritable(target: string): Promise<boolean> {
  try {
    await access(target, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first reason the bundle at `bundlePath` cannot be updated in place by the
 * account `uid`, or null when nothing stands in the way.
 */
export async function findInstallBlocker(
  bundlePath: string,
  uid: number
): Promise<InstallBlocker | null> {
  if (isTranslocated(bundlePath)) return { reason: 'translocated', bundlePath };

  const info = await stat(bundlePath);
  if (info.uid !== uid) return { reason: 'not_owned', bundlePath };

  for (const target of [bundlePath, path.dirname(bundlePath)]) {
    if (!(await isWritable(target))) {
      return { reason: 'not_writable', bundlePath, deniedPath: target };
    }
  }
  return null;
}

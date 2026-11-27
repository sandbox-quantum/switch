import { lstatSync } from 'node:fs';

/**
 * Box mode: hosted agents v2's box, one switch for everything only a box does.
 *
 * The box image carries a marker file, root-owned and read-only (`/etc/switch/box`, Linux only), on a root filesystem every container in a box
 * mounts read-only (the cluster's box pod rule refuses anything else), so nothing inside a box can remove it and no
 * process there can become root. It is the one thing that says "inside a box".
 *
 * - The controller runs in box mode only with `--box` on its command line **and** the marker; either without the
 *   other refuses to start (`resolveControllerBoxMode`).
 * - The agent host takes box mode from the marker alone (`hostBoxMode`). The controller's config for it can only add
 *   a refusal: a config that says box with no marker refuses to start, so a host never drops quietly to desktop.
 *
 * Desktop and v1 have no marker and pass no `--box`: nothing here changes them. Box mode is passed down as a value
 * (`{ box: boolean }`), never read from a global or the environment.
 */
export const BOX_MARKER_PATH = '/etc/switch/box';

/** What `insideBox` needs of a file's `lstat`. */
export type MarkerStat = { isFile(): boolean; uid: number; mode: number };

export type MarkerProbe = {
  platform?: NodeJS.Platform;
  /** Throws when there is nothing there, as `lstatSync` does. */
  lstat?: (path: string) => MarkerStat;
  markerPath?: string;
};

/**
 * Whether this process is inside a box image. Only a Linux marker counts, and only a regular file owned by root and
 * not writable by group or others: elsewhere (`C:\etc` on Windows, which an ordinary user may create) or written by
 * anyone else, a file at that path proves nothing and counts as "not a box". Any error reading it counts the same.
 */
export function insideBox(probe: MarkerProbe = {}): boolean {
  const platform = probe.platform ?? process.platform;
  if (platform !== 'linux') return false;
  let stat: MarkerStat;
  try {
    stat = (probe.lstat ?? lstatSync)(probe.markerPath ?? BOX_MARKER_PATH);
  } catch {
    return false;
  }
  return stat.isFile() && stat.uid === 0 && (stat.mode & 0o022) === 0;
}

export class BoxModeMismatch extends Error {}

/** The controller's box mode, from its `--box` flag and the image marker; refuses a mismatch either way. */
export function resolveControllerBoxMode(flag: boolean, inBox: boolean): boolean {
  if (inBox && !flag)
    throw new BoxModeMismatch(
      'This is a box image: the controller runs here only in box mode (--box).'
    );
  if (flag && !inBox)
    throw new BoxModeMismatch('--box is only for the box image, which this is not.');
  return flag;
}

/** The agent host's box mode: the marker decides; a config asking for box mode without it refuses. */
export function hostBoxMode(configSaysBox: boolean, inBox: boolean): boolean {
  if (configSaysBox && !inBox)
    throw new BoxModeMismatch(
      'This agent host was configured for a box, but this is not a box image: not starting.'
    );
  return inBox;
}

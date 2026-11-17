import type { Dirent } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { app, session as electronSession } from 'electron';
import { log } from '@main/lib/logger';
import {
  dashboardWindowSessionsCleared,
  markDashboardWindowSessionsCleared,
} from './dashboard-window-marker';

/** Each server's in-app dashboard window used to load in a persistent
 * partition of its own, `persist:switch-gateway:<server id>`. */
const PARTITION_FAMILY = 'switch-gateway:';

/** One of those partitions as it lies on disk. */
type DashboardWindowPartition = { partition: string; directory: string };

/**
 * Every dashboard-window partition on disk, whichever server it was for,
 * servers removed since included: no list of servers names those.
 *
 * Electron keeps a persistent partition in `Partitions/` under the session
 * data directory (`userData`, unless set apart), in a directory named for the
 * partition without its `persist:` prefix, lower-cased and percent-escaped:
 * `persist:switch-gateway:srv-1` lies in `switch-gateway%3Asrv-1`. Only that
 * family is returned; `switch-mattermost` and every other partition are left
 * alone.
 */
async function partitionsOnDisk(): Promise<DashboardWindowPartition[]> {
  const root = join(app.getPath('sessionData'), 'Partitions');
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const name = entry.isDirectory() ? partitionName(entry.name) : null;
    return name?.startsWith(PARTITION_FAMILY)
      ? [{ partition: `persist:${name}`, directory: join(root, entry.name) }]
      : [];
  });
}

/** The partition a directory under `Partitions/` holds, or null for a name
 * Electron did not escape. */
function partitionName(directory: string): string | null {
  try {
    return decodeURIComponent(directory);
  } catch {
    return null;
  }
}

/**
 * Empty a partition through its session, then remove its directory, which
 * Electron leaves behind once emptied.
 *
 * The cookie is gone, on disk too, once the session is cleared and flushed.
 * A directory that cannot be removed after that (Windows keeps the open
 * session's files locked) holds nothing of the session, so it is only logged.
 */
async function clearPartition({ partition, directory }: DashboardWindowPartition): Promise<void> {
  const session = electronSession.fromPartition(partition);
  await session.clearStorageData();
  await session.cookies.flushStore();
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    log.warn('switch-servers: cleared an old dashboard window’s session but left its directory', {
      partition,
      error: String(error),
    });
  }
}

/**
 * Clear what the old in-app dashboard windows kept, once per install.
 *
 * Each server's window had its own persistent partition holding a copy of
 * Console's session cookie for that server. Dashboard pages open in the
 * browser now, with a session of the browser's own, so those copies are
 * only a credential lying on disk. Every such partition on disk is cleared,
 * a removed server's too. One that cannot be cleared is logged, and the whole
 * pass runs again at the next launch.
 */
export async function clearDashboardWindowSessions(): Promise<void> {
  if (await dashboardWindowSessionsCleared()) return;
  const partitions = await partitionsOnDisk();
  const results = await Promise.allSettled(partitions.map(clearPartition));
  const failed = results.flatMap((result, index) =>
    result.status === 'rejected'
      ? [{ partition: partitions[index]?.partition, reason: result.reason }]
      : []
  );
  for (const { partition, reason } of failed) {
    log.warn('switch-servers: could not clear the session an old dashboard window kept', {
      partition,
      error: String(reason),
    });
  }
  if (failed.length === 0) await markDashboardWindowSessionsCleared();
}

/**
 * Clear the partition `serverId`'s old dashboard window kept, when one is on
 * disk, as the server is removed. Opens no session otherwise: opening a
 * persistent partition creates its directory.
 */
export async function clearDashboardWindowSession(serverId: string): Promise<void> {
  const partition = `persist:${PARTITION_FAMILY}${serverId}`.toLowerCase();
  for (const found of await partitionsOnDisk()) {
    if (found.partition === partition) await clearPartition(found);
  }
}

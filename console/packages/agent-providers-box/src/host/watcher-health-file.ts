import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { fileMode } from './host-permissions';
import { replaceFile } from './replace-file';
import { type WatcherControl, watcherHealthSchema } from './watcher-tools';

/**
 * Where a watcher keeps its own account of its connection to Switch, beside
 * its other state.
 *
 * Console reads it with the rest of the host's watcher state, in one command
 * for every agent on the host, instead of holding a connection to each sidecar
 * and waiting to be told. A connection can die without saying so — across an
 * SSH reconnect, say — and then the last thing it carried stays on screen for
 * good. A file read every few seconds cannot go stale that way.
 */
export const WATCHER_HEALTH_FILE = 'health.json';

/**
 * What the file holds: the watcher's health, the process that wrote it, and
 * when. A reader compares `pid` with the watcher process it sees alive, so a
 * file a previous watcher left behind is not read as this one's word.
 */
export const watcherHealthFileSchema = watcherHealthSchema.extend({
  pid: z.number().int().positive(),
  updatedAt: z.string(),
  /**
   * The `bundleIdentity` of the shared-host bundle the writing process was
   * started from. Absent from a process that does not run from one (an agents
   * controller's own), and from one too old to say.
   */
  bundle: z.string().optional(),
});

export type WatcherHealthFile = z.infer<typeof watcherHealthFileSchema>;

/**
 * What identifies a shared-host bundle: the SHA-256 of the file. Its path does
 * not, since an install can replace the file in place.
 */
export async function bundleIdentity(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

/**
 * Keep `health.json` in `root` in step with what the watcher reports to
 * `control`, from now until the returned function is called. Written whole,
 * under a temporary name and renamed into place, so a reader never sees half
 * of it; and in order, so an older state never lands after a newer one.
 * `bundle` is the `bundleIdentity` of the bundle this process started from,
 * or null when it did not start from one.
 */
export function recordWatcherHealth(
  root: string,
  control: WatcherControl,
  bundle: string | null
): () => void {
  const path = join(root, WATCHER_HEALTH_FILE);
  let writing: Promise<void> = Promise.resolve();
  const write = () => {
    const body: WatcherHealthFile = {
      ...control.health(),
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      ...(bundle ? { bundle } : {}),
    };
    writing = writing
      .then(async () => {
        const temporary = `${path}.${randomUUID()}`;
        await writeFile(temporary, JSON.stringify(body), { mode: fileMode(0o600) });
        await replaceFile(temporary, path);
      })
      .catch((error: unknown) => {
        console.error(`Could not record the room watcher's health in ${path}: ${String(error)}`);
      });
  };
  write();
  return control.onHealth(write);
}

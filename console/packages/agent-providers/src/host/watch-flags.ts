import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * The two things Console can change about a controller without rebuilding its
 * configuration, held in a file both a local and a deployed host can read.
 *
 * `enabled` is whether this agent should have a controller at all. `spawn` is
 * whether that controller may start a session, which is the auto-start setting
 * and nothing else. They are separate because an agent is reachable because it
 * exists, whereas starting a session on its behalf is a decision somebody made:
 * a controller that is connected and not spawn-capable is the state where an
 * agent can be addressed, counted and caught up on, and still answers that it
 * has no session rather than promising one that will never arrive.
 */
export const watchFlagsSchema = z.object({ enabled: z.boolean(), spawn: z.boolean() });

export type WatchFlags = z.infer<typeof watchFlagsSchema>;

export const WATCH_FLAGS_FILE = 'watch.json';

export async function readWatchFlags(root: string): Promise<WatchFlags> {
  return watchFlagsSchema.parse(JSON.parse(await readFile(join(root, WATCH_FLAGS_FILE), 'utf8')));
}

/**
 * Resolves once the flags say this controller should stand down, or once the
 * signal fires. Both writers replace the file by rename, so the directory is
 * watched rather than the path, and the watch is in place before the first read
 * so a write landing between the two is still seen. A read that fails is the
 * caller's problem, not something to sit through: it rejects.
 */
export function awaitWatchDisabled(root: string, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return resolve();
    let settled = false;
    let reading: Promise<void> = Promise.resolve();
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      watcher.close();
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish();
    const check = () => {
      reading = reading
        .then(async () => {
          if (!(await readWatchFlags(root)).enabled) finish();
        })
        .catch((error: Error) => finish(error));
    };
    const watcher = watch(root, (_event, filename) => {
      // A null filename is the platform declining to say what changed, so the
      // flags are re-read rather than assumed unchanged.
      if (filename === null || filename === WATCH_FLAGS_FILE) check();
    });
    watcher.on('error', (error: Error) => finish(error));
    signal.addEventListener('abort', onAbort, { once: true });
    check();
  });
}

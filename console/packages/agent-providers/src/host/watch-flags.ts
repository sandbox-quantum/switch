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
 * Resolves with the flags on disk once they differ from `current`, or with null
 * once the signal fires. Both flags are watched, not just `enabled`: a
 * controller declares whether it may spawn when it opens its connection, so a
 * change to that answer is something the running controller has to act on
 * rather than pick up at its next start.
 *
 * Both writers replace the file by rename, so the directory is watched rather
 * than the path, and the watch is in place before the first read so a write
 * landing between the two is still seen. A read that fails is the caller's
 * problem, not something to sit through: it rejects.
 */
export function awaitWatchChange(
  root: string,
  current: WatchFlags,
  signal: AbortSignal
): Promise<WatchFlags | null> {
  return new Promise<WatchFlags | null>((resolve, reject) => {
    if (signal.aborted) return resolve(null);
    let settled = false;
    let reading: Promise<void> = Promise.resolve();
    const finish = (flags: WatchFlags | null, error?: Error) => {
      if (settled) return;
      settled = true;
      watcher.close();
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(flags);
    };
    const onAbort = () => finish(null);
    const check = () => {
      reading = reading
        .then(async () => {
          const flags = await readWatchFlags(root);
          if (flags.enabled !== current.enabled || flags.spawn !== current.spawn) finish(flags);
        })
        .catch((error: Error) => finish(null, error));
    };
    const watcher = watch(root, (_event, filename) => {
      // A null filename is the platform declining to say what changed, so the
      // flags are re-read rather than assumed unchanged.
      if (filename === null || filename === WATCH_FLAGS_FILE) check();
    });
    watcher.on('error', (error: Error) => finish(null, error));
    signal.addEventListener('abort', onAbort, { once: true });
    check();
  });
}

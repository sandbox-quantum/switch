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

import { watch, type FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
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
 * agent can be addressed, counted and caught up on, and starts nothing when it
 * is.
 */
export const watchFlagsSchema = z.object({ enabled: z.boolean(), spawn: z.boolean() });

export type WatchFlags = z.infer<typeof watchFlagsSchema>;

export const WATCH_FLAGS_FILE = 'watch.json';

/** How often the flags are re-read where the platform cannot watch for them. */
const POLL_INTERVAL_MS = 1_000;

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
 *
 * A watch that cannot be established — a host at its descriptor or watch limit
 * — is reported and the file is read on a timer instead. The controller is the
 * agent's only inbound connection, so losing the watch costs the delay in
 * noticing a setting change, where failing here would take the agent off the
 * air entirely.
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
    let watcher: FSWatcher | null = null;
    let polling: ReturnType<typeof setInterval> | null = null;
    const finish = (flags: WatchFlags | null, error?: Error) => {
      if (settled) return;
      settled = true;
      watcher?.close();
      if (polling) clearInterval(polling);
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
    const readOnATimer = (reason: string) => {
      if (settled || polling) return;
      console.warn(
        `Cannot watch ${WATCH_FLAGS_FILE} for changes; reading it every ${POLL_INTERVAL_MS}ms instead: ${reason}`
      );
      polling = setInterval(check, POLL_INTERVAL_MS);
    };
    try {
      watcher = watch(root, (_event, filename) => {
        // A null filename is the platform declining to say what changed, so the
        // flags are re-read rather than assumed unchanged.
        if (filename === null || filename === WATCH_FLAGS_FILE) check();
      });
    } catch (error) {
      readOnATimer(String(error));
    }
    watcher?.on('error', (error: Error) => {
      watcher?.close();
      watcher = null;
      readOnATimer(error.message);
    });
    signal.addEventListener('abort', onAbort, { once: true });
    check();
  });
}

/** The agent host's configuration, which its definition is read from. */
const CONFIG_FILE = 'config.json';

/**
 * Calls `listener` each time the agent host's `config.json` under `root` is
 * replaced, until `signal` fires or the returned function is called. It is
 * how whoever runs the agent host (the agents controller, Console) hands it a
 * new definition: they rewrite the file, and the running host hears it.
 *
 * Writers replace the file by rename, so the directory is watched. Where the
 * platform cannot watch, the file's modification time is read on a timer
 * instead, and that is reported.
 */
export function onConfigReplaced(
  root: string,
  signal: AbortSignal,
  listener: () => void
): () => void {
  let watcher: FSWatcher | null = null;
  let polling: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  // What the file was when last looked at. Any change in the directory is a
  // reason to look again: platforms differ in which name a rename reports
  // (the temporary file's, the target's, or none), so the event's name is
  // not trusted to say whether this file was the one replaced.
  let seen: string | null = null;
  let checking: Promise<void> = Promise.resolve();
  const identity = async (): Promise<string | null> => {
    try {
      const stats = await stat(join(root, CONFIG_FILE));
      return `${stats.ino}:${stats.mtimeMs}:${stats.size}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const check = () => {
    checking = checking
      .then(async () => {
        if (closed) return;
        const now = await identity();
        if (now === seen) return;
        seen = now;
        if (now !== null) listener();
      })
      .catch((error: Error) => console.warn(`Cannot read ${CONFIG_FILE}: ${error.message}`));
  };
  const close = () => {
    if (closed) return;
    closed = true;
    watcher?.close();
    if (polling) clearInterval(polling);
    signal.removeEventListener('abort', close);
  };
  const readOnATimer = (reason: string) => {
    if (closed || polling) return;
    console.warn(
      `Cannot watch ${CONFIG_FILE} for changes; reading it every ${POLL_INTERVAL_MS}ms instead: ${reason}`
    );
    polling = setInterval(check, POLL_INTERVAL_MS);
    polling.unref();
  };
  if (signal.aborted) return close;
  checking = identity().then(
    (now) => {
      seen = now;
    },
    (error: Error) => console.warn(`Cannot read ${CONFIG_FILE}: ${error.message}`)
  );
  try {
    watcher = watch(root, check);
  } catch (error) {
    readOnATimer(String(error));
  }
  watcher?.on('error', (error: Error) => {
    watcher?.close();
    watcher = null;
    readOnATimer(error.message);
  });
  signal.addEventListener('abort', close, { once: true });
  return close;
}

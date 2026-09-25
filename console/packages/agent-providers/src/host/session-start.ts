import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * How a session came to start, as whatever launched it knows: a person in
 * Console (`user`), the agent being addressed in a room (`room`), or Console's
 * local automation API (`automation`).
 *
 * Only the launcher knows this. Sessions share their agent's one connection to
 * Switch, so nothing about a new session reaches the server unless its host
 * says so — which it does once, from what the launcher recorded here.
 */
export const hostStartSources = ['user', 'room', 'automation'] as const;
export type HostStartSource = (typeof hostStartSources)[number];

/**
 * Written beside `config.json` when a state root is created, and removed once
 * the server has answered the report.
 *
 * A file of its own rather than a field on the config: the config is parsed
 * strictly by every build that reads it, including an older sidecar on a
 * remote host, so a new field there would make that sidecar refuse to start
 * the session. No older build reads this file.
 */
export const SESSION_START_FILE = 'session-start.json';

// `unknown` is a launcher that said nothing — an older Console asking a newer
// sidecar, say. Reported rather than dropped, so a launch path nobody stamped
// shows up as a gap instead of as no sessions.
const owedSchema = z.strictObject({
  startSource: z.enum([...hostStartSources, 'unknown']),
});
export type OwedSessionStart = z.infer<typeof owedSchema>['startSource'];

/** Records that this new session's start is owed to the server. */
export async function recordSessionStart(
  root: string,
  startSource: HostStartSource | null
): Promise<void> {
  const path = join(root, SESSION_START_FILE);
  const temporary = `${path}.${randomUUID()}`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify({ startSource: startSource ?? 'unknown' }));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}

/** The start this session still owes the server, or null if it owes none. */
export async function owedSessionStart(root: string): Promise<OwedSessionStart | null> {
  let text: string;
  try {
    text = await readFile(join(root, SESSION_START_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return owedSchema.parse(JSON.parse(text)).startSource;
}

/** The server answered, so the start is no longer owed. */
export async function settleSessionStart(root: string): Promise<void> {
  await unlink(join(root, SESSION_START_FILE)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

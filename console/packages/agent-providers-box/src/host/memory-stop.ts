import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SwitchIdentity } from '@sandboxaq/switch-agent-runtime-box/hosted';
import { replaceFile } from './replace-file';
import type { SharedHostConfig } from './shared-config';
import { announceBoxFull } from './watcher-tools';

/** The agreed line when the memory guard stops an agent, word for word. */
export const MEMORY_STOP_MESSAGE =
  "I used more memory than I'm allowed, so I stopped that work. Your other agents are fine. Mention me again when you want me to try again.";

/** The agents controller's request, written in the agent's state root just before it asks. */
export const MEMORY_STOP_REQUEST_FILE = 'memory-stop.json';
/** How old a request may be and still be honoured. */
const REQUEST_FRESH_MS = 30_000;
/** How long the host spends telling rooms before it answers with what it posted. */
const ANNOUNCE_BUDGET_MS = 2_500;

/**
 * Written by the agents controller just before it asks the agent host to
 * tell its rooms: the host posts only with a fresh one, so nothing else that
 * can reach its control port can make it claim a stop that is not happening.
 */
export async function requestMemoryStop(root: string, now: number = Date.now()): Promise<void> {
  const path = join(root, MEMORY_STOP_REQUEST_FILE);
  const temporary = `${path}.${randomUUID()}`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify({ at: now }));
  } finally {
    await file.close();
  }
  await replaceFile(temporary, path);
}

async function freshRequest(root: string, now: number): Promise<boolean> {
  let file: FileHandle | undefined;
  try {
    // Opened without following a link or waiting on a pipe planted at the
    // name, and checked on the open file.
    file = await open(
      join(root, MEMORY_STOP_REQUEST_FILE),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    );
    const info = await file.stat();
    if (!info.isFile() || info.size > 256) return false;
    const { at } = JSON.parse(await file.readFile('utf8')) as { at?: unknown };
    return typeof at === 'number' && at <= now + 1_000 && now - at <= REQUEST_FRESH_MS;
  } catch {
    return false;
  } finally {
    await file?.close();
  }
}

/**
 * Tells the rooms of an agent the memory guard is about to stop: once per
 * room, in the room of each session mid-turn, whose work is being cut off,
 * or when none is, in each room a session of the agent attends. Posted as
 * the agent, through each session, as the box-full line is. Only with a
 * fresh request from the agents controller (`requestMemoryStop`), which is
 * removed once read. Rooms are started for at most 2.5 s. Resolves
 * to how many rooms were told; a room that could not be is logged and
 * skipped, as the stop goes on anyway.
 */
export async function announceMemoryStop(input: {
  /** The agent's state root, where the controller's request is. */
  root: string;
  busy: () => string[];
  /** The sessions placed in a room. */
  placed: () => string[];
  roomOf: (sessionId: string) => string | null;
  sessionConfig: (sessionId: string) => Promise<SharedHostConfig | null>;
  sessionRoot: (sessionId: string) => string;
  identity: SwitchIdentity;
  connectionId: string;
  post?: typeof announceBoxFull;
  now?: () => number;
}): Promise<number> {
  const now = input.now ?? Date.now;
  const started = now();
  const fresh = await freshRequest(input.root, started);
  // Used once: a second ask needs a second request.
  await rm(join(input.root, MEMORY_STOP_REQUEST_FILE), { force: true }).catch(() => {});
  if (!fresh) {
    console.warn(
      'A memory guard stop was asked for with no fresh request from the controller; no room told.'
    );
    return 0;
  }
  const post = input.post ?? announceBoxFull;
  const busy = input.busy();
  const rooms = new Set<string>();
  let told = 0;
  for (const sessionId of busy.length ? busy : input.placed()) {
    // The controller waits 3 s: no new room is started after 2.5, so what
    // is answered is what was posted.
    if (now() - started > ANNOUNCE_BUDGET_MS) break;
    try {
      const room = input.roomOf(sessionId);
      if (room !== null && rooms.has(room)) continue;
      const config = await input.sessionConfig(sessionId);
      if (!config) continue;
      await post({
        identity: input.identity,
        connectionId: input.connectionId,
        session: config.session,
        root: input.sessionRoot(sessionId),
        cwd: config.start.input.cwd,
        threadId: null,
        body: MEMORY_STOP_MESSAGE,
      });
      if (room !== null) rooms.add(room);
      told++;
    } catch (error) {
      console.error(
        `Could not tell session ${sessionId}'s room the memory guard stopped this agent: ${
          error instanceof Error ? error.name : 'unknown error'
        }`
      );
    }
  }
  console.warn(`The memory guard is stopping this agent; ${told} room(s) told.`);
  return told;
}

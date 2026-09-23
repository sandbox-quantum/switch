import { randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { KV } from '@main/db/kv';
import { log } from '@main/lib/logger';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

/**
 * Who this copy of Switch Console is, to the servers it runs and the people it
 * shares them with (CHOO-2893).
 *
 * A server Switch Console manages on a shared VM is used by everyone with
 * access to that VM, and they all sign in as the one admin account the stack
 * was seeded with. The server's own records then say the same thing for each
 * of them, so the Console says who it is: on every call to that server (the
 * server stamps it on its log lines) and in the register of Consoles kept on
 * the VM beside the stack.
 *
 * Deliberately not the telemetry install id. That one exists only with the
 * user's consent and is promised to go nowhere but the telemetry relay; this
 * one goes to servers the user runs, whether or not they share usage data.
 */

/** What the server keeps of each header: see `request_context.py` in core. The
 * name is reduced to the same set here, so what the Console shows as "you" is
 * exactly what the server records. */
const NAME_CHARACTERS = /[^A-Za-z0-9._@+-]/g;
const MAX_NAME_LENGTH = 64;

export const CONSOLE_ID_HEADER = 'X-Switch-Console-Id';
export const CONSOLE_NAME_HEADER = 'X-Switch-Console-Name';

export type ConsoleIdentity = {
  /** Random, created on first use and kept in the local database. Nothing
   * about it is derived from the machine or the user. */
  id: string;
  /** `user@host` of the desktop this Console runs on, for people to read. */
  name: string;
};

const store = new KV<{ consoleId: string }>('console-identity');

let pendingId: Promise<string> | null = null;

async function loadId(): Promise<string> {
  const existing = await store.get('consoleId');
  if (existing) return existing;
  const created = randomUUID();
  await store.setOrThrow('consoleId', created);
  return created;
}

function consoleId(): Promise<string> {
  pendingId ??= loadId().catch((error: unknown) => {
    // A failed write must not poison every later call with a rejected promise.
    pendingId = null;
    throw error;
  });
  return pendingId;
}

function sanitiseName(raw: string): string {
  return raw.replace(/\s+/g, '-').replace(NAME_CHARACTERS, '').slice(0, MAX_NAME_LENGTH);
}

function desktopUser(): string {
  try {
    return userInfo().username;
  } catch (error) {
    // A user with no passwd entry (some containers) has no name to give. The
    // Console still works; its register entry just says so rather than
    // inventing one.
    log.warn('console-identity: could not read the desktop user name', { error });
    return 'unknown';
  }
}

/** The name this Console shows to others: `user@host`, reduced to what the
 * server will keep. Read fresh, since a renamed machine should say so. */
export function consoleName(): string {
  return sanitiseName(`${desktopUser()}@${hostname()}`) || 'unknown';
}

export async function getConsoleIdentity(): Promise<ConsoleIdentity> {
  return { id: await consoleId(), name: consoleName() };
}

/**
 * The headers that identify this Console to `server`, or none.
 *
 * Only a server this Console manages is told. That is where several people
 * share one sign-in, which is the gap the headers fill; a server someone else
 * runs signs each person in as themselves and has no use for the desktop's
 * user and host name, so it is not sent them.
 */
export async function consoleIdentityHeaders(
  server: Pick<SwitchServer, 'managed'>
): Promise<Record<string, string>> {
  if (!server.managed) return {};
  const identity = await getConsoleIdentity();
  return { [CONSOLE_ID_HEADER]: identity.id, [CONSOLE_NAME_HEADER]: identity.name };
}

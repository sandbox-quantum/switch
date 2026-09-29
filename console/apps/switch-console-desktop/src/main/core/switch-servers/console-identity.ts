import { randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { KV } from '@main/db/kv';
import { log } from '@main/lib/logger';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

/**
 * Who this copy of Switch Console is, to the servers it manages (CHOO-2893).
 * Everyone on a shared VM signs in as the stack's one admin, so the Console
 * identifies itself on every call and in the register kept beside the stack.
 *
 * Deliberately not the telemetry install id, which exists only with consent
 * and is promised to go nowhere but the telemetry relay.
 */

/** Matches what `request_context.py` in core keeps of the header, so the
 * Console shows the same name the server records. */
const NAME_CHARACTERS = /[^A-Za-z0-9._@+-]/g;
const MAX_NAME_LENGTH = 64;

export const CONSOLE_ID_HEADER = 'X-Switch-Console-Id';
export const CONSOLE_NAME_HEADER = 'X-Switch-Console-Name';

export type ConsoleIdentity = {
  /** Random, created on first use and stored locally; not derived from the
   * machine or the user. */
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

/** One half of `user@host`, reduced to what the server keeps — or `unknown`
 * when nothing of it survives, rather than a bare `@` telling nobody apart. */
function namePart(raw: string): string {
  return raw.replace(/\s+/g, '-').replace(NAME_CHARACTERS, '') || 'unknown';
}

/** Warn once: the name is read on every managed-server request. */
let userNameMissingReported = false;

function desktopUser(): string {
  try {
    return userInfo().username;
  } catch (error) {
    // A user with no passwd entry (some containers) has no name to give.
    if (!userNameMissingReported) {
      userNameMissingReported = true;
      log.warn('console-identity: could not read the desktop user name', { error });
    }
    return 'unknown';
  }
}

/** The name this Console shows to others: `user@host`, reduced to what the
 * server will keep. Read fresh, since a renamed machine should say so. */
export function consoleName(): string {
  return `${namePart(desktopUser())}@${namePart(hostname())}`.slice(0, MAX_NAME_LENGTH);
}

export async function getConsoleIdentity(): Promise<ConsoleIdentity> {
  return { id: await consoleId(), name: consoleName() };
}

/**
 * The headers that identify this Console to `server`, or none. Only a managed
 * server is told: that is where people share one sign-in. An id that cannot be
 * read is logged and sends no headers rather than failing the call.
 */
export async function consoleIdentityHeaders(
  server: Pick<SwitchServer, 'managed'>
): Promise<Record<string, string>> {
  if (!server.managed) return {};
  try {
    const identity = await getConsoleIdentity();
    return { [CONSOLE_ID_HEADER]: identity.id, [CONSOLE_NAME_HEADER]: identity.name };
  } catch (error) {
    log.warn(
      "console-identity: could not read this Console's id, so the server will not be told " +
        'which Console this request is from',
      { error }
    );
    return {};
  }
}

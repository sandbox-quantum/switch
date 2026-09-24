import { resolveAppVersion } from '@main/core/app/utils';
import { getConsoleIdentity } from '@main/core/switch-servers/console-identity';
import { log } from '@main/lib/logger';
import type {
  StackActivityAction,
  StackActivityEntry,
  StackConsole,
  StackRegister,
} from '@shared/core/managed-switch-server/managed-switch-server';
import {
  listProjectResources,
  readStateVolume,
  type StackStateHost,
  writeStateVolume,
} from './stack-state';

/**
 * Who uses a shared remote stack, and what they last did to it — kept on the
 * stack's host, in its state volume, beside the settings (CHOO-2893).
 *
 * Everyone sharing the stack signs in as its one admin account, so nothing on
 * the server can say whether it was you or a colleague who stopped it an hour
 * ago. Each Console records itself here instead: a register of the Consoles
 * that use the stack (`consoles/<id>.json`, one per Console, rewritten each
 * time it is seen) and a log of what they did (`activity.jsonl`, appended).
 * It is what the server page lists as the Consoles using the server, and what
 * a Stop or a Reset names as the people it will affect.
 *
 * Readable by every account that can reach the host's Docker daemon, which is
 * the set of people who can run the stack at all. It is a record for them, not
 * a control: nothing is allowed or refused on the strength of it, and a
 * Console that fails to write it still does what it was asked.
 */

/** Only the latest entries are read back; the file keeps a few hundred. */
const ACTIVITY_SHOWN = 50;
const ACTIVITY_TRIM_AT = 1000;
const ACTIVITY_KEPT = 500;

/** Separates the two halves of a read, which come back as one stdout. */
const ACTIVITY_MARKER = '---switch-console-activity---';

/** A Console id is our own random UUID. It is also a file name inside the
 * volume, so anything else is refused rather than written. */
const CONSOLE_ID = /^[0-9A-Fa-f-]{1,64}$/;

/**
 * How a record touches the register: `seen` refreshes this Console's entry,
 * `act` refreshes it and adds a line of activity, and `leave` adds the line and
 * takes the entry out — a Console that has disconnected no longer uses the
 * stack, and must not go on being named to everyone else as if it did.
 */
type RecordMode = 'seen' | 'act' | 'leave';

function recordModeFor(action: StackActivityAction | null): RecordMode {
  if (action === null) return 'seen';
  return action === 'disconnected' ? 'leave' : 'act';
}

/**
 * Applies a {@link RecordMode} (`$2`) for the Console `$1`. The entry and the
 * activity line are read from stdin, so no value is spliced into the script
 * and none has to be quoted. The activity file is trimmed once it doubles past
 * what is kept. Exported for the test that runs it against a real directory.
 */
export const RECORD_SCRIPT = [
  'umask 077',
  'mkdir -p /state/consoles',
  'IFS= read -r entry || exit 1',
  'if [ "$2" = leave ]; then',
  '  rm -f "/state/consoles/$1.json"',
  'else',
  '  printf "%s\\n" "$entry" > "/state/consoles/.$1.tmp"',
  '  mv "/state/consoles/.$1.tmp" "/state/consoles/$1.json"',
  'fi',
  'if [ "$2" != seen ]; then',
  '  IFS= read -r activity || exit 1',
  '  printf "%s\\n" "$activity" >> /state/activity.jsonl',
  `  if [ "$(wc -l < /state/activity.jsonl)" -gt ${ACTIVITY_TRIM_AT} ]; then`,
  `    tail -n ${ACTIVITY_KEPT} /state/activity.jsonl > /state/.activity.tmp`,
  '    mv /state/.activity.tmp /state/activity.jsonl',
  '  fi',
  'fi',
].join('\n');

const READ_SCRIPT = [
  'for f in /state/consoles/*.json; do [ -f "$f" ] && cat "$f"; done',
  `echo '${ACTIVITY_MARKER}'`,
  `tail -n ${ACTIVITY_SHOWN} /state/activity.jsonl 2>/dev/null || true`,
].join('\n');

const ACTIONS: readonly StackActivityAction[] = [
  'started',
  'connected',
  'stopped',
  'reset',
  'disconnected',
];

/** The account each host connection logs in as. It cannot change for the life
 * of a connection, so it is asked once rather than on every record. */
const accounts = new WeakMap<StackStateHost, Promise<string>>();

function hostAccount(host: StackStateHost): Promise<string> {
  let account = accounts.get(host);
  if (!account) {
    account = host.ctx
      .exec('id', ['-un'], { timeout: 20_000 })
      .then(({ stdout }) => stdout.trim() || 'unknown');
    // A failed ask is not remembered: the next record asks again.
    account.catch(() => accounts.delete(host));
    accounts.set(host, account);
  }
  return account;
}

/**
 * Record this Console on the stack's host: refresh its register entry and,
 * for anything but a quiet sighting (`action` null), add a line of activity.
 * A disconnect adds its line and takes the entry out instead of refreshing it.
 * Throws on failure: the supervisor decides what a failed record means for
 * the operation it describes.
 */
export async function writeRecord(
  host: StackStateHost,
  action: StackActivityAction | null
): Promise<void> {
  const identity = await getConsoleIdentity();
  if (!CONSOLE_ID.test(identity.id)) {
    throw new Error(`Refusing to record a console id that is not one: ${identity.id}`);
  }
  const at = new Date().toISOString();
  const account = await hostAccount(host);
  const entry: StackConsole = {
    consoleId: identity.id,
    name: identity.name,
    hostAccount: account,
    appVersion: await resolveAppVersion(),
    lastSeenAt: at,
  };
  const lines = [JSON.stringify(entry)];
  if (action !== null) {
    const activity: StackActivityEntry = {
      at,
      action,
      consoleId: identity.id,
      name: identity.name,
      hostAccount: account,
    };
    lines.push(JSON.stringify(activity));
  }
  await writeStateVolume(host, RECORD_SCRIPT, `${lines.join('\n')}\n`, [
    identity.id,
    recordModeFor(action),
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asConsole(value: unknown): StackConsole | null {
  if (!isRecord(value)) return null;
  const { consoleId, name, hostAccount, appVersion, lastSeenAt } = value;
  if (
    typeof consoleId !== 'string' ||
    typeof name !== 'string' ||
    typeof hostAccount !== 'string' ||
    typeof appVersion !== 'string' ||
    typeof lastSeenAt !== 'string'
  )
    return null;
  return { consoleId, name, hostAccount, appVersion, lastSeenAt };
}

function asActivity(value: unknown): StackActivityEntry | null {
  if (!isRecord(value)) return null;
  const { at, action, consoleId, name, hostAccount } = value;
  if (
    typeof at !== 'string' ||
    typeof action !== 'string' ||
    !(ACTIONS as readonly string[]).includes(action) ||
    typeof consoleId !== 'string' ||
    typeof name !== 'string' ||
    typeof hostAccount !== 'string'
  )
    return null;
  return { at, action: action as StackActivityAction, consoleId, name, hostAccount };
}

function parseLines<T>(
  text: string,
  as: (value: unknown) => T | null
): { items: T[]; bad: number } {
  const items: T[] = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      bad++;
      continue;
    }
    const item = as(parsed);
    if (item === null) bad++;
    else items.push(item);
  }
  return { items, bad };
}

/**
 * The register and recent activity for the stack on `host`, newest first.
 * Empty — not an error — on a host whose stack has no state volume yet.
 * Lines that do not parse are skipped and counted in the log rather than
 * failing the read: one Console's bad write must not hide everyone else.
 */
export async function readRegister(host: StackStateHost): Promise<StackRegister> {
  const self = (await getConsoleIdentity()).id;
  const { stateVolume } = await listProjectResources(host);
  if (!stateVolume) return { self, consoles: [], activity: [] };

  const out = await readStateVolume(host, READ_SCRIPT);
  const split = out.indexOf(ACTIVITY_MARKER);
  const consolesText = split === -1 ? out : out.slice(0, split);
  const activityText = split === -1 ? '' : out.slice(split + ACTIVITY_MARKER.length);

  const consoles = parseLines(consolesText, asConsole);
  const activity = parseLines(activityText, asActivity);
  if (consoles.bad + activity.bad > 0) {
    log.warn(`remote-switch-server: skipped unreadable register lines on ${host.label}`, {
      consoles: consoles.bad,
      activity: activity.bad,
    });
  }
  return {
    self,
    consoles: consoles.items.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
    activity: activity.items.reverse(),
  };
}

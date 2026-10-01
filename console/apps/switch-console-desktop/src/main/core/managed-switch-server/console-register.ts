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
  readStateVolume,
  type StackStateHost,
  stateVolumeExists,
  writeStateVolume,
} from './stack-state';
import { CONSOLE_ID_PATTERN, UNDER_STATE_MUTEX } from './state-mutex';

/**
 * Who uses a shared remote stack and what they last did to it, kept in its
 * state volume (CHOO-2893). Everyone signs in to the server as its one admin,
 * so the server cannot say who stopped it; each Console records itself in
 * `consoles/<id>.json` and an appended `activity.jsonl` instead. It is a
 * record, not a control: nothing is allowed or refused on its strength, and a
 * Console that fails to write it still does what it was asked.
 */

/** Only the latest entries are read back; the file keeps a few hundred. */
const ACTIVITY_SHOWN = 50;
const ACTIVITY_TRIM_AT = 1000;
const ACTIVITY_KEPT = 500;

/** Separates the two halves of a read, which come back as one stdout. */
const ACTIVITY_MARKER = '---switch-console-activity---';

/** `seen` refreshes this Console's entry, `act` also adds an activity line,
 * and `leave` adds the line and removes the entry, so a disconnected Console
 * is no longer named as using the stack. */
type RecordMode = 'seen' | 'act' | 'leave';

function recordModeFor(action: StackActivityAction | null): RecordMode {
  if (action === null) return 'seen';
  return action === 'disconnected' ? 'leave' : 'act';
}

/** Applies a {@link RecordMode} (`$2`) for the Console `$1`, reading the entry
 * and activity line from stdin so no value is spliced into the script. */
export const RECORD_SCRIPT = [
  'set -e',
  UNDER_STATE_MUTEX,
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

/** By host label. An SSH alias always logs in as one account, so it is asked
 * once per run rather than per operation. */
const accounts = new Map<string, Promise<string>>();

export function hostAccount(host: StackStateHost): Promise<string> {
  let account = accounts.get(host.label);
  if (!account) {
    account = host.ctx
      .exec('id', ['-un'], { timeout: 20_000 })
      .then(({ stdout }) => stdout.trim() || 'unknown');
    // A failed ask is not remembered: the next record asks again.
    account.catch(() => accounts.delete(host.label));
    accounts.set(host.label, account);
  }
  return account;
}

/** `action` null is a quiet sighting that only refreshes the entry. Throws on
 * failure: the supervisor decides what a failed record means for its operation. */
export async function writeRecord(
  host: StackStateHost,
  action: StackActivityAction | null
): Promise<void> {
  const identity = await getConsoleIdentity();
  if (!CONSOLE_ID_PATTERN.test(identity.id)) {
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

/** Newest first; empty on a host with no state volume yet. Unparseable lines
 * are skipped and logged: one Console's bad write must not hide everyone else. */
export async function readRegister(host: StackStateHost): Promise<StackRegister> {
  const self = (await getConsoleIdentity()).id;
  if (!(await stateVolumeExists(host))) return { self, consoles: [], activity: [] };

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

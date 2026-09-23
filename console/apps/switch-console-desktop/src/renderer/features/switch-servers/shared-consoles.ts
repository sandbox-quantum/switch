import { formatDistanceStrict } from 'date-fns';
import type {
  StackActivityAction,
  StackActivityEntry,
  StackConsole,
  StackRegister,
} from '@shared/core/managed-switch-server/managed-switch-server';

/**
 * How the people sharing a remote server are described (CHOO-2893). One place,
 * so the server page, Stop, Reset and Delete name them the same way.
 */

/** How long a Console counts as still using the server after it was last seen:
 * long enough to span a holiday, short enough that someone who tried it once
 * in the spring is not warned about in the autumn. */
export const RECENTLY_SEEN_DAYS = 14;

/** The other Consoles seen on the server recently, most recent first — the
 * people a stop, restart or reset from here will affect. */
export function othersRecentlySeen(
  register: StackRegister | null,
  now: Date,
  withinDays: number = RECENTLY_SEEN_DAYS
): StackConsole[] {
  if (!register) return [];
  const cutoff = now.getTime() - withinDays * 24 * 60 * 60 * 1000;
  return register.consoles.filter((c) => {
    if (c.consoleId === register.self) return false;
    const seen = Date.parse(c.lastSeenAt);
    return Number.isFinite(seen) && seen >= cutoff;
  });
}

/** `bob@desk (as bob)` — the desktop, and the account it reaches the host as. */
export function describeConsole(console: Pick<StackConsole, 'name' | 'hostAccount'>): string {
  return `${console.name} (as ${console.hostAccount})`;
}

/** This Console's own entry, when it has recorded one. */
export function selfEntry(register: StackRegister | null): StackConsole | null {
  return register?.consoles.find((c) => c.consoleId === register.self) ?? null;
}

function names(consoles: StackConsole[]): string {
  const [first, second, ...rest] = consoles.map((c) => c.name);
  if (!second) return first ?? '';
  if (rest.length === 0) return `${first} and ${second}`;
  return `${first}, ${second} and ${rest.length} other${rest.length === 1 ? '' : 's'}`;
}

/**
 * The line under the server's controls saying it is shared, or null when
 * nobody else has used it recently.
 */
export function sharedWithSentence(others: StackConsole[]): string | null {
  if (others.length === 0) return null;
  return `Shared with ${names(others)}. Stopping or restarting it affects them too.`;
}

/**
 * Who a destructive action will reach, for its confirmation — each other
 * Console with when it was last seen. Null when nobody else has used it.
 */
export function affectedSentence(others: StackConsole[], now: Date): string | null {
  if (others.length === 0) return null;
  const who = others
    .slice(0, 3)
    .map((c) => `${describeConsole(c)}, ${formatDistanceStrict(new Date(c.lastSeenAt), now)} ago`)
    .join('; ');
  const more = others.length > 3 ? `; and ${others.length - 3} more` : '';
  return `Also used recently by ${who}${more}.`;
}

const ACTION_WORDS: Record<StackActivityAction, string> = {
  started: 'started it',
  connected: 'connected',
  stopped: 'stopped it',
  reset: 'reset it',
  disconnected: 'disconnected',
};

/** `bob@desk stopped it` — one line of the server's activity. */
export function activitySentence(entry: StackActivityEntry, self: string): string {
  const who = entry.consoleId === self ? 'This Console' : entry.name;
  return `${who} ${ACTION_WORDS[entry.action]}`;
}

import { formatDistanceStrict } from 'date-fns';
import type {
  StackActivityAction,
  StackActivityEntry,
  StackConsole,
} from '@shared/core/managed-switch-server/managed-switch-server';

/**
 * How the people sharing a remote server are described (CHOO-2893). One place,
 * so the server page, Stop, Reset and Delete name them the same way.
 */

/** `bob@desk (as bob)` — the desktop, and the account it reaches the host as. */
export function describeConsole(console: Pick<StackConsole, 'name' | 'hostAccount'>): string {
  return `${console.name} (as ${console.hostAccount})`;
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

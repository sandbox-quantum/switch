import { formatDistanceStrict } from 'date-fns';
import {
  othersRecentlySeen,
  type StackActivityAction,
  type StackActivityEntry,
  type StackConsole,
  type StackRegister,
} from '@shared/core/managed-switch-server/managed-switch-server';

/**
 * How the people sharing a remote server are described (CHOO-2893). One place,
 * so the server page, Stop, Reset and Delete name them the same way.
 */

/** `bob@desk (as bob)` — the desktop, and the account it reaches the host as. */
export function describeConsole(console: Pick<StackConsole, 'name' | 'hostAccount'>): string {
  return `${console.name} (as ${console.hostAccount})`;
}

function names(first: StackConsole, rest: StackConsole[]): string {
  const [second, ...more] = rest;
  if (!second) return first.name;
  if (more.length === 0) return `${first.name} and ${second.name}`;
  return `${first.name}, ${second.name} and ${more.length} other${more.length === 1 ? '' : 's'}`;
}

/**
 * The line under the server's controls saying it is shared, or null when
 * nobody else has used it recently.
 */
export function sharedWithSentence(others: StackConsole[]): string | null {
  const [first, ...rest] = others;
  if (!first) return null;
  return `Shared with ${names(first, rest)}. Stopping or restarting it affects them too.`;
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

/**
 * Whether an action on a shared server reaches anyone else: others have used
 * it lately, or who uses it has not been read — which counts as others, as it
 * does in the main process.
 */
export function sharedWithOthers(register: StackRegister | null, now: Date): boolean {
  return register === null || othersRecentlySeen(register, now).length > 0;
}

/**
 * Who else an action on a shared server reaches, or that it could not be told.
 * Null when nobody else uses it.
 */
export function whoElseSentence(register: StackRegister | null, now: Date): string | null {
  if (register === null) return 'Switch Console could not check who else uses it.';
  return affectedSentence(othersRecentlySeen(register, now), now);
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

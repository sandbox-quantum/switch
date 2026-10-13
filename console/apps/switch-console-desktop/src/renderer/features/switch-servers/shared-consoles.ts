import { formatDistanceStrict } from 'date-fns';
import {
  othersRecentlySeen,
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

/**
 * This Console's own desktop name on the register, or null before it has
 * recorded itself. Another Console with the same name is another profile on
 * this very computer, such as the Canary build.
 */
export function selfDesktop(register: StackRegister | null): string | null {
  if (!register) return null;
  return register.consoles.find((c) => c.consoleId === register.self)?.name ?? null;
}

function nameOf(console: StackConsole, self: string | null): string {
  return self !== null && console.name === self ? 'another Console on this computer' : console.name;
}

/** `bob@desk`, `bob@desk and carol@lab`, `bob@desk, carol@lab and 2 others`. */
export function namesOf(others: StackConsole[], self: string | null): string {
  const unique = [...new Set(others.map((c) => nameOf(c, self)))];
  const [first, second, ...more] = unique;
  if (!first) return '';
  if (!second) return first;
  if (more.length === 0) return `${first} and ${second}`;
  return `${first}, ${second} and ${more.length} other${more.length === 1 ? '' : 's'}`;
}

/**
 * The line under the server's controls saying it is shared, or null when
 * nobody else has used it recently.
 */
export function sharedWithSentence(others: StackConsole[], self: string | null): string | null {
  if (others.length === 0) return null;
  return `Shared with ${namesOf(others, self)}. Stopping or restarting it affects them too.`;
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

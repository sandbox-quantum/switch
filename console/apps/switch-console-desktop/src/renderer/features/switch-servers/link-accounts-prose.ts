import type { LinkRequestFailure } from '@shared/core/switch-servers/switch-servers';

/**
 * What linking is for, said where someone is deciding whether to bother.
 *
 * Not "the app is read-only until you do" — an unlinked account costs nothing
 * until an agent is restricted to its owner, and overstating it here is the one
 * claim on this screen a user could catch us in.
 */
export const LINK_ACCOUNTS_LATER =
  'You can link the rest later from the server’s page. Until you do, agents set to answer only their owner will not recognise you in that app.';

/** Small counts read better as words in a sentence; past that the numeral wins. */
export function spellCount(n: number): string {
  const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  return words[n] ?? String(n);
}

/** "Pilot has three messaging apps connected." */
export function connectedAppsSummary(serverName: string, count: number): string {
  if (count === 0) return `${serverName} has no messaging apps connected yet.`;
  return `${serverName} has ${spellCount(count)} messaging app${count === 1 ? '' : 's'} connected.`;
}

/** A platform username as a handle. Platforms differ on whether the username
 * they report already carries the sigil, so add one only when it is missing. */
export function accountHandle(username: string): string {
  return username.startsWith('@') ? username : `@${username}`;
}

/** A request about a waiting confirmation that did nothing, said so the user
 * can act on it. */
export function linkRequestFailureText(failure: LinkRequestFailure): string {
  switch (failure.kind) {
    case 'unauthenticated':
      return 'Your session for this server expired. Sign in again, then retry.';
    case 'refused':
    case 'error':
      return failure.message;
  }
}

import { failureText } from './describe-failure';

/**
 * The same failure is offered from three menus — the agent's page header, the
 * sidebar entry, and the Your Agents card — so the wording lives here rather
 * than in three places that would drift apart.
 *
 * All three report it through a promise toast, which takes one string, so the
 * detail rides in a parenthetical rather than a description slot.
 */
export function resetAgentErrorText(error: unknown): string {
  return failureText(error, 'Could not reset the agent.');
}

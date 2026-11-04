import { flagsAddWithoutAsking } from '@shared/core/feature-flags/ask-first';
import type { ServerFeatureFlags } from '@shared/core/feature-flags/feature-flags';
import type { MachineHealth } from './agent-migration-service';

/**
 * Why the automatic move leaves an agent where it is on a server running
 * hosted agents v2: there, a machine is added only when its owner says so
 * (B38), from Add agent's own button, never by a background pass.
 */
export const ASK_FIRST_REASON =
  'On this server a machine is added only when you choose to: turn it on from Add agent, and its agents move after that.';

/**
 * Whether the automatic move asks first, from the server's flags as last read
 * (null: no such server). It fails closed: only a good read that says hosted
 * agents v2 is off repairs as upstream (`flagsAddWithoutAsking`); unread, a
 * failed read, v2 on, or no server all ask first.
 */
export function asksFirstFrom(
  state: Pick<ServerFeatureFlags, 'fetchedAt' | 'error' | 'flags'> | null
): boolean {
  return state === null || !flagsAddWithoutAsking(state);
}

/**
 * The automatic move's machine repair, asking first on hosted agents v2.
 *
 * With v2 off it is upstream's repair exactly (`heal(true)`): a machine Switch
 * removed is enrolled again, and one never set up comes back `not-set-up` so
 * the move turns it on. With v2 on it repairs without enrolling again
 * (`heal(false)`), and a machine not set up is left alone: both come back
 * `incompatible` with the reason above, so nothing is added without a click.
 */
export async function healAskingFirst(
  asksFirst: () => Promise<boolean>,
  heal: (mayEnrolAgain: boolean) => Promise<MachineHealth>
): Promise<MachineHealth> {
  if (!(await asksFirst())) return heal(true);
  const healed = await heal(false);
  return healed.kind === 'not-set-up' ? { kind: 'incompatible', reason: ASK_FIRST_REASON } : healed;
}

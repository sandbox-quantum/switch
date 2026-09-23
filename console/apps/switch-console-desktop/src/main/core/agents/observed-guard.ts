import { assertRunsHere } from '@main/core/locations/store';
import type { Agent } from '@shared/core/agents/agents';
import type { Location } from '@shared/core/locations/locations';
import { getAgentLocation } from './agent-location';

/**
 * The agent's location, when this Console runs the agent there; throws
 * `ObservedLocationError` for an agent another account runs, which this
 * Console only observes (CHOO-2893).
 *
 * What the paths a person asks for — start a session, change a setting,
 * restart the host — call before touching the agent's host, so they refuse
 * loudly. Paths that only maintain an agent on its host (its watcher, a storage
 * migration, a config sync) skip an observed one quietly instead, since its
 * owner's Console does that. Both come down to `assertRunsHere`, so the rule
 * reads the same everywhere.
 */
export async function locationWhereAgentRuns(
  agent: Pick<Agent, 'id' | 'locationId'>
): Promise<Location> {
  const location = await getAgentLocation(agent);
  assertRunsHere(location);
  return location;
}

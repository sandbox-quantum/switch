import { ObservedLocationError } from '@main/core/locations/store';
import type { Agent } from '@shared/core/agents/agents';
import type { Location } from '@shared/core/locations/locations';
import { getAgentLocation } from './agent-location';

/**
 * The one check every host-bound path makes before touching an agent's working
 * directory or running anything for it (CHOO-2893): is this an agent another
 * account runs, which this Console only observes?
 *
 * Kept as a single pair of functions so the rule reads the same everywhere:
 * paths that only *maintain* the agent on its host (its watcher, a storage
 * migration, a config sync) skip an observed one quietly — its owner's Console
 * does that — and paths a person asked for (start a session, change a setting,
 * restart the host) refuse loudly with {@link ObservedLocationError}.
 */

export async function isObservedAgent(agent: Pick<Agent, 'id' | 'locationId'>): Promise<boolean> {
  return (await getAgentLocation(agent)).observed;
}

/** The agent's location, when this Console runs the agent there; throws
 * {@link ObservedLocationError} for one it only observes. */
export async function locationWhereAgentRuns(
  agent: Pick<Agent, 'id' | 'locationId'>
): Promise<Location> {
  const location = await getAgentLocation(agent);
  if (location.observed) throw new ObservedLocationError(location);
  return location;
}

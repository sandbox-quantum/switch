import { getLocationById } from '@main/core/locations/store';
import type { Agent } from '@shared/core/agents/agents';
import type { Location } from '@shared/core/locations/locations';

/** Resolve an agent's location, failing loud when the row is missing. */
export async function getAgentLocation(agent: Pick<Agent, 'id' | 'locationId'>): Promise<Location> {
  const location = await getLocationById(agent.locationId);
  if (!location) {
    throw new Error(`Location ${agent.locationId} not found for agent ${agent.id}`);
  }
  return location;
}

/** The agent's location when it is remote (on an SSH host), else null. */
export async function getRemoteAgentLocation(
  agent: Pick<Agent, 'id' | 'locationId'>
): Promise<(Location & { sshHost: string }) | null> {
  const location = await getAgentLocation(agent);
  if (location.sshHost === null) return null;
  return { ...location, sshHost: location.sshHost };
}

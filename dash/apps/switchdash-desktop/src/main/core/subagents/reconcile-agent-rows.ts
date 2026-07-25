import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { createAgent } from '@main/core/agents/createAgent';
import { getAgents } from '@main/core/agents/getAgents';
import { getLocationById } from '@main/core/locations/store';
import { createPluginFs } from '@main/core/providers/plugin-fs';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { log } from '@main/lib/logger';

/**
 * Sync a location's on-disk subagent definitions into first-class agent rows.
 *
 * In the collapsed model a subagent is just an agent that launches as a provider
 * definition (its `definitionName`), sharing a location with the other agents.
 * So the only subagent-specific bookkeeping left is keeping the `agents` table in
 * step with the provider's on-disk, credentialed definitions. This is that step,
 * and it doubles as the backfill for existing installs (CHOO-1440).
 *
 * For each real agent in the location (one with no `definitionName`) whose
 * provider supports subagents and that is linked to a server, discover the
 * launchable subagents in the location dir and create an agent row for any not
 * already represented — matched by `definitionName`, or by `switchAgentId` when
 * present. The new row inherits the parent's provider and server (subagents are
 * registered as children on the same server) and its own Switch identity from the
 * discovered credentials. Idempotent; best-effort per parent.
 *
 * Local locations only: a remote location's working dir lives on its SSH host, so
 * its subagents are materialised through the remote onboarding path, not here.
 */
export async function reconcileAgentRowsForLocation(
  locationId: string
): Promise<{ created: number }> {
  const location = await getLocationById(locationId);
  if (!location || location.sshHost) return { created: 0 };

  const agentsInLocation = await getAgents(locationId);
  const seenDefinitionNames = new Set(
    agentsInLocation
      .map((a) => a.definitionName)
      .filter((name): name is string => name !== null)
  );
  const seenSwitchIds = new Set(
    agentsInLocation.map((a) => a.switchAgentId).filter((id): id is string => id !== null)
  );

  const parents = agentsInLocation.filter(
    (a) => a.definitionName === null && a.serverId !== null && !!getPlugin(a.providerId).behavior.subagents
  );

  const fs = createPluginFs(location.dir);
  const homeFs = createPluginFs(homedir());
  let created = 0;

  for (const parent of parents) {
    const behavior = getPlugin(parent.providerId).behavior.subagents;
    if (!behavior || parent.serverId === null) continue;
    let discovered;
    try {
      discovered = await behavior.discoverLocal(fs, homeFs);
    } catch (error) {
      log.warn('reconcileAgentRows: local discovery failed', {
        locationId,
        parentAgentId: parent.id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    for (const sub of discovered) {
      if (seenDefinitionNames.has(sub.name)) continue;
      if (sub.switchAgentId !== null && seenSwitchIds.has(sub.switchAgentId)) continue;

      await createAgent({
        id: randomUUID(),
        locationId,
        name: sub.name,
        providerId: parent.providerId,
        definitionName: sub.name,
        switchAgentId: sub.switchAgentId,
        apiEndpoint: sub.apiEndpoint,
        serverId: parent.serverId,
        autoApprove: false,
      });
      seenDefinitionNames.add(sub.name);
      if (sub.switchAgentId !== null) seenSwitchIds.add(sub.switchAgentId);
      created++;
    }
  }

  return { created };
}

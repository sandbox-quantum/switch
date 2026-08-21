import { randomUUID } from 'node:crypto';
import { err, ok } from '@switch-console/shared';
import type { Result } from '@switch-console/shared';
import { locationManager } from '@main/core/locations/location-manager';
import { checkIsValidDirectory } from '@main/core/locations/path-utils';
import { ensureLocation } from '@main/core/locations/store';
import { agentExistsOnServer, GatewayError } from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import type { OnboardAgentError } from '@shared/core/agents/onboarding';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { sameApiEndpoint } from '@shared/core/switch-servers/switch-servers';
import { basenameFromAnyPath } from '@shared/path-name';
import { agentEvents } from './agent-events';
import { createAgent } from './createAgent';
import { discoverConfiguredAgents } from './discover-configured-agents';
import { reconcileAgentAutoSessionFromGateway } from './setAgentAutoSession';

export type AttachConfiguredAgentsParams = {
  sshHost: string | null;
  dir: string;
  locationName?: string;
  /** The registered Switch server the discovered identities are verified against. */
  serverId: string;
  /**
   * The agents to attach. `providerId` is supplied by the caller rather than
   * taken from the scan: discovery infers it best-effort and reports `null` when
   * the directory names none, in which case the user picks.
   */
  agents: Array<{ name: string; providerId: AgentProviderId }>;
};

export type AttachConfiguredAgentsResult = Result<Agent[], OnboardAgentError>;

/**
 * Adopt agents already configured in a working directory into this Switch Console,
 * under the Switch identity they already have (CHOO-1937).
 *
 * This is the second half of shared-host onboarding: another install (or another
 * person) set the agent up here, and this one attaches to it rather than
 * creating a duplicate. The identity is read back from disk at attach time
 * rather than trusted from the caller, so a stale scan cannot mint a row
 * pointing at the wrong agent.
 *
 * **Writes nothing to the working directory.** No credentials, no definition, no
 * provider config — the directory is another install's state and this operation
 * treats it as read-only. That is possible because the API token is never needed
 * here: it stays where it already is, and the launch path reads it from disk when
 * a session spawns. This module deliberately imports no workspace writer, so the
 * guarantee is structural rather than a matter of care.
 *
 * An identity that no longer exists on the chosen server fails the attach loudly
 * instead of falling back to minting a fresh one — a silent mint is exactly the
 * duplicate this feature exists to prevent.
 */
export async function attachConfiguredAgents(
  params: AttachConfiguredAgentsParams
): Promise<AttachConfiguredAgentsResult> {
  if (params.sshHost === null && !checkIsValidDirectory(params.dir)) {
    return err({ type: 'invalid-directory', dir: params.dir, message: 'Invalid directory' });
  }
  if (params.agents.length === 0) {
    return err({
      type: 'invalid-directory',
      dir: params.dir,
      message: 'No agents selected to attach.',
    });
  }

  const server = await getServer(params.serverId);
  if (!server) throw new Error(`No Switch server with id ${params.serverId}`);

  const discovered = new Map(
    (
      await discoverConfiguredAgents({
        sshHost: params.sshHost,
        dir: params.dir,
        serverId: params.serverId,
      })
    ).map((d) => [d.name, d])
  );

  const selected: Array<{ name: string; providerId: AgentProviderId }> = [];
  for (const requested of params.agents) {
    const found = discovered.get(requested.name);
    if (!found) {
      return err({
        type: 'invalid-directory',
        dir: params.dir,
        message: `No configured agent named "${requested.name}" in this directory. It may have been removed since the directory was scanned.`,
      });
    }
    // Already attached here — the scan marks these, so re-selecting one is a
    // stale-UI artefact rather than an error worth failing the whole batch for.
    if (!found.alreadyAgent) selected.push(requested);
  }
  if (selected.length === 0) {
    return err({
      type: 'invalid-directory',
      dir: params.dir,
      message: `Every selected agent is already attached to ${server.name} here.`,
    });
  }

  const location = await ensureLocation({
    sshHost: params.sshHost,
    dir: params.dir,
    name: params.locationName ?? basenameFromAnyPath(params.dir) ?? params.dir,
  });

  const created: Agent[] = [];
  for (const { name, providerId } of selected) {
    const found = discovered.get(name);
    if (!found) continue;

    try {
      if (!(await agentExistsOnServer(server, found.switchAgentId))) {
        return err({
          type: 'switch-agent-not-on-server',
          dir: params.dir,
          serverId: server.id,
          serverName: server.name,
          agentId: found.switchAgentId,
        });
      }
    } catch (cause) {
      if (cause instanceof GatewayError && cause.kind === 'unauthorized') {
        return err({
          type: 'switch-server-unauthenticated',
          dir: params.dir,
          serverId: server.id,
          serverName: server.name,
        });
      }
      throw cause;
    }

    // The directory's endpoint wins over the chosen server's URL: it is what the
    // launch path will actually hand the session, since the token and endpoint
    // are read from the same on-disk file. A difference is legitimate (one Switch
    // server reachable at two URLs) so it is surfaced, not corrected — correcting
    // it would mean writing to another install's credentials.
    if (!sameApiEndpoint(found.apiEndpoint, server.apiUrl)) {
      log.warn('attachConfiguredAgents: directory endpoint differs from the chosen server', {
        name,
        dirEndpoint: found.apiEndpoint,
        serverEndpoint: server.apiUrl,
        serverId: server.id,
      });
    }

    const agent = await createAgent({
      id: randomUUID(),
      locationId: location.id,
      name,
      providerId,
      switchAgentId: found.switchAgentId,
      apiEndpoint: found.apiEndpoint,
      serverId: params.serverId,
      autoApprove: params.sshHost !== null,
    });
    created.push(agent);

    await reconcileAgentAutoSessionFromGateway(agent.id).catch((error) => {
      log.warn('attachConfiguredAgents: failed to reconcile auto_session', {
        agentId: agent.id,
        error: String(error),
      });
    });
  }

  await locationManager.openLocation(location);
  for (const agent of created) agentEvents._emit('agent:created', agent, 'onboarding');
  return ok(created);
}

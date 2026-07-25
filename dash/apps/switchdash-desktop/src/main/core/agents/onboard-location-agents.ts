import { randomUUID } from 'node:crypto';
import { err, ok } from '@switchdash/shared';
import type { Result } from '@switchdash/shared';
import { locationManager } from '@main/core/locations/location-manager';
import { checkIsValidDirectory } from '@main/core/locations/path-utils';
import { ensureLocation } from '@main/core/locations/store';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { agentExistsOnServer, GatewayError } from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import type { OnboardAgentError } from '@shared/core/agents/onboarding';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { basenameFromAnyPath } from '@shared/path-name';
import { agentEvents } from './agent-events';
import { resolveWorkspaceFsFor } from './agent-workspace-fs';
import { createAgent } from './createAgent';
import { getAgents } from './getAgents';
import { reconcileAgentAutoSessionFromGateway } from './setAgentAutoSession';

export type OnboardLocationParams = {
  sshHost: string | null;
  dir: string;
  locationName?: string;
  providerId: AgentProviderId;
  /** The registered Switch server the discovered agents must belong to. */
  serverId: string;
};

export type OnboardLocationResult = Result<Agent[], OnboardAgentError>;

/**
 * Onboard every agent already defined in a working directory: scan the
 * provider's on-disk definitions (`.claude/agents/*.md`) plus their Switch
 * credentials, verify each identity on the chosen server, and create one flat
 * agent row per definition. There is no "main" agent — switchdash treats the
 * directory as a flat container of repository-defined agents (CHOO-1440).
 * Local and remote (SSH) directories are both supported.
 */
export async function onboardLocationAgents(
  params: OnboardLocationParams
): Promise<OnboardLocationResult> {
  if (params.sshHost === null && !checkIsValidDirectory(params.dir)) {
    return err({ type: 'invalid-directory', dir: params.dir, message: 'Invalid directory' });
  }

  const server = await getServer(params.serverId);
  if (!server) throw new Error(`No Switch server with id ${params.serverId}`);

  const behavior = getPlugin(params.providerId).behavior.subagents;
  if (!behavior) {
    return err({
      type: 'invalid-directory',
      dir: params.dir,
      message: `Provider ${params.providerId} does not define repository agents.`,
    });
  }

  const workspace = await resolveWorkspaceFsFor(params.sshHost, params.dir);
  let discovered;
  try {
    discovered = await behavior.discoverLocal(workspace.fs, workspace.homeFs);
  } finally {
    workspace.close();
  }

  const registered = discovered.filter((d) => d.switchAgentId !== null);
  if (registered.length === 0) {
    return err({
      type: 'invalid-directory',
      dir: params.dir,
      message:
        'No Switch agents found in this directory. Add an agent here first, then onboard it.',
    });
  }

  const location = await ensureLocation({
    sshHost: params.sshHost,
    dir: params.dir,
    name: params.locationName ?? basenameFromAnyPath(params.dir) ?? params.providerId,
  });

  const existing = new Set(
    (await getAgents(location.id))
      .map((a) => a.definitionName)
      .filter((n): n is string => n != null)
  );

  const created: Agent[] = [];
  for (const sub of registered) {
    if (existing.has(sub.name) || sub.switchAgentId === null) continue;
    try {
      if (!(await agentExistsOnServer(server, sub.switchAgentId))) continue;
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

    const agent = await createAgent({
      id: randomUUID(),
      locationId: location.id,
      name: sub.name,
      providerId: params.providerId,
      definitionName: sub.name,
      switchAgentId: sub.switchAgentId,
      apiEndpoint: sub.apiEndpoint,
      serverId: params.serverId,
      autoApprove: params.sshHost !== null,
    });
    existing.add(sub.name);
    created.push(agent);

    await reconcileAgentAutoSessionFromGateway(agent.id).catch((error) => {
      log.warn('onboardLocationAgents: failed to reconcile auto_session', {
        agentId: agent.id,
        error: String(error),
      });
    });
  }

  if (created.length === 0) {
    return err({
      type: 'invalid-directory',
      dir: params.dir,
      message: 'Every agent in this directory is already onboarded here.',
    });
  }

  await locationManager.openLocation(location);
  for (const agent of created) agentEvents._emit('agent:created', agent);
  return ok(created);
}

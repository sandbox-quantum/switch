import {
  listAutoSessionAgentIds,
  setAutoSessionAgent,
} from '@main/core/switch-rooms/auto-session-store';
import { autoSessionWatcher } from '@main/core/switch-rooms/auto-session-watcher';
import {
  fetchAgentOptions,
  GatewayError,
  setAutoSession,
} from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import { getRemoteAgentLocation } from './agent-location';
import { getAgentById } from './getAgentById';
import { ensureRemoteWatcher } from './remote-watcher';

export type AgentAutoSessionParams = { agentId: string; enabled: boolean };

/**
 * Apply an agent's auto_session state to the LOCAL side only: mirror the flag
 * and tell the agent's controller whether it may start sessions. The controller
 * itself stays up either way — an agent linked to Switch holds its connection
 * because it exists, so turning automatic sessions off leaves it addressable
 * and answering that it has no session. A remote agent's controller runs on its
 * host, so that side is driven over the transport rather than in process. Does
 * NOT touch the gateway profile — callers that also mutate the gateway must do
 * so separately.
 */
async function applyLocalAutoSessionState(agent: Agent, enabled: boolean): Promise<void> {
  await setAutoSessionAgent(agent.id, enabled);
  if ((await getRemoteAgentLocation(agent)) !== null) await ensureRemoteWatcher(agent.id);
  else await autoSessionWatcher.reconcile(agent.id);
}

/**
 * Toggle an agent's auto_session capability. Single write path: flips the
 * gateway profile (`connection_model` ⇄ `auto_session`) via the known-agent
 * options, mirrors the flag locally, and tells the controller whether it may
 * spawn. The local agent must be linked to a Switch server and have a Switch
 * agent id.
 *
 * The two writes are ordered by which half-applied state is honest, because
 * either one can fail and leave the other standing. `auto_session` is the
 * profile on which the server answers an addressed agent with "starting a
 * session", and it grants that on the strength of the profile rather than on
 * what the controller declared — so a profile that says `auto_session` while
 * the controller cannot spawn is a promise nothing will keep. Enabling
 * therefore makes the controller spawn-capable first and claims the profile
 * second; disabling gives the promise up first and stands the controller down
 * second. A failure at either step lands on `session_addressable`, where the
 * server asks the connection instead of the profile.
 */
export async function setAgentAutoSession(params: AgentAutoSessionParams): Promise<void> {
  const agent = await getAgentById(params.agentId);
  if (!agent) throw new Error(`No agent with id ${params.agentId}`);
  if (!agent.serverId || !agent.switchAgentId) {
    throw new Error('Agent is not linked to a Switch server; cannot set auto_session.');
  }
  const server = await getServer(agent.serverId);
  if (!server) throw new Error(`No Switch server with id ${agent.serverId}`);

  if (params.enabled) {
    await applyLocalAutoSessionState(agent, true);
    await setAutoSession(server, agent.switchAgentId, true);
    return;
  }
  await setAutoSession(server, agent.switchAgentId, false);
  await applyLocalAutoSessionState(agent, false);
}

/**
 * Reconcile the local auto_session state (mirror + watcher / watch-enabled
 * marker file) from the gateway profile — the source of truth. Call this right
 * after an agent is created so a fresh agent registered with `auto_session: true`
 * starts watching immediately, without the operator having to toggle it off→on.
 * Returns whether auto_session is enabled. No-ops for agents not linked to a
 * Switch server.
 */
export async function reconcileAgentAutoSessionFromGateway(agentId: string): Promise<boolean> {
  const agent = await getAgentById(agentId);
  if (!agent?.serverId || !agent.switchAgentId) return false;
  const server = await getServer(agent.serverId);
  if (!server) return false;

  const { connectionModel } = await fetchAgentOptions(server, agent.switchAgentId);
  const enabled = connectionModel === 'auto_session';
  await applyLocalAutoSessionState(agent, enabled);
  return enabled;
}

/**
 * Read whether the agent has auto_session enabled, reconciling the local mirror
 * (and the watcher) from the gateway profile — the source of truth. Falls back
 * to the local mirror if the gateway is unreachable / the session is expired,
 * so the UI can still render a value.
 */
export async function getAgentAutoSession(params: { agentId: string }): Promise<boolean> {
  const agent = await getAgentById(params.agentId);
  if (!agent?.serverId || !agent.switchAgentId) return false;

  try {
    return await reconcileAgentAutoSessionFromGateway(params.agentId);
  } catch (error) {
    if (error instanceof GatewayError) {
      log.warn('setAgentAutoSession: could not read gateway profile; using local mirror', {
        agentId: params.agentId,
        error: error.message,
      });
      return (await listAutoSessionAgentIds()).includes(params.agentId);
    }
    throw error;
  }
}

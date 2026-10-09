import type { CloudRelayClient } from '@switch-console/agent-providers';
import { parseControllerAgentKey } from '@shared/core/managed-agents/controller-agent-key';
import {
  cloudControl,
  isCloudAgent,
  relayClientFor,
  requireRegisteredServer,
} from './cloud-control';

/**
 * Console's reach into a managed agent's sessions on any controller, through
 * the Switch server's relay for the agent (`/management/agents/{id}/control`).
 *
 * The relay is the one a cloud agent's sessions use, and it is owner-only on
 * the server. What a controller agent does not get is anything cloud-only:
 * `isCloudAgent` stays false for its key, so no wake, machine or cloud
 * settings path ever takes it, and the Switch Cloud gate does not apply.
 */

export function isControllerAgent(agentId: string): boolean {
  return parseControllerAgentKey(agentId) !== null;
}

/** An agent whose sessions are reached through the relay: a cloud or a controller agent. */
export function isRelayedAgent(agentId: string): boolean {
  return isCloudAgent(agentId) || isControllerAgent(agentId);
}

const clients = new Map<string, CloudRelayClient>();

/** The relay client for a controller agent, made if there is none. */
export async function controllerControl(agentId: string): Promise<CloudRelayClient> {
  const existing = clients.get(agentId);
  if (existing && !existing.isClosed) return existing;
  const target = parseControllerAgentKey(agentId);
  if (!target) throw new Error(`${agentId} is not a controller agent.`);
  await requireRegisteredServer(target.serverId);
  const client = relayClientFor(target);
  client.onClose(() => {
    if (clients.get(agentId) === client) clients.delete(agentId);
  });
  clients.set(agentId, client);
  return client;
}

/** The relay client for a cloud or controller agent. */
export function relayControl(agentId: string): Promise<CloudRelayClient> {
  return isCloudAgent(agentId) ? cloudControl(agentId) : controllerControl(agentId);
}

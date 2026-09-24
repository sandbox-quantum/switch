import type { PlaceOutcome } from '@switch-console/agent-providers';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { getAgentById } from '@main/core/agents/getAgentById';
import { localWatcherControl } from './local-host';
import { sidecarControl } from './sidecar-control';

/**
 * "Reconnect to room": move a room's messages to this session.
 *
 * The agent's room watcher decides where a room's messages go and tells
 * Switch, so the move is asked of it: a direct call for a local agent, whose
 * watcher runs inside Console, and the sidecar's control port for a remote one.
 */
export async function placeSession(
  agentId: string,
  sessionId: string,
  roomId: string
): Promise<PlaceOutcome> {
  const agent = await getAgentById(agentId);
  if (!agent?.switchAgentId) throw new Error('This agent is not linked to Switch.');
  if (!(await getAgentLocation(agent)).sshHost)
    return localWatcherControl(agent.switchAgentId).place(sessionId, roomId);
  return (await sidecarControl(agentId)).place(sessionId, roomId);
}

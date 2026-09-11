import { getAgentById } from '@main/core/agents/getAgentById';
import { fetchSdkSnapshot, GatewayError } from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { stopSharedSession } from './stop-shared-session';

export async function stopSavedSession(sessionId: string, agentId: string): Promise<void> {
  const agent = await getAgentById(agentId);
  if (!agent?.switchAgentId) return;
  if (!agent.serverId)
    throw new Error('Cannot stop this SDK session: its Switch server is missing.');
  const server = await getServer(agent.serverId);
  if (!server) throw new Error('Cannot stop this SDK session: its Switch server is missing.');
  try {
    await fetchSdkSnapshot(server, sessionId);
  } catch (error) {
    if (error instanceof GatewayError && error.status === 404) return;
    throw error;
  }
  await stopSharedSession(server, sessionId);
}

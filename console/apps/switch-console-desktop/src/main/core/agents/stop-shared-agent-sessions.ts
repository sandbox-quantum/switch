import { sessionSchema } from '@switch-console/shared/session-v1';
import { stopSharedSession } from '@main/core/sdk-host/stop-shared-session';
import { fetchSdkSessions } from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import type { Agent } from '@shared/core/agents/agents';

export async function stopSharedAgentSessions(agent: Agent): Promise<void> {
  if (!agent.serverId || !agent.switchAgentId) return;
  const server = await getServer(agent.serverId);
  if (!server) throw new Error('Cannot stop SDK sessions: the Switch server is missing.');
  const sessions = sessionSchema.array().parse(await fetchSdkSessions(server));
  for (const session of sessions.filter(
    (session) =>
      session.agentId === agent.switchAgentId && session.status !== 'stopped' && !session.retired
  ))
    await stopSharedSession(server, session.sessionId);
}

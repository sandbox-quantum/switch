import { listHostSessions } from '@main/core/sdk-host/host-sessions';
import { stopSharedSession } from '@main/core/sdk-host/stop-shared-session';
import type { Agent } from '@shared/core/agents/agents';

export async function stopSharedAgentSessions(agent: Agent): Promise<void> {
  if (!agent.workspaceId || !agent.switchAgentId) return;
  const sessions = await listHostSessions(agent.id);
  for (const session of sessions.filter(
    (session) =>
      session.agentId === agent.switchAgentId && session.status !== 'stopped' && !session.retired
  ))
    await stopSharedSession(agent.id, session.sessionId);
}

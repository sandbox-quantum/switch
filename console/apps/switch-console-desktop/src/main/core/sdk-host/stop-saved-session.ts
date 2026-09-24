import { getAgentById } from '@main/core/agents/getAgentById';
import { stopLocalSession } from './local-host';
import { stopSharedSession } from './stop-shared-session';

export async function stopSavedSession(sessionId: string, agentId: string): Promise<void> {
  try {
    const agent = await getAgentById(agentId);
    if (!agent?.switchAgentId) return;
    await stopSharedSession(agentId, sessionId);
  } finally {
    // A local session runs under Console's own supervisor, which would restart
    // the worker it owns. Asking its host to stop is not enough to end it.
    await stopLocalSession(sessionId);
  }
}

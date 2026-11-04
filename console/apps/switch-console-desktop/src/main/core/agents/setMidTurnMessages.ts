import { midTurnMessagesSchema } from '@shared/core/sessions/session-config';
import { getRemoteAgentLocation } from './agent-location';
import { getAgentById } from './getAgentById';
import { ensureRemoteWatcher, refreshLocalWatcher } from './remote-watcher';
import { updateAgent } from './updateAgent';

export async function setMidTurnMessages(agentId: string, mode: 'steer' | 'queue'): Promise<void> {
  const midTurnMessages = midTurnMessagesSchema.parse(mode);
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error(`No agent with id ${agentId}`);
  const providerConfig = {
    ...(agent.providerConfig ?? {
      version: '2' as const,
      providerId: agent.providerId,
      values: {},
    }),
    midTurnMessages,
  };
  if (!(await updateAgent({ agentId, providerConfig })))
    throw new Error(`No agent with id ${agentId}`);
  if ((await getRemoteAgentLocation(agent)) === null) await refreshLocalWatcher(agentId);
  else await ensureRemoteWatcher(agentId);
}

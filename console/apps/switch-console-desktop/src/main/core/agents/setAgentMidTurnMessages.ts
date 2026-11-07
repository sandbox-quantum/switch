import type { MidTurnMessages } from '@shared/core/agents/agents';
import { getAgentById } from './getAgentById';
import { refreshLocalWatcher } from './remote-watcher';
import { updateAgent } from './updateAgent';

export type AgentMidTurnMessagesParams = {
  agentId: string;
  midTurnMessages: MidTurnMessages;
};

/**
 * Choose whether an agent's sessions steer the running turn with a message
 * sent mid-turn or always queue it. The row is saved first; a Switch agent's
 * watcher is then handed the configuration it now describes, and brings each
 * live session in step once that session's turn ends. A watcher that cannot
 * be reached throws, saying the setting is kept.
 */
export async function setAgentMidTurnMessages(params: AgentMidTurnMessagesParams): Promise<void> {
  const agent = await getAgentById(params.agentId);
  if (!agent) throw new Error(`No agent with id ${params.agentId}`);
  if (!(await updateAgent({ agentId: agent.id, midTurnMessages: params.midTurnMessages })))
    throw new Error(`No agent with id ${params.agentId}`);
  if (agent.switchAgentId) await refreshLocalWatcher(agent.id);
}

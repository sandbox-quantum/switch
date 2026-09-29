import { keepAutoApproveChoice, recordAutoApproveOnHost } from '@main/core/sdk-host/shared-watcher';
import {
  listAutoSessionAgentIds,
  listStoppedControllerAgentIds,
} from '@main/core/switch-rooms/auto-session-store';
import { getRemoteAgentLocation } from './agent-location';
import { getAgentById } from './getAgentById';
import { pushRemoteAutoApprove } from './remote-watcher';
import { updateAgent } from './updateAgent';

export type AgentAutoApproveParams = { agentId: string; enabled: boolean };

/**
 * Toggle an agent's per-agent bypass-permissions setting (CHOO-1664).
 *
 * A remote agent's watchers are shared by every Console on the account and read
 * the choice kept on the host, so the choice goes on the host before the row
 * and the row never claims a value the host did not take. A failure after that
 * throws, saying only the running watcher lags.
 */
export async function setAgentAutoApprove(params: AgentAutoApproveParams): Promise<void> {
  const agent = await getAgentById(params.agentId);
  if (!agent) throw new Error(`No agent with id ${params.agentId}`);
  const setRow = async (autoApprove: boolean) => {
    if (!(await updateAgent({ agentId: agent.id, autoApprove }))) {
      throw new Error(`No agent with id ${params.agentId}`);
    }
  };
  if (!agent.switchAgentId || (await getRemoteAgentLocation(agent)) === null) {
    await setRow(params.enabled);
    return;
  }
  const [spawning, stopped] = await Promise.all([
    listAutoSessionAgentIds(),
    listStoppedControllerAgentIds(),
  ]);
  if (!spawning.includes(agent.id) || stopped.includes(agent.id)) {
    await recordAutoApproveOnHost(agent.id, params.enabled);
    await setRow(params.enabled);
    return;
  }
  await keepAutoApproveChoice(agent.id, params.enabled);
  await setRow(params.enabled);
  try {
    await pushRemoteAutoApprove(agent.id);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Auto-approve is saved, but the agent's watcher on its host could not be updated yet ` +
        `(${reason}). It runs its next sessions with the new setting once it is.`,
      { cause: error }
    );
  }
}

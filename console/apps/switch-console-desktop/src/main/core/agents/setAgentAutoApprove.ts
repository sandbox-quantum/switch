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
 * - A local agent, or one with no Switch identity yet, has no watcher on a
 *   host to agree with: the row is all there is, read fresh at each spawn and
 *   written into the first watcher.
 * - A remote agent's watchers are shared by every Console on the account
 *   (CHOO-2893), which take auto-approve from the choice kept on the host. So
 *   the choice goes on the host before the row, and the row never claims a
 *   value the host did not take. Where the watcher may start sessions (auto
 *   session on, nobody stopped it) it is then rewritten from the row, and the
 *   running sidecar applies the value to its next session without a restart.
 *   Otherwise nothing is about to rewrite it — a stopped watcher is not — so
 *   the value goes into its saved spec directly.
 *
 * Reaching the host is allowed to throw, and the caller should surface it:
 * before the choice is kept nothing has changed; after, the choice and the row
 * hold the new value and only the running watcher lags, which the error says.
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

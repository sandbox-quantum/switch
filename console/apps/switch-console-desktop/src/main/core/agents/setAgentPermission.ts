import { runtimeModeFor } from '@switch-console/agent-providers';
import { keepRuntimeModeChoice, recordRuntimeModeOnHost } from '@main/core/sdk-host/agent-host';
import { listStoppedControllerAgentIds } from '@main/core/switch-rooms/auto-session-store';
import { getRemoteAgentLocation } from './agent-location';
import { getAgentById } from './getAgentById';
import { pushRemotePermissions, refreshLocalWatcher } from './remote-watcher';
import { updateAgent } from './updateAgent';

/** `autoApprove` is bypass permissions; `autoMode` is the provider's own
 * automatic review. Bypass wins when both are on. */
export type AgentPermissionSetting = 'autoApprove' | 'autoMode';

export type AgentPermissionParams = {
  agentId: string;
  setting: AgentPermissionSetting;
  enabled: boolean;
};

/**
 * Toggle one of an agent's permission settings (CHOO-1664).
 *
 * A remote agent's watchers are shared by every Console on the account and read
 * the runtime mode choice kept on the host, so the choice goes on the host
 * before the row and the row never claims a value the host did not take. A
 * failure after that throws, saying only the running watcher lags.
 */
export async function setAgentPermission(params: AgentPermissionParams): Promise<void> {
  const agent = await getAgentById(params.agentId);
  if (!agent) throw new Error(`No agent with id ${params.agentId}`);
  const change = { [params.setting]: params.enabled };
  const mode = runtimeModeFor({
    autoApprove: agent.autoApprove,
    autoMode: agent.autoMode,
    ...change,
  });
  const setRow = async () => {
    if (!(await updateAgent({ agentId: agent.id, ...change }))) {
      throw new Error(`No agent with id ${params.agentId}`);
    }
  };
  if (!agent.switchAgentId || (await getRemoteAgentLocation(agent)) === null) {
    await setRow();
    if (agent.switchAgentId) await refreshLocalWatcher(agent.id);
    return;
  }
  if ((await listStoppedControllerAgentIds()).includes(agent.id)) {
    await recordRuntimeModeOnHost(agent.id, mode);
    await setRow();
    return;
  }
  await keepRuntimeModeChoice(agent.id, mode);
  await setRow();
  try {
    await pushRemotePermissions(agent.id);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The setting is saved, but the agent's watcher on its host could not be updated yet ` +
        `(${reason}). It runs its next sessions with the new setting once it is.`,
      { cause: error }
    );
  }
}

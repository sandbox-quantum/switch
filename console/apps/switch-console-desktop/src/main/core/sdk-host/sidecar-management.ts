import { getRemoteAgentLocation } from '@main/core/agents/agent-location';
import { getAgentById } from '@main/core/agents/getAgentById';
import { setControllerStopped } from '@main/core/switch-rooms/auto-session-store';
import { applyControllerState, configureSharedWatcher } from './shared-watcher';

export async function manageAgentSidecar(
  agentId: string,
  action: 'update' | 'restart' | 'stop' | 'start'
): Promise<void> {
  if (action === 'update') {
    const agent = await getAgentById(agentId);
    if (!agent) throw new Error(`Agent ${agentId} does not exist.`);
    if (!(await getRemoteAgentLocation(agent)))
      throw new Error(
        'A local agent has no deployed sidecar to update; it is watched by this Console build already.'
      );
  }
  // Stop is the one thing that takes an agent's connection away, and it is
  // recorded so that quitting Console does not put the agent back on the air.
  // Automatic sessions decide what a controller may do, not whether there is
  // one, so this no longer touches that setting.
  await setControllerStopped(agentId, action === 'stop');
  if (action === 'stop') {
    await configureSharedWatcher(agentId, { connected: false, spawning: false }, 'explicit');
    return;
  }
  // Someone pressed Start, Update or Restart, so this is the explicit ask that
  // brings a controller back after it stood down for a connection something
  // else took. Update and Restart stop first so the new bundle is what starts.
  if (action !== 'start')
    await configureSharedWatcher(agentId, { connected: false, spawning: false }, 'explicit');
  await applyControllerState(agentId, 'explicit');
}

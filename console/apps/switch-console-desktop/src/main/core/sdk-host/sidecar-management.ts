import { getRemoteAgentLocation } from '@main/core/agents/agent-location';
import { getAgentById } from '@main/core/agents/getAgentById';
import { setAgentAutoSession } from '@main/core/agents/setAgentAutoSession';
import { listAutoSessionAgentIds } from '@main/core/switch-rooms/auto-session-store';
import { configureSharedWatcher } from './shared-watcher';

export async function manageAgentSidecar(
  agentId: string,
  action: 'update' | 'restart' | 'stop' | 'start'
): Promise<void> {
  if (action === 'stop' || action === 'start') {
    await setAgentAutoSession({ agentId, enabled: action === 'start' });
    return;
  }
  if (action === 'update') {
    const agent = await getAgentById(agentId);
    if (!agent) throw new Error(`Agent ${agentId} does not exist.`);
    if (!(await getRemoteAgentLocation(agent)))
      throw new Error(
        'A local agent has no deployed sidecar to update; it is watched by this Console build already.'
      );
  }
  if (!(await listAutoSessionAgentIds()).includes(agentId))
    throw new Error(
      'Automatic sessions are off. Start the sidecar before updating or restarting it.'
    );
  await configureSharedWatcher(agentId, false);
  await configureSharedWatcher(agentId, true);
}

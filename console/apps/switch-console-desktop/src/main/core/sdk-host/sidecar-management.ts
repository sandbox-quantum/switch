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
  if (!(await listAutoSessionAgentIds()).includes(agentId))
    throw new Error(
      'Automatic sessions are off. Start the sidecar before updating or restarting it.'
    );
  await configureSharedWatcher(agentId, false);
  await configureSharedWatcher(agentId, true);
}

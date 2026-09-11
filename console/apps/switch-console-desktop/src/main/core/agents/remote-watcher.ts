import { configureSharedWatcher } from '@main/core/sdk-host/shared-watcher';
import { listAutoSessionAgentIds } from '@main/core/switch-rooms/auto-session-store';
import { agentEvents } from './agent-events';
import { getAgentById } from './getAgentById';
import { getAgents } from './getAgents';
import { remoteSessionReconciler } from './remote-session-reconciler';

// AutoSessionWatcher initializes both transports through the shared host.
export async function initializeRemoteWatchers(): Promise<void> {}

let discoveryInitialized = false;
export async function initializeRemoteDiscovery(): Promise<void> {
  if (!discoveryInitialized) {
    discoveryInitialized = true;
    const discover = (agent: Awaited<ReturnType<typeof getAgentById>>) => {
      if (!agent) return;
      if (agent.switchAgentId) remoteSessionReconciler.start(agent.id);
      else remoteSessionReconciler.stop(agent.id);
    };
    agentEvents.on('agent:created', discover);
    agentEvents.on('agent:updated', discover);
    agentEvents.on('agent:deleted', (id) => remoteSessionReconciler.stop(id));
  }
  for (const agent of await getAgents())
    if (agent.switchAgentId) remoteSessionReconciler.start(agent.id);
}
export async function startRemoteDiscovery(agentId: string): Promise<void> {
  if ((await getAgentById(agentId))?.switchAgentId) remoteSessionReconciler.start(agentId);
}
export async function ensureRemoteWatcher(agentId: string): Promise<void> {
  await configureSharedWatcher(agentId, (await listAutoSessionAgentIds()).includes(agentId));
  remoteSessionReconciler.start(agentId);
}
export async function stopRemoteWatcher(agentId: string): Promise<void> {
  await configureSharedWatcher(agentId, false);
}

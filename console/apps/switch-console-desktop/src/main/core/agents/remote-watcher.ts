import { configureSharedWatcher } from '@main/core/sdk-host/shared-watcher';
import { listAutoSessionAgentIds } from '@main/core/switch-rooms/auto-session-store';
import { getAgentById } from './getAgentById';
import { getAgents } from './getAgents';
import { remoteSessionReconciler } from './remote-session-reconciler';

// AutoSessionWatcher initializes both transports through the shared host.
export async function initializeRemoteWatchers(): Promise<void> {}

export async function initializeRemoteDiscovery(): Promise<void> {
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

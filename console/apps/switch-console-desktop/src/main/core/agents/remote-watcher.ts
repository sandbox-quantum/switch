import { applyControllerState, configureSharedWatcher } from '@main/core/sdk-host/shared-watcher';
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
/**
 * Puts the controller back in the state it is already configured to be in,
 * after a rename or a saved provider config. Nobody asked for it here, so one
 * that stood down after a takeover is left alone. An agent with no Switch
 * identity has nothing to connect as, and is not an error on this path.
 */
export async function ensureRemoteWatcher(agentId: string): Promise<void> {
  if (!(await getAgentById(agentId))?.switchAgentId) return;
  await applyControllerState(agentId, 'restore');
  remoteSessionReconciler.start(agentId);
}
export async function stopRemoteWatcher(agentId: string): Promise<void> {
  await configureSharedWatcher(agentId, { connected: false, spawning: false }, 'restore');
}

import { applyControllerState, configureAgentHost } from '@main/core/sdk-host/agent-host';
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
  await applyControllerState(agentId, 'restore', 'host');
  remoteSessionReconciler.start(agentId);
}
/** {@link ensureRemoteWatcher}, but writing this Console's auto-approve to the
 * host instead of adopting the host's. */
export async function pushRemoteAutoApprove(agentId: string): Promise<void> {
  await applyControllerState(agentId, 'restore', 'this-console');
  remoteSessionReconciler.start(agentId);
}
/**
 * Hands the running watcher of an agent on this computer the configuration its
 * settings now describe; it brings its live sessions in step as each finishes
 * its turn. A save that cannot reach it says so, with the setting kept.
 */
export async function refreshLocalWatcher(agentId: string): Promise<void> {
  if (!(await getAgentById(agentId))?.switchAgentId) return;
  try {
    await applyControllerState(agentId, 'restore', 'host');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The setting is saved, but the agent's running watcher could not be updated yet (${reason}). ` +
        'Its sessions take the new setting once it is.',
      { cause: error }
    );
  }
}
export async function stopRemoteWatcher(agentId: string): Promise<void> {
  await configureAgentHost(agentId, { connected: false, spawning: false }, 'restore');
}

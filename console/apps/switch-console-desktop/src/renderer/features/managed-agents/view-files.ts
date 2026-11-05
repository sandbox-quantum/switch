import { isCloudMachine, type ManagedAgentView } from '@shared/core/managed-agents/managed-agents';

/**
 * The agent View files opens Your cloud files at, by the name its folder is
 * listed under (`agent`, the controller's stable key, never the label); null
 * when View files doesn't show: Your cloud files hidden, or the agent not on a
 * cloud machine.
 */
export function viewFilesAgent(agent: ManagedAgentView, filesShown: boolean): string | null {
  if (!filesShown || agent.machine === null || !isCloudMachine(agent.machine)) return null;
  return agent.name;
}

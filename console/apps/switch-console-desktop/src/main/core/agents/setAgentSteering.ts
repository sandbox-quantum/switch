import { updateAgent } from './updateAgent';

export type AgentSteeringParams = {
  agentId: string;
  /** Steer messages sent mid-turn into the running turn; false always queues them. */
  enabled: boolean;
};

/**
 * Choose whether a message sent while the agent is working may steer into the
 * running turn or always waits for a turn of its own. A session reads the
 * choice as it starts, so it applies from the agent's next session.
 */
export async function setAgentSteering(params: AgentSteeringParams): Promise<void> {
  if (!(await updateAgent({ agentId: params.agentId, steerMessages: params.enabled })))
    throw new Error(`No agent with id ${params.agentId}`);
}

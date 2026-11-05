import {
  type CloudDeleteAgent,
  cloudDeletePlan,
} from '@shared/core/managed-agents/cloud-delete-plan';

/** What deleting needs from the server, so the order can be tested without one. */
export type CloudDeleteSteps = {
  /** Whether the server runs hosted agents v2. */
  hostedV2: () => Promise<boolean>;
  /** The owner's managed agents, read fresh. */
  agents: () => Promise<CloudDeleteAgent[]>;
  /**
   * The controller the owner's v2 box enrolled as (hosted-machines'
   * `controller_id`), or null when they have no box. Never worked out from a
   * machine's kind: a computer of their own can carry any label.
   */
  boxControllerId: () => Promise<string | null>;
  /** The providers the box holds a login for. */
  loginProviders: (controllerId: string) => Promise<string[]>;
  /** Withdraws the box's login for a provider; resolves `gone` when there was none. */
  withdrawLogin: (controllerId: string, provider: string) => Promise<'withdrawn' | 'gone'>;
  /** Deletes the agent itself. */
  deleteAgent: () => Promise<void>;
};

export class LoginStillOnBoxError extends Error {
  constructor(provider: string) {
    super(`The ${provider} login is still on your cloud, so the agent wasn't deleted. Try again.`);
    this.name = 'LoginStillOnBoxError';
  }
}

/**
 * Deletes an agent, minding its box's login. Only with hosted agents v2 on,
 * and only for an agent on the owner's v2 box: when it is the provider's last
 * agent there, the login is withdrawn and read back as gone first, and if
 * either step fails nothing is deleted. Any other agent is deleted as before.
 * Returns the provider whose login was withdrawn, if one was.
 */
export async function deleteMindingBoxLogin(
  agentId: string,
  steps: CloudDeleteSteps
): Promise<string | null> {
  if (!(await steps.hostedV2())) {
    await steps.deleteAgent();
    return null;
  }
  const [agents, boxId] = await Promise.all([steps.agents(), steps.boxControllerId()]);
  const agent = agents.find((candidate) => candidate.agentId === agentId);
  if (!agent || boxId === null || agent.controllerId !== boxId) {
    await steps.deleteAgent();
    return null;
  }
  const plan = cloudDeletePlan(agent, agents);
  if (!plan.withdrawLogin) {
    await steps.deleteAgent();
    return null;
  }
  await steps.withdrawLogin(agent.controllerId, plan.provider);
  if ((await steps.loginProviders(agent.controllerId)).includes(plan.provider))
    throw new LoginStillOnBoxError(plan.provider);
  await steps.deleteAgent();
  return plan.provider;
}

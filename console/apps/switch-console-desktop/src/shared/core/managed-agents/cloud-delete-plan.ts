/**
 * What deleting an agent on the owner's Switch cloud box does to its
 * provider's login. A login belongs to the box and the provider, not to one
 * agent, so it is withdrawn only with the last agent on the box using that
 * provider; otherwise it stays for the others. Switch web works it out the
 * same way, so either app leaves the box in the same state.
 */

/** Just what the plan reads of an agent. */
export type CloudDeleteAgent = {
  agentId: string;
  /** How people see it: its display name, else its name. */
  label: string;
  controllerId: string | null;
  provider: string;
};

export type CloudDeletePlan = {
  provider: string;
  /** True when it is the provider's last agent on the box, so the login goes too. */
  withdrawLogin: boolean;
  /** The other agents on the box still using that login, by label. */
  stillUsing: string[];
};

export function cloudDeletePlan(
  agent: CloudDeleteAgent,
  agents: readonly CloudDeleteAgent[]
): CloudDeletePlan {
  const others = agents.filter(
    (other) =>
      other.agentId !== agent.agentId &&
      other.controllerId !== null &&
      other.controllerId === agent.controllerId &&
      other.provider === agent.provider
  );
  return {
    provider: agent.provider,
    withdrawLogin: others.length === 0,
    stillUsing: others.map((other) => other.label).sort((a, b) => a.localeCompare(b)),
  };
}

/** The confirm's line about the login, for a cloud agent. */
export function cloudDeleteLoginLine(plan: CloudDeletePlan, providerLabel: string): string {
  if (plan.withdrawLogin)
    return `Its ${providerLabel} login is taken off your cloud too, as no other agent there uses it.`;
  const verb = plan.stillUsing.length === 1 ? 'uses' : 'use';
  return `The ${providerLabel} login stays on your cloud, because ${plan.stillUsing.join(', ')} still ${verb} it.`;
}

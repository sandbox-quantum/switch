import type { CloudLogin } from "../../../data/cloudLogins";
import type { ManagedAgent } from "../../../data/management";

/**
 * What deleting a cloud agent does to its box's AI login (hosted agents v2,
 * Switch web; plan decision of 5 Nov). Logins are per box and provider, so the
 * login is withdrawn only when this is the last agent on the box using that
 * provider's login; otherwise it stays, and the confirm names the agents still
 * using it. Worked out from a fresh read, never from what the page last showed.
 */
export type DeletePlan =
  | { kind: "withdraw_then_delete"; provider: string }
  | { kind: "delete_keep_login"; provider: string; sharedWith: string[] }
  | { kind: "delete_only" }
  | { kind: "not_found" };

export function deletePlan(
  agentId: string,
  controllerId: string,
  agents: readonly ManagedAgent[],
  logins: readonly CloudLogin[],
): DeletePlan {
  const agent = agents.find((a) => a.agent_id === agentId);
  if (!agent) return { kind: "not_found" };
  const provider = agent.definition.provider;
  // No login for its provider on the box: nothing to withdraw.
  if (!logins.some((login) => login.provider === provider)) return { kind: "delete_only" };
  const sharedWith = agents
    .filter(
      (other) =>
        other.agent_id !== agentId &&
        other.controller_id === controllerId &&
        other.definition.provider === provider,
    )
    .map((other) => other.display_name?.trim() || other.name)
    .sort((a, b) => a.localeCompare(b));
  return sharedWith.length === 0
    ? { kind: "withdraw_then_delete", provider }
    : { kind: "delete_keep_login", provider, sharedWith };
}

/**
 * Discovery reports a failure per agent, so one unreachable server fills the
 * sidebar with the same line once for every agent on it. Agents that failed for
 * the same reason share a cause and a retry, so they share a message.
 *
 * Order follows first appearance, so a banner does not move as other agents
 * fail and recover around it.
 */
export function groupDiscoveryFailures(
  failures: { agentId: string; message: string }[]
): { message: string; agentIds: string[] }[] {
  const byMessage = new Map<string, string[]>();
  for (const failure of failures)
    byMessage.set(failure.message, [...(byMessage.get(failure.message) ?? []), failure.agentId]);
  return [...byMessage].map(([message, agentIds]) => ({ message, agentIds }));
}

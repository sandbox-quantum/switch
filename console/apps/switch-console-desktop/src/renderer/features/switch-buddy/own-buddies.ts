import { observable, runInAction } from 'mobx';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { findBuddy } from './buddy-identity';

/**
 * The person's own switch-buddy on each server, by agent id, as their managed
 * agents last read from it said: which agent the server recorded the buddy
 * template creating. Only that agent wears switch-buddy's picture; any agent
 * can carry the picture's URL.
 */
const byServer = observable.map<string, string | null>();

/** Records what a read of the person's managed agents on `serverId` says. */
export function recordOwnBuddy(
  serverId: string,
  agents: readonly Pick<ManagedAgentView, 'agentId' | 'name' | 'template'>[] | null
): void {
  const buddy = findBuddy(agents)?.agentId ?? null;
  if (byServer.get(serverId) === buddy) return;
  runInAction(() => byServer.set(serverId, buddy));
}

/** Whether `agentId` on `serverId` is the person's own switch-buddy, as last read. */
export function isOwnBuddy(serverId: string | null, agentId: string): boolean {
  return serverId !== null && byServer.get(serverId) === agentId;
}

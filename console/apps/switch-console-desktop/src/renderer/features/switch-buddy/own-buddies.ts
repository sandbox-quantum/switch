import { observable, runInAction } from 'mobx';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { findBuddy } from './buddy-identity';

/**
 * The person's own switch-buddy in each workspace of each server, by agent
 * id, as their managed agents there last read said: which agent the server
 * recorded the buddy template creating. Only that agent wears switch-buddy's
 * picture; any agent can carry the picture's URL.
 *
 * A person has a buddy in every workspace they belong to, so a read of one
 * workspace's agents replaces that workspace's buddy only. Each server's
 * workspaces are kept as a plain map, replaced whole when one changes.
 */
const byServer = observable.map<string, ReadonlyMap<string | null, string | null>>(undefined, {
  deep: false,
});

/**
 * Records what a read of the person's managed agents in `workspaceId` on
 * `serverId` says; null for a read made before the workspace was known.
 */
export function recordOwnBuddy(
  serverId: string,
  workspaceId: string | null,
  agents: readonly Pick<ManagedAgentView, 'agentId' | 'name' | 'template'>[] | null
): void {
  const buddy = findBuddy(agents)?.agentId ?? null;
  const workspaces = byServer.get(serverId);
  if (workspaces?.has(workspaceId) && workspaces.get(workspaceId) === buddy) return;
  runInAction(() => byServer.set(serverId, new Map(workspaces).set(workspaceId, buddy)));
}

/**
 * Whether `agentId` on `serverId` is the person's own switch-buddy in one of
 * their workspaces there, as last read. An agent id names one agent on its
 * server, so which workspace need not be known: the surfaces drawing an
 * agent mostly do not know it.
 */
export function isOwnBuddy(serverId: string | null, agentId: string): boolean {
  if (serverId === null) return false;
  for (const buddy of byServer.get(serverId)?.values() ?? []) if (buddy === agentId) return true;
  return false;
}

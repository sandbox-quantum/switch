import { useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import type { RemoteAgentSummary } from '@shared/core/switch-servers/switch-servers';

/** The agent list a workspace holds, keyed so every surface shares one fetch.
 * Several unrelated views ask for this at once — the sidebar rows, the room
 * panels, the agent page — and they must agree, so the key is defined once
 * here rather than retyped at each call site. */
export function workspaceAgentsQueryKey(workspaceId: string | null) {
  return ['workspace-agents', workspaceId] as const;
}

/**
 * Every agent registered in `workspaceId`, or an idle query when there is no
 * workspace to ask.
 */
export function useWorkspaceAgents(workspaceId: string | null) {
  return useQuery<RemoteAgentSummary[]>({
    queryKey: workspaceAgentsQueryKey(workspaceId),
    queryFn: () => rpc.workspaces.listAgents(workspaceId as string),
    enabled: workspaceId !== null,
  });
}

/**
 * The last icon each agent was seen with, by workspace and agent. A server
 * that is stopped or unreachable lists no agents, and without this every row
 * would fall back to the name-drawn avatar until it answers again — the same
 * agent changing face with its server's state.
 */
const lastKnownIcons = new Map<string, string>();

/**
 * An agent's chosen icon, or null when it has none, is not in this workspace,
 * or the list has not arrived yet.
 *
 * Null is not an error and callers must not treat it as one: `AgentAvatar`
 * draws an avatar from the agent's name instead, so a row renders the right
 * picture on first paint and simply sharpens to a custom icon if there is one.
 *
 * While the server does not list the agent, the icon it last had is kept. An
 * agent the server does list with no icon has none, and loses the remembered one.
 */
export function useAgentIconUrl(
  workspaceId: string | null,
  switchAgentId: string | null
): string | null {
  const agents = useWorkspaceAgents(workspaceId);
  if (switchAgentId === null) return null;
  const key = `${workspaceId}:${switchAgentId}`;
  const listed = agents.data?.find((agent) => agent.id === switchAgentId);
  if (!listed) return lastKnownIcons.get(key) ?? null;
  if (listed.iconUrl) lastKnownIcons.set(key, listed.iconUrl);
  else lastKnownIcons.delete(key);
  return listed.iconUrl ?? null;
}

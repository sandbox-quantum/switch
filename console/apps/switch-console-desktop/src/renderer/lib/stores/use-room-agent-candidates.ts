import { useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';

export function roomAgentCandidatesQueryKey(workspaceId: string | null, roomId: string | null) {
  return ['room-agent-candidates', workspaceId, roomId] as const;
}

/**
 * The ids of the agents the signed-in person may bring into `roomId`, or into
 * a new room when it is null, as the server's invite rule decides: they must
 * be in the room and allowed to address each agent. A picker lists only
 * these, so it never offers an agent the invite would refuse.
 *
 * `data` is null from a server that cannot say, where a picker offers every
 * agent and leaves the refusal to the invite.
 */
export function useRoomAgentCandidates(workspaceId: string | null, roomId: string | null) {
  return useQuery<string[] | null>({
    queryKey: roomAgentCandidatesQueryKey(workspaceId, roomId),
    queryFn: () =>
      rpc.workspaces.roomAgentCandidates({ workspaceId: workspaceId as string, roomId }),
    enabled: workspaceId !== null,
  });
}

/**
 * Of `agents`, the ones a picker may offer, given what
 * `useRoomAgentCandidates` answered: all of them when the server cannot say.
 */
export function invitableAgents<T extends { id: string }>(
  agents: readonly T[],
  candidateIds: readonly string[] | null | undefined
): T[] {
  if (candidateIds === null || candidateIds === undefined) return [...agents];
  const allowed = new Set(candidateIds);
  return agents.filter((agent) => allowed.has(agent.id));
}

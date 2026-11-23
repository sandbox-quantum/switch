import type { QueryClient } from '@tanstack/react-query';
import { MANAGED_AGENTS_KEY } from '@renderer/features/managed-agents/use-managed-agents-key';
import type { ChatSummary } from '@shared/core/chats/chats';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { isBuddy } from './buddy-identity';

type OwnAgent = Pick<ManagedAgentView, 'agentId' | 'name' | 'template'>;

/**
 * Whether a chat is with the person's own switch-buddy: its one agent is
 * their buddy, whoever else is in it. Their managed agent decides when their
 * list holds it, by the template run that made it (`isBuddy`). Without it,
 * the chat's own record of the agent does: one of theirs, named as buddies
 * are. A chat not known yet, or with no agent or several, is not.
 */
export function isBuddyChat(
  chat: Pick<ChatSummary, 'agents'> | undefined,
  ownAgents: readonly OwnAgent[]
): boolean {
  if (chat?.agents.length !== 1) return false;
  const [agent] = chat.agents;
  if (!agent) return false;
  const own = ownAgents.find((candidate) => candidate.agentId === agent.id);
  if (own) return isBuddy(own);
  return agent.ownedByViewer && isBuddy({ name: agent.name });
}

/**
 * The person's own managed agents on a server, as already read for this user,
 * from every workspace's list: nothing is fetched. Another user's list, kept
 * from before signing in as someone else, is left out, so their agents are
 * never taken for this person's.
 */
export function cachedOwnAgents(
  queryClient: QueryClient,
  serverId: string,
  userId: string | null
): OwnAgent[] {
  if (userId === null) return [];
  return (
    queryClient
      .getQueriesData<unknown>({ queryKey: [MANAGED_AGENTS_KEY, serverId] })
      .filter(([key]) => key[3] === userId)
      // Other queries share the prefix (a machine's recheck); only lists are agents.
      .flatMap(([, data]) => (Array.isArray(data) ? (data as OwnAgent[]) : []))
  );
}

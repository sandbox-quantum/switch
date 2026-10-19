import { type ChatAgent, chatAgentLabel } from '@shared/core/chats/chats';

export type ConsoleChatRoute =
  | {
      viewId: 'managedAgent';
      params: { serverId: string; agentId: string; name: string; roomId: string };
    }
  | { viewId: 'chat'; params: { serverId: string; roomId: string; agentId: string } };

/**
 * Where a 1-1 Console chat opens: on its agent's page when the agent is a
 * managed agent, which is the only agent page with chats, else on its own.
 */
export function consoleChatRoute(
  serverId: string,
  roomId: string,
  agent: Pick<ChatAgent, 'id' | 'name' | 'displayName'>,
  managed: boolean
): ConsoleChatRoute {
  if (managed)
    return {
      viewId: 'managedAgent',
      params: { serverId, agentId: agent.id, name: chatAgentLabel(agent), roomId },
    };
  return { viewId: 'chat', params: { serverId, roomId, agentId: agent.id } };
}

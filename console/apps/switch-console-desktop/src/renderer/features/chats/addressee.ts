import type { ChatAgent } from '@shared/core/chats/chats';

/**
 * The composer's choice in a chat with several agents that addresses none of
 * them: the message is room chatter, read by whoever reads the room. Not an
 * agent id, which are UUIDs.
 */
export const ROOM_ONLY = 'room-only';

/**
 * The agent a send names, from the composer's selection. A direct chat needs
 * no mention — its one agent is addressed by every message — and room-only
 * names nobody. Otherwise the selected agent, or the chat's first when the
 * selection is not one of its agents.
 */
export function mentionAgentIdFor(agents: ChatAgent[], selection: string | null): string | null {
  if (agents.length <= 1 || selection === ROOM_ONLY) return null;
  return (agents.find((agent) => agent.id === selection) ?? agents[0]).id;
}

import {
  ACTIVITY_UNAVAILABLE_TEXT,
  type ChatActivityTarget,
  type ChatActivityUnavailableReason,
} from '@shared/core/chats/activity';

/**
 * Which session of an agent attends a chat, when it runs on this machine or
 * its SSH host: what the chat reads reasoning and full tool input and output
 * from, and restarts. Turns, tools and approvals come from Switch's activity
 * feed for every agent; this lookup adds only what the host alone keeps.
 */

export type LocalChatAgent = { id: string; switchAgentId: string; ssh: boolean };

export type ActivityDeps = {
  /** This Console's agents linked to the server and not moved to a controller. */
  localAgents: (serverId: string) => Promise<LocalChatAgent[]>;
  /** A local agent's placements (session → room), or null while its watcher cannot be asked. */
  placements: (serverId: string, consoleAgentId: string) => Promise<Record<string, string> | null>;
};

const unavailable = (
  reason: ChatActivityUnavailableReason,
  message: string = ACTIVITY_UNAVAILABLE_TEXT[reason]
): ChatActivityTarget => ({ kind: 'unavailable', reason, message });

/** The session placed in `roomId`, from a placements map. */
export function placedSession(placements: Record<string, string>, roomId: string): string | null {
  for (const [sessionId, placedRoom] of Object.entries(placements))
    if (placedRoom === roomId) return sessionId;
  return null;
}

export async function resolveChatActivity(
  deps: ActivityDeps,
  input: { serverId: string; agentId: string; roomId: string }
): Promise<ChatActivityTarget> {
  const { serverId, agentId, roomId } = input;
  const local = (await deps.localAgents(serverId)).find((agent) => agent.switchAgentId === agentId);
  if (!local) return unavailable('not-on-this-machine');
  const placements = await deps.placements(serverId, local.id);
  if (placements === null) return unavailable('watcher-unreachable');
  const sessionId = placedSession(placements, roomId);
  if (sessionId === null) return unavailable('not-placed');
  return {
    kind: 'session',
    target: local.ssh ? 'ssh' : 'local',
    hostAgentKey: local.id,
    sessionId,
  };
}

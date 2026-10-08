import type { WatcherHealth } from '@switch-console/agent-providers';
import type { Session } from '@switch-console/shared/session-v1';
import {
  ACTIVITY_UNAVAILABLE_TEXT,
  type ChatActivityTarget,
  type ChatActivityUnavailableReason,
} from '@shared/core/chats/activity';

/**
 * Which session of an agent attends a chat, from where it runs.
 *
 * A Console agent on this machine or its SSH host is asked through its own
 * room watcher's placements. A managed agent — any controller, cloud or not —
 * is asked through the server's relay for the agent, which is owner-only:
 * its watcher's placements first, then the sessions it lists with the room
 * among theirs. Switch itself is never asked which session is placed where.
 */

export type LocalChatAgent = { id: string; switchAgentId: string; ssh: boolean };
export type OwnedManagedAgent = {
  agentId: string;
  controllerId: string | null;
  controllerKind: string | null;
  controllerOnline: boolean;
};

export type ActivityDeps = {
  /** This Console's agents linked to the server and not moved to a controller. */
  localAgents: (serverId: string) => Promise<LocalChatAgent[]>;
  /** A local agent's placements (session → room), or null while its watcher cannot be asked. */
  placements: (serverId: string, consoleAgentId: string) => Promise<Record<string, string> | null>;
  /** The signed-in person's managed agents, or null where the server has no agent management. */
  ownedManagedAgents: (serverId: string) => Promise<OwnedManagedAgent[] | null>;
  /** Whether the signed-in person owns the Switch agent. */
  ownsAgent: (serverId: string, agentId: string) => Promise<boolean>;
  /** The relay key for a managed agent: a cloud key for a cloud machine's agent, else a controller key. */
  relayKey: (serverId: string, agent: OwnedManagedAgent) => { key: string; cloud: boolean };
  relayHealth: (key: string) => Promise<WatcherHealth>;
  relaySessions: (key: string) => Promise<Session[]>;
  /** The relay's refusal code, when the error is one. */
  relayCode: (error: unknown) => string | null;
};

const unavailable = (
  reason: ChatActivityUnavailableReason,
  message: string = ACTIVITY_UNAVAILABLE_TEXT[reason],
  wakeAgentKey: string | null = null
): ChatActivityTarget => ({ kind: 'unavailable', reason, message, wakeAgentKey });

const ASLEEP = new Set(['worker_sleeping', 'worker_waking', 'machine_stopped']);

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
  if (local) {
    const placements = await deps.placements(serverId, local.id);
    if (placements === null) return unavailable('watcher-unreachable');
    const sessionId = placedSession(placements, roomId);
    if (sessionId === null) return unavailable('not-placed');
    return {
      kind: 'session',
      target: local.ssh ? 'ssh' : 'local',
      hostAgentKey: local.id,
      sessionId,
      controllerId: null,
      generation: null,
      cloud: false,
    };
  }
  const managed = (await deps.ownedManagedAgents(serverId))?.find(
    (agent) => agent.agentId === agentId
  );
  if (!managed)
    return (await deps.ownsAgent(serverId, agentId))
      ? unavailable('not-on-this-machine')
      : unavailable('not-owner');
  if (managed.controllerId === null) return unavailable('not-on-this-machine');
  const { key, cloud } = deps.relayKey(serverId, managed);
  if (!managed.controllerOnline)
    return cloud
      ? unavailable('machine-asleep', undefined, key)
      : unavailable('controller-offline');
  let health: WatcherHealth;
  try {
    health = await deps.relayHealth(key);
  } catch (error) {
    const code = deps.relayCode(error);
    if (cloud && code !== null && ASLEEP.has(code))
      return unavailable('machine-asleep', undefined, key);
    return unavailable(
      'controller-offline',
      `${ACTIVITY_UNAVAILABLE_TEXT['controller-offline']} ${error instanceof Error ? error.message : String(error)}`
    );
  }
  let sessionId = placedSession(health.placements, roomId);
  if (sessionId === null) {
    const sessions = await deps.relaySessions(key).catch(() => [] as Session[]);
    sessionId =
      sessions.find((session) => !session.retired && session.roomIds?.includes(roomId))
        ?.sessionId ?? null;
  }
  if (sessionId === null) return unavailable('not-placed');
  return {
    kind: 'session',
    target: 'controller',
    hostAgentKey: key,
    sessionId,
    controllerId: managed.controllerId,
    generation: health.since,
    cloud,
  };
}

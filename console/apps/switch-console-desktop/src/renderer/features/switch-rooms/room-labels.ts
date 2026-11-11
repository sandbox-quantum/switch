import type { BridgePerson } from '@shared/core/switch-servers/switch-servers';

/**
 * A room's name as it is written where the room actually lives.
 *
 * The `#` is the channel sigil of the apps these rooms are bridged into — so it
 * says "this is that channel" rather than decorating the name. Added only when
 * the name does not already carry one, and never to a room in no app at all,
 * where there is no channel for it to name.
 */
export function roomTitle(room: { name: string; bridgeType: string | null }): string {
  if (!room.bridgeType || room.name.startsWith('#')) return room.name;
  return `#${room.name}`;
}

/**
 * "1 agent · 1 person" — the two kinds of member counted separately, because
 * they are not interchangeable.
 *
 * People are left out rather than shown as zero: an unbridged room has no way
 * for anyone to be in it, and "0 people" reads as a room nobody came to.
 */
export function membershipSummary(agentCount: number, personCount: number): string {
  const agents = `${agentCount} ${agentCount === 1 ? 'agent' : 'agents'}`;
  if (personCount === 0) return agents;
  return `${agents} · ${personCount} ${personCount === 1 ? 'person' : 'people'}`;
}

/**
 * The roster's people who can still be added to a chat: not in it already, and
 * not a service account (the agent-registration bootstrap owner), which the
 * server marks rather than anything its name says.
 */
export function addablePeople<T extends { userId: string; serviceAccount: boolean }>(
  roster: T[],
  memberIds: Set<string>
): T[] {
  return roster.filter((person) => !person.serviceAccount && !memberIds.has(person.userId));
}

/**
 * The people Switch knows on a bridge who are not in the room yet, as rows to
 * add: by the full name of the Switch user who linked the account when there
 * is one, with the username beside it, so either can be searched for. The
 * username is still what the room is given. Someone seen under two accounts
 * with the same username is offered once, by the first name found.
 */
export function addableBridgePeople(
  people: BridgePerson[],
  present: Set<string>
): { id: string; name: string; detail: string }[] {
  const byUsername = new Map<string, string | null>();
  for (const person of people) {
    if (present.has(person.username)) continue;
    const known = byUsername.get(person.username) ?? null;
    byUsername.set(person.username, known ?? person.linkedName);
  }
  return [...byUsername]
    .map(([username, linkedName]) => ({
      id: username,
      name: linkedName ?? username,
      detail: `@${username}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The agents the server says the viewer may add (`GET /chats/agent-candidates`):
 * one the viewer may not use, or already in the chat, is not offered.
 */
export function addableAgents<T extends { id: string }>(agents: T[], candidateIds: string[]): T[] {
  const ids = new Set(candidateIds);
  return agents.filter((agent) => ids.has(agent.id));
}

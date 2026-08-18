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

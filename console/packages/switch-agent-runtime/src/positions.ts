/**
 * A position records how far a connection has read the events the server
 * sends an agent. This module reads positions off the wire and merges them. It
 * mirrors `switch_core/bridges/agent/protocol/positions.py` on the server.
 */

/**
 * How far a connection has read, as one number per source of events, each
 * numbered on its own. `s` is the agent's own events: the events meant for the
 * agent (messages addressed to it, the room joins it listens for, commands,
 * task events), not the ones it sent. `r:<room id>` is a room's conversation, which
 * the server sends only to a connection that reads everything said in the room.
 * The server names the sources, so apart from `s` this runtime keeps whatever
 * keys it is sent without interpreting them.
 */
export type Position = Record<string, number>;

/** The key for the agent's own events in a `Position`. Its number is the only one
 * a server on agent-protocol 8 or older understands. */
export const OWN_EVENTS = 's';

/** Reads a position from a frame field, or returns null when the field is not
 * a valid position. */
export function readPosition(raw: unknown): Position | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const position: Position = {};
  for (const [source, value] of Object.entries(raw)) {
    if (!Number.isSafeInteger(value) || (value as number) < 0) return null;
    position[source] = value as number;
  }
  return position;
}

/** The join (least upper bound) of two positions in their join-semilattice:
 * each source at the further of the two. Merging this way never moves a
 * position back. Only a `gap` frame does that, and its `resumed_position`
 * replaces the position instead of being merged. */
export function furthest(current: Position, reported: Position): Position {
  const position = { ...current };
  for (const [source, value] of Object.entries(reported))
    position[source] = Math.max(position[source] ?? 0, value);
  return position;
}

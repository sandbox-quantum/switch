/**
 * Which session is calling, for a server that can no longer tell.
 *
 * A connection used to be one session, so naming it named the caller. Several
 * sessions of one agent may now share a controller connection, and the
 * connection then holds the union of their rooms — so a room-scoped operation
 * arriving on it has no way to say whose room it meant. The session selector
 * says: this session, on this host, in this generation of it.
 *
 * The supervisor knows those three and this process does not, so it writes
 * them to a file in the session's own state directory and passes the path in.
 * A file rather than the environment, because one of the three moves: the
 * server re-mints the epoch whenever a session recovers, which a reset goes
 * through, and an environment variable read once at startup would then name a
 * generation that no longer exists. Nothing here caches it either — it is read
 * per call, which is a local read next to an HTTP round trip.
 *
 * All three or none. The server refuses a partial selector outright, and
 * refuses one naming a session that has bound no connection — so the
 * supervisor writes the file only once that binding exists, and its absence
 * means "say nothing", which is what a session with no supervisor does anyway.
 */

import * as fs from 'node:fs';

/** The header names the operations door reads the selector from. */
export const SESSION_SELECTOR_HEADERS = {
  sessionId: 'X-Switch-Session-Id',
  hostId: 'X-Switch-Session-Host-Id',
  epoch: 'X-Switch-Session-Epoch',
} as const;

/**
 * The selector headers to send, or none.
 *
 * Absent — no path, or nothing written yet — is the ordinary case and answers
 * empty. Present but unreadable is not: a supervisor that wrote something this
 * cannot parse has left every call it makes resolving to the wrong caller, so
 * that is raised rather than quietly dropped back to connection-only.
 */
export function sessionSelector(file: string | null): Record<string, string> {
  if (!file) return {};
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file} is not readable as a session selector: ${error}`);
  }
  const { session_id, host_id, epoch } = (parsed ?? {}) as Record<string, unknown>;
  if (typeof session_id !== 'string' || !session_id)
    throw new Error(`${file} carries no session_id`);
  if (typeof host_id !== 'string' || !host_id) throw new Error(`${file} carries no host_id`);
  if (typeof epoch !== 'string' || !epoch) throw new Error(`${file} carries no epoch`);
  return {
    [SESSION_SELECTOR_HEADERS.sessionId]: session_id,
    [SESSION_SELECTOR_HEADERS.hostId]: host_id,
    [SESSION_SELECTOR_HEADERS.epoch]: epoch,
  };
}

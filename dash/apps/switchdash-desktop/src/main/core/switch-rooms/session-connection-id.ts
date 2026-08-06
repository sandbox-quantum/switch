import { createHash } from 'node:crypto';

/**
 * The Switch connection id a session's tool calls are expected to arrive on,
 * derived from the session id.
 *
 * A supervisor (switchdash or the on-host sidecar) opens the connection before
 * the session launches and hands the id over in `SWITCH_CONNECTION_ID`. The
 * agent reads that variable once, at startup, and stamps it on every tool call
 * for the rest of its life. A random id therefore only survives as long as the
 * supervisor process does: on restart the supervisor mints a new one while the
 * agent — whose pane outlives the supervisor — keeps sending the old one, which
 * the server sweeps once its heartbeat lapses. Every subsequent tool call is
 * then rejected, permanently, and each rejection also releases the room slot.
 *
 * Deriving the id from the session id removes the hand-off from the recovery
 * path entirely: a restarted supervisor recomputes the id the pane is already
 * holding, and reopening an id the same agent already holds is a takeover that
 * keeps the connection's room claim. There is nothing to persist and nothing to
 * re-deliver, so this works from a cold start with no state at all.
 *
 * The value must stay globally unique — the server keys connections by id alone
 * across every agent — which is what the UUIDv5 hash buys over anything shorter
 * or more readable.
 *
 * Only one supervisor derives an id for any given session: switchdash's poller
 * declines remote sessions, which are the sidecar's. Two supervisors deriving
 * for the same session would fight over one connection.
 */
export function sessionConnectionId(sessionId: string): string {
  return uuidV5(sessionId, SESSION_CONNECTION_NAMESPACE);
}

/**
 * Namespace for session-derived connection ids. Arbitrary but fixed: changing
 * it re-points every session at a different connection, which is the same
 * breakage this module exists to prevent.
 */
const SESSION_CONNECTION_NAMESPACE = '37b41592-2345-455b-8b74-545f79dda0c7';

/**
 * RFC 4122 §4.3 name-based UUID, SHA-1 flavour.
 *
 * Hand-rolled because the repo carries no `uuid` dependency and this is the
 * only caller. Exported so the conformance vectors in the spec can be asserted
 * directly — an id that is merely stable but not a well-formed UUID would be
 * rejected by the server's validation.
 */
export function uuidV5(name: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  const hash = createHash('sha1').update(namespaceBytes).update(name, 'utf8').digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

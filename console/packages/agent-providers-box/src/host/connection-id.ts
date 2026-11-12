import { createHash } from 'node:crypto';

/**
 * The Switch connection id a session's tool calls are expected to arrive on,
 * derived from the session id.
 *
 * A supervisor (Switch Console or the on-host sidecar) opens the connection before
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
 * Only one supervisor derives an id for any given session: Switch Console's poller
 * declines remote sessions, which are the sidecar's. Two supervisors deriving
 * for the same session would fight over one connection.
 */
export function sessionConnectionId(sessionId: string): string {
  return uuidV5(sessionId, SESSION_CONNECTION_NAMESPACE);
}

/**
 * The Switch connection id an agent's controller uses, derived from the Switch
 * agent id.
 *
 * At most one controller connection per agent exists globally; exactly one
 * while an active owner exists. A random id cannot express that: two Consoles
 * watching the same agent mint two ids, the server has no way to know they are
 * the same role, and both connections live — so an addressed message reaches
 * whichever one the coverage rules happen to favour, and the other quietly
 * waits forever. Deriving the id from the agent makes the collision the point:
 * the second controller reopens the first one's connection, which is a takeover
 * the server can see, arbitrate and report.
 *
 * It also survives a restart with no state. A Console that crashes and comes
 * back recomputes the same id and resumes the same connection rather than
 * leaving the old one to be swept.
 */
export function controllerConnectionId(switchAgentId: string): string {
  return uuidV5(switchAgentId, CONTROLLER_CONNECTION_NAMESPACE);
}

/**
 * Namespace for session-derived connection ids. Arbitrary but fixed: changing
 * it re-points every session at a different connection, which is the same
 * breakage this module exists to prevent.
 */
const SESSION_CONNECTION_NAMESPACE = '37b41592-2345-455b-8b74-545f79dda0c7';

/**
 * Namespace for controller connection ids. Separate from the session namespace
 * so that an agent id and a session id that happened to be the same string
 * could not derive the same connection — a session would then be reopening its
 * own agent's controller connection, and the two would take it from each other
 * indefinitely.
 */
const CONTROLLER_CONNECTION_NAMESPACE = 'c3f2b0de-2e5a-5a1e-9d4a-1f7c2a6b8e05';

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

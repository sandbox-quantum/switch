/**
 * Which session is calling, for a server that can no longer tell.
 *
 * Several sessions of one agent may share a controller connection, and the
 * connection then holds the union of their rooms — so a room-scoped operation
 * arriving on it has no way to say whose room it meant. The session selector
 * says: this session, on this host, in this generation of it. All three or
 * none: the server refuses a partial selector outright.
 */

/** The header names the operations door reads the selector from. */
export const SESSION_SELECTOR_HEADERS = {
  sessionId: 'X-Switch-Session-Id',
  hostId: 'X-Switch-Session-Host-Id',
  epoch: 'X-Switch-Session-Epoch',
} as const;

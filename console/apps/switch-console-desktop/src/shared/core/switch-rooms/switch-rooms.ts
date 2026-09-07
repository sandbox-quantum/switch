/**
 * A live association between a Switch Console session and the Switch room its agent
 * is currently connected to. Runtime state: a session appears here only while
 * it has an active connection (reported by the Claude `connect_to_room` hook),
 * and is removed when it switches away or the session exits.
 */
export interface SessionRoomConnection {
  /** The Switch Console session id the connection belongs to. */
  sessionId: string;
  /** The session's PRIMARY room — the one the persisted map and the UI badge
   * show. `session_room_connections` keys on the session, so exactly one room
   * can be recorded there. */
  roomId: string;
  /**
   * EVERY room the session currently holds, primary included.
   *
   * A session can span several surfaces at once, and anything asking "is one
   * of my sessions already in this room?" has to consult all of them. Matching
   * on `roomId` alone makes a ping in a session's non-primary room look
   * unattended, and the auto-session watcher answers that by spawning a second
   * session — a separate context window competing for a room slot the first
   * already holds.
   *
   * Optional so a caller that genuinely knows one room need not synthesise a
   * list; readers should fall back to `[roomId]`.
   */
  rooms?: string[];
  /** The Switch agent id that connected (from the agent's SWITCH_AGENT_ID).
   * Null when a restored connection predates the identity being recorded — the
   * field is for display, so an unknown one is reported as unknown rather than
   * invented. */
  agentId: string | null;
}

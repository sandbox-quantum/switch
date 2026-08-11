/**
 * A live association between a Switch Console session and the Switch room its agent
 * is currently connected to. Runtime state: a session appears here only while
 * it has an active connection (reported by the Claude `connect_to_room` hook),
 * and is removed when it switches away or the session exits.
 */
export interface SessionRoomConnection {
  /** The Switch Console session id the connection belongs to. */
  sessionId: string;
  /** The Switch room the session is currently connected to. */
  roomId: string;
  /** The Switch agent id that connected (from the agent's SWITCH_AGENT_ID).
   * Null when a restored connection predates the identity being recorded — the
   * field is for display, so an unknown one is reported as unknown rather than
   * invented. */
  agentId: string | null;
}

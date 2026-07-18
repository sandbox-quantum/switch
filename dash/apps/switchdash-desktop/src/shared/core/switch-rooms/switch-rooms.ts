/**
 * A live association between a switchdash session and the Switch room its agent
 * is currently connected to. Runtime state: a session appears here only while
 * it has an active connection (reported by the Claude `connect_to_room` hook),
 * and is removed when it switches away or the session exits.
 */
export interface SessionRoomConnection {
  /** The switchdash session id the connection belongs to. */
  sessionId: string;
  /** The Switch room the session is currently connected to. */
  roomId: string;
  /** The Switch agent id that connected (from the agent's SWITCH_AGENT_ID). */
  agentId: string;
}

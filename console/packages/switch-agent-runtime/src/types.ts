/**
 * The wire shapes of the agent bridge's events.
 *
 * Protocol types, so they live with the protocol client rather than in any one
 * consumer. Formatting an event for a human, or for injection into a terminal,
 * is a consumer's business and stays there.
 */

/**
 * A pointer to a media attachment on a message event. Mirrors the agent
 * bridge's `AttachmentRef` (and the connector channel's) — metadata plus the
 * Matrix `mxc://` URI only; the bytes are fetched on demand via the
 * media-download endpoint.
 */
export interface AttachmentRef {
  filename: string;
  mimetype: string;
  size: number;
  mxc: string;
  msgtype: string;
}

export interface MessagePayload {
  addressed: boolean;
  sender: string;
  sender_name: string;
  /** "user", "agent", or "platform" (the Switch app itself). Absent from
   * servers that predate the field. */
  sender_kind?: string | null;
  /** For a platform message: the person whose authority it carries, such as
   * the creator behind a template's kickoff. */
  on_behalf_of?: string | null;
  message_id: string;
  body: string;
  timestamp: number;
  thread_id?: string | null;
  attachments?: AttachmentRef[];
  /** The words the chat opened with, posted in the agent's name as it joined; absent elsewhere. */
  opening_message?: string | null;
  /** The sending person's role in the workspace when the message arrived. */
  sender_role?: 'owner' | 'admin' | 'member' | null;
  /** True when nobody was tagged and Switch's decision service picked this agent to answer. */
  routed?: boolean;
}

export interface CommandPayload {
  command: string;
  // Command arguments. For `reset`/`compact` this carries the role name the
  // agent should re-assume after its context is cleared/compacted (empty when
  // it held none).
  args: string;
  user_id: string;
  user_name: string;
  // Thread root of the originating command message, so the completion notice
  // can be posted back into that same thread. null when not in a thread.
  thread_id?: string | null;
}

export interface RoomJoinPayload {
  member: string;
  member_name: string;
  timestamp: number;
  listening: boolean;
}

export interface AgentBridgeEvent {
  type: string;
  room_id: string;
  payload: MessagePayload | CommandPayload | RoomJoinPayload;
  /**
   * The event's number in the agent's own events (`s`). It is present on the push
   * transport and absent on the legacy poll. It is also absent on a message
   * from a room's conversation sent to a connection that reads the whole room
   * (`filter: 'all'`), because that message is numbered in the room's own
   * sequence, which `position` carries.
   *
   * Load-bearing when a watcher spawns a session: the session's connection has
   * to start from *before* the message that triggered the spawn, or the very
   * message the session was started to answer is behind it.
   */
  sequence?: number;
  /**
   * How far behind the agent is on unaddressed chatter in this event's room,
   * as of this event. Carried only on events the agent is woken for, and only
   * by a server that counts it — absent on the legacy poll and against an
   * older server.
   *
   * `count` is null when nothing can be said: a zero would be believed, and
   * `reason` is why. A reason alongside a number means the number is a floor.
   */
  missed?: { count: number | null; reason: string | null };
  /**
   * The event's place as a position with one entry: the source it came from
   * and its number there, for example `{s: 7}` for an event in the agent's
   * own events or `{'r:<room id>': 42}` for a message in a room's conversation. A
   * server that speaks agent-protocol 9 sends it.
   */
  position?: Record<string, number>;
}

export interface AgentBridgeEventResponse {
  events: AgentBridgeEvent[];
}

/** The credentials an agent uses to talk to its Switch instance. */
export interface SwitchCredentials {
  agentId: string;
  apiEndpoint: string;
  token: string;
}

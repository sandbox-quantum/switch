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
  message_id: string;
  body: string;
  timestamp: number;
  thread_id?: string | null;
  attachments?: AttachmentRef[];
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

export interface TaskPayload {
  task_id: string;
  requester_agent_id: string;
  performer_agent_id: string;
  summary?: string;
  description?: string;
  update?: string;
  outcome?: string | null;
  reason?: string | null;
}

export interface AgentBridgeEvent {
  type: string;
  room_id: string;
  payload: MessagePayload | CommandPayload | RoomJoinPayload | TaskPayload;
  /**
   * The event's position in the agent's buffer. Present on the push transport,
   * absent on the legacy poll.
   *
   * Load-bearing when a watcher spawns a session: the session's connection has
   * to start from *before* the message that triggered the spawn, or the very
   * message the session was started to answer is behind it.
   */
  sequence?: number;
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
